// The rea4u engine on Claude Managed Agents: one persistent agent (created lazily and kept in
// sync with engine/system.ts), one locked-down environment per job, one budget-capped session
// per job. The session budget is exactly what the user paid for.

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from '../../engine/system';
import { outcomeEvent, type TaskInput } from '../../engine/task';
import { hostRoot, TIERS, type Target, type Tier } from '../../shared/contract';
import type { Store } from './store';

export const AGENT_NAME = 'rea4u-engine';
export const MODEL_DEFAULT = 'claude-opus-5-5';

export interface SessionSnapshot {
  status: 'rescheduling' | 'running' | 'idle' | 'terminated';
  spentCents: number;
  outcome?: { result: string; explanation: string | null; iteration: number };
}

export interface EngineEvent {
  id: string;
  type: string;
  at: string;
  text?: string;
  stopReason?: string;
  eventIds?: string[];
  result?: string;
}

export interface OutputFile {
  id: string;
  filename: string;
  createdAt: string;
  sizeBytes: number;
}

/** The slice of the Managed Agents API rea4u uses. Mocked in tests. */
export interface EngineApi {
  findAgent(name: string): Promise<{ id: string; version: number; metadata: Record<string, string> } | null>;
  createAgent(cfg: AgentConfig): Promise<{ id: string; version: number }>;
  updateAgent(id: string, version: number, cfg: AgentConfig): Promise<{ id: string; version: number }>;
  createEnvironment(name: string, allowedHosts: string[]): Promise<string>;
  archiveEnvironment(id: string): Promise<void>;
  createSession(p: SessionParams): Promise<string>;
  /** The session created for a job (metadata.rea4u_job), looking at sessions created since `since`. */
  findSession(jobId: string, since: number): Promise<string | null>;
  retrieveSession(id: string): Promise<SessionSnapshot>;
  /** Newest first. */
  recentEvents(id: string, limit: number): Promise<EngineEvent[]>;
  denyTools(id: string, eventIds: string[]): Promise<void>;
  /** Sends a user.message so an idle session carries on. */
  resume(id: string, text: string): Promise<void>;
  setBudget(id: string, cents: number): Promise<void>;
  listOutputs(sessionId: string): Promise<OutputFile[]>;
  /** At most maxBytes of the file; the download stops there. */
  downloadText(fileId: string, maxBytes: number): Promise<string>;
}

export interface AgentConfig {
  name: string;
  model: { id: string; effort: 'high' };
  system: string;
  description: string;
  tools: Anthropic.Beta.Agents.AgentCreateParams['tools'];
  metadata: Record<string, string>;
}

export interface SessionParams {
  agentId: string;
  agentVersion: number;
  model: string;
  effort: 'medium' | 'high';
  environmentId: string;
  title: string;
  budgetCents: number;
  buildRepo: { url: string; branch: string; token: string };
  engineRepo: { url: string; branch: string };
  metadata: Record<string, string>;
  outcome: ReturnType<typeof outcomeEvent>;
}

export function agentConfig(model: string): Omit<AgentConfig, 'metadata'> {
  return {
    name: AGENT_NAME,
    model: { id: model, effort: 'high' },
    system: SYSTEM_PROMPT,
    description: 'rea4u: reverse engineers a target app or service into a rebranded clone + spec, using ECC playbooks.',
    tools: [
      {
        type: 'agent_toolset_20260401',
        // Unattended runs: nobody is there to answer approval prompts. The sandbox holds no
        // secrets (git auth is injected outside it) and egress is limited per job.
        default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
        configs: [{ name: 'web_search', enabled: false }],
      },
    ],
  };
}

async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

/** Returns the engine agent, creating or updating it when its config changed. */
export async function ensureAgent(api: EngineApi, store: Store, model: string): Promise<{ id: string; version: number }> {
  const base = agentConfig(model);
  const hash = await sha256(JSON.stringify(base));
  const cached = await store.getMeta('agent');
  if (cached) {
    const c = JSON.parse(cached) as { id: string; version: number; hash: string };
    if (c.hash === hash) return { id: c.id, version: c.version };
  }
  const cfg: AgentConfig = { ...base, metadata: { rea4u_config: hash } };
  const found = await api.findAgent(AGENT_NAME);
  let agent: { id: string; version: number };
  if (!found) agent = await api.createAgent(cfg);
  else if (found.metadata?.rea4u_config !== hash) agent = await api.updateAgent(found.id, found.version, cfg);
  else agent = { id: found.id, version: found.version };
  const ref = { id: agent.id, version: agent.version };
  await store.putMeta('agent', JSON.stringify({ ...ref, hash }));
  return ref;
}

/** Hosts a job's sandbox may reach: GitHub for git, plus the target site for web targets. */
export function allowedHosts(target: Target): string[] {
  const hosts = ['github.com', 'api.github.com', 'codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com'];
  if (target.kind === 'web') {
    const root = hostRoot(target.host);
    hosts.push(target.host, root, `*.${root}`);
  }
  return [...new Set(hosts)];
}

export interface StartArgs {
  api: EngineApi;
  store: Store;
  model: string;
  jobId: string;
  target: Target;
  tier: Tier;
  budgetCents: number;
  task: TaskInput;
  buildRepo: { url: string; branch: string; token: string };
  engineRepo: { url: string; branch: string };
  environmentId: string;
}

/** One environment per job, so egress can be limited to that job's target. */
export function createJobEnvironment(api: EngineApi, jobId: string, target: Target): Promise<string> {
  return api.createEnvironment(`rea4u-${jobId}`, allowedHosts(target));
}

/**
 * `beforeCreate` runs after the agent is ready and right before sessions.create (where the caller
 * saves its "session requested" marker and renews its lease), so a slow agent sync can't use up
 * the lease between the two.
 */
export async function startSession(a: StartArgs, beforeCreate?: () => Promise<void>): Promise<string> {
  const agent = await ensureAgent(a.api, a.store, a.model);
  await beforeCreate?.();
  return a.api.createSession({
    agentId: agent.id,
    agentVersion: agent.version,
    model: a.model,
    effort: TIERS[a.tier].effort,
    environmentId: a.environmentId,
    title: `rea4u ${a.jobId}: ${a.target.label}`.slice(0, 200),
    budgetCents: a.budgetCents,
    buildRepo: a.buildRepo,
    engineRepo: a.engineRepo,
    metadata: { rea4u_job: a.jobId, target: a.target.url.slice(0, 500) },
    outcome: outcomeEvent(a.task),
  });
}

const MANAGED_AGENTS_BETA = 'managed-agents-2026-04-01';
// Creates are never retried by the SDK: a retried POST that had already committed upstream would
// leave a second budgeted session or environment. The job's own backoff retries instead.
const CREATE_OPTS = { maxRetries: 0, timeout: 45_000 };
/** How many sessions findSession reads before giving up. */
const SESSION_SCAN_MAX = 500;

/** Reads at most maxBytes of a response body, then cancels the rest of the download. */
export async function readCapped(r: Response, maxBytes: number): Promise<string> {
  const reader = r.body?.getReader();
  if (!reader) return '';
  const out = new Uint8Array(maxBytes);
  let n = 0;
  while (n < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    const take = Math.min(chunk.byteLength, maxBytes - n);
    out.set(chunk.subarray(0, take), n);
    n += take;
  }
  if (n >= maxBytes) await reader.cancel().catch(() => undefined);
  return new TextDecoder().decode(out.subarray(0, n));
}

function eventText(e: { type: string; content?: unknown }): string | undefined {
  if (!Array.isArray(e.content)) return undefined;
  const t = e.content
    .filter((b: { type?: string; text?: string }) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: { text: string }) => b.text)
    .join('\n');
  return t || undefined;
}

/** Real implementation backed by the Anthropic SDK. */
export function anthropicEngine(client: Anthropic): EngineApi {
  const b = client.beta;
  return {
    async findAgent(name) {
      for await (const a of b.agents.list()) {
        if (a.name === name && !a.archived_at) return { id: a.id, version: a.version, metadata: a.metadata ?? {} };
      }
      return null;
    },
    async createAgent(cfg) {
      const a = await b.agents.create(cfg);
      return { id: a.id, version: a.version };
    },
    async updateAgent(id, version, cfg) {
      const a = await b.agents.update(id, { ...cfg, version });
      return { id: a.id, version: a.version };
    },
    async createEnvironment(name, hosts) {
      const env = await b.environments.create({
        name,
        config: {
          type: 'cloud',
          networking: { type: 'limited', allow_package_managers: true, allow_mcp_servers: false, allowed_hosts: hosts },
        },
      }, CREATE_OPTS);
      return env.id;
    },
    async archiveEnvironment(id) {
      await b.environments.archive(id);
    },
    async createSession(p) {
      const s = await b.sessions.create({
        agent: { type: 'agent_with_overrides', id: p.agentId, version: p.agentVersion, model: { id: p.model, effort: p.effort } },
        environment_id: p.environmentId,
        title: p.title,
        budget: { type: 'limit', max_list_cost: { amount: String(p.budgetCents), currency: 'USD' } },
        metadata: p.metadata,
        resources: [
          {
            type: 'github_repository',
            url: p.buildRepo.url,
            authorization_token: p.buildRepo.token,
            mount_path: '/workspace/build',
            checkout: { type: 'branch', name: p.buildRepo.branch },
          },
          // Public and mounted without a token, so the agent can read the skills and ECC
          // playbooks but can never push to the engine repo.
          { type: 'github_repository', url: p.engineRepo.url, mount_path: '/workspace/rea4u', checkout: { type: 'branch', name: p.engineRepo.branch } },
        ],
        initial_events: [p.outcome],
      }, CREATE_OPTS);
      return s.id;
    },
    async findSession(jobId, since) {
      let seen = 0;
      // Oldest first from just before the job existed, so its session comes up early.
      for await (const s of b.sessions.list({ 'created_at[gte]': new Date(since - 60_000).toISOString(), order: 'asc', limit: 100 })) {
        if (s.metadata?.rea4u_job === jobId) return s.id;
        if (++seen >= SESSION_SCAN_MAX) break;
      }
      return null;
    },
    async retrieveSession(id) {
      const s = await b.sessions.retrieve(id);
      const o = s.outcome_evaluations?.[s.outcome_evaluations.length - 1];
      return {
        status: s.status,
        spentCents: Number(s.usage?.list_cost?.amount ?? 0) || 0,
        outcome: o ? { result: o.result, explanation: o.explanation, iteration: o.iteration } : undefined,
      };
    },
    async recentEvents(id, limit) {
      const page = await b.sessions.events.list(id, {
        order: 'desc',
        limit,
        types: ['agent.message', 'span.outcome_evaluation_end', 'session.status_idle', 'session.error', 'session.status_terminated'],
      });
      return page.data.map((raw) => {
        const e = raw as unknown as Record<string, unknown> & { id: string; type: string; processed_at?: string };
        const stop = e.stop_reason as { type?: string; event_ids?: string[] } | undefined;
        const err = e.error as { message?: string } | undefined;
        return {
          id: e.id,
          type: e.type,
          at: e.processed_at ?? '',
          text: eventText(e as { type: string; content?: unknown }) ?? (typeof e.explanation === 'string' ? e.explanation : err?.message),
          stopReason: stop?.type,
          eventIds: stop?.event_ids,
          result: typeof e.result === 'string' ? e.result : undefined,
        };
      });
    },
    async denyTools(id, eventIds) {
      await b.sessions.events.send(id, {
        events: eventIds.map((tool_use_id) => ({
          type: 'user.tool_confirmation' as const,
          tool_use_id,
          result: 'deny' as const,
          deny_message: 'Unattended run: no approvals available. Continue without this call.',
        })),
      });
    },
    async resume(id, text) {
      await b.sessions.events.send(id, { events: [{ type: 'user.message', content: [{ type: 'text', text }] }] });
    },
    async setBudget(id, cents) {
      await b.sessions.update(id, { budget: { type: 'limit', max_list_cost: { amount: String(cents), currency: 'USD' } } });
    },
    async listOutputs(sessionId) {
      const out: OutputFile[] = [];
      for await (const f of b.files.list({ scope_id: sessionId, betas: [MANAGED_AGENTS_BETA] })) {
        out.push({ id: f.id, filename: f.filename, createdAt: f.created_at, sizeBytes: f.size_bytes });
      }
      return out;
    },
    async downloadText(fileId, maxBytes) {
      return readCapped(await b.files.download(fileId, { betas: [MANAGED_AGENTS_BETA] }), maxBytes);
    },
  };
}
