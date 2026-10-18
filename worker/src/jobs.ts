// Job lifecycle: paid -> starting (repo + session) -> running <-> paused (budget) -> done | failed | refused.
// Every transition is driven by an API call (job POST or status GET) under a short D1 lease,
// so concurrent pollers can't double-create repos or sessions.

import {
  brandClash,
  JOB_ID_RE,
  PAD_CHAIN,
  QUOTE_ID_RE,
  slugify,
  validateProjectName,
  type FeedItem,
  type HostingNeeds,
  type JobRequest,
  type JobView,
  type Manifest,
  type PadId,
  type Quote,
} from '../../shared/contract';
import { createJobEnvironment, startSession, type EngineApi, type EngineEvent } from './engine';
import type { Env } from './env';
import { enablePages, ensureRepo, readRepoFile } from './github';
import { rpcList, SOLANA_RPC_DEFAULT, verifyEvmPayment, verifySolanaPayment, type PayCheck } from './pay';
import { HttpError, verifyQuote } from './quote';
import type { JobRecord, Store } from './store';

export interface Deps {
  env: Env;
  store: Store;
  engine: EngineApi;
  fetch: typeof fetch;
  now?: () => number;
}

const MAX_START_ATTEMPTS = 5;
const SYNC_EVERY_MS = 8_000;
const LEASE_MS = 60_000;
const FEED_MAX = 25;
const SPEC_MAX = 200_000;

const PADS: PadId[] = ['pump', 'jup', 'bonk', 'pons', 'stonk'];
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} .'!&$-]{1,31}$/u;
const TICKER_RE = /^[A-Z0-9]{2,10}$/;

export function siteUrl(env: Env): string {
  return (env.SITE_URL ?? 'https://rayman-jpg.github.io/Moola/').replace(/\/?$/, '/');
}

export function projectPage(env: Env, id: string): string {
  return `${siteUrl(env)}#/p/${id}`;
}

function checkNeeds(n: HostingNeeds): HostingNeeds {
  const budget = (['free', 'cheap', 'any'] as const).find((b) => b === n?.budget) ?? 'free';
  const traffic = (['hobby', 'real', 'serious'] as const).find((t) => t === n?.traffic) ?? 'hobby';
  return { budget, traffic, customDomain: n?.customDomain === true };
}

export async function checkPayment(env: Env, q: Quote, tx: string, f: typeof fetch): Promise<PayCheck> {
  if (q.chain === 'solana') return verifySolanaPayment(tx, q, rpcList(env.SOLANA_RPC, SOLANA_RPC_DEFAULT), f);
  const rpcs = rpcList(env.RH_RPC, []);
  if (!rpcs.length) throw new HttpError(503, 'robinhood chain RPC not configured');
  return verifyEvmPayment(tx, q, rpcs, f);
}

function payKey(q: Quote, tx: string) {
  return `${q.chain}:${q.chain === 'solana' ? tx : tx.toLowerCase()}`;
}

/** POST /api/jobs: verify the quote + payment, record the job, kick off the engine. */
export async function createJob(req: JobRequest, d: Deps): Promise<JobView> {
  const { env, store } = d;
  const q = req?.quote;
  if (!q || !QUOTE_ID_RE.test(String(q.id)) || q.topup) throw new HttpError(400, 'bad quote');
  if (!(await verifyQuote(q, env.QUOTE_SECRET))) throw new HttpError(400, 'that quote was tampered with');

  const existing = await store.getJob(q.id);
  if (existing) {
    if (existing.payTx !== req.payTx) throw new HttpError(409, 'that quote was already used');
    return advance(existing, d);
  }

  const projectName = String(req.project?.name ?? '').trim();
  const nameErr = validateProjectName(projectName);
  if (nameErr) throw new HttpError(400, nameErr);
  const token = req.token ?? ({} as JobRequest['token']);
  const tokenName = String(token.name ?? '').trim();
  const ticker = String(token.ticker ?? '').trim().toUpperCase();
  if (!NAME_RE.test(tokenName)) throw new HttpError(400, 'token name: 2-32 characters');
  if (!TICKER_RE.test(ticker)) throw new HttpError(400, 'ticker: 2-10 letters or numbers');
  if (!PADS.includes(token.pad)) throw new HttpError(400, 'pick a launchpad');
  if (PAD_CHAIN[token.pad] !== q.chain) throw new HttpError(400, `${token.pad} launches are paid on ${PAD_CHAIN[token.pad]}`);
  const clash = brandClash(q.target, tokenName, ticker) ?? brandClash(q.target, projectName, '');
  if (clash) throw new HttpError(400, clash);

  const tx = String(req.payTx ?? '').trim();
  const check = await checkPayment(env, q, tx, d.fetch);
  if (!check.ok) throw new HttpError(check.pending ? 202 : 402, check.reason);

  const key = payKey(q, tx);
  const owner = await store.claimPayment(key, q.id);
  if (owner !== q.id) throw new HttpError(409, 'that payment was already used for another job');

  const now = (d.now ?? Date.now)();
  const job: JobRecord = {
    id: q.id,
    createdAt: now,
    status: 'starting',
    quote: q,
    payTx: tx,
    payer: check.payer,
    project: { name: projectName },
    token: { name: tokenName, ticker, pad: token.pad, status: 'pending' },
    needs: checkNeeds(req.needs),
    budgetCents: q.usdCents,
    spentCents: 0,
    feed: [{ at: new Date(now).toISOString(), text: `payment confirmed. budget ${(q.usdCents / 100).toFixed(2)} USD` }],
    attempts: 0,
    payments: [key],
  };
  if (!(await store.insertJob(job))) {
    // Lost a race with ourselves (same quote, same tx): return whichever got in.
    const again = await store.getJob(q.id);
    if (!again) throw new HttpError(500, 'job vanished');
    return advance(again, d);
  }
  return advance(job, d);
}

/** GET /api/jobs/:id */
export async function getJob(id: string, d: Deps): Promise<JobView> {
  if (!JOB_ID_RE.test(id)) throw new HttpError(400, 'bad job id');
  const job = await d.store.getJob(id);
  if (!job) throw new HttpError(404, 'no such job');
  return advance(job, d);
}

/** Moves the job forward if it needs it and nobody else is already doing so. */
export async function advance(job: JobRecord, d: Deps): Promise<JobView> {
  const now = (d.now ?? Date.now)();
  const needsWork =
    job.status === 'starting' || ((job.status === 'running' || job.status === 'paused') && now - (job.syncedAt ?? 0) >= SYNC_EVERY_MS);
  if (!needsWork) return view(job);
  if (!(await d.store.lease(job.id, LEASE_MS))) return view(job);
  try {
    const fresh = (await d.store.getJob(job.id)) ?? job;
    if (fresh.status === 'starting') await start(fresh, d);
    else if (fresh.status === 'running' || fresh.status === 'paused') await sync(fresh, d);
    await d.store.putJob(fresh);
    return view(fresh);
  } finally {
    await d.store.unlease(job.id);
  }
}

function push(job: JobRecord, text: string, at = new Date().toISOString()) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 280);
  if (!clean || job.feed.some((f) => f.text === clean && f.at === at)) return;
  job.feed.push({ at, text: clean });
  if (job.feed.length > FEED_MAX) job.feed.splice(0, job.feed.length - FEED_MAX);
}

async function start(job: JobRecord, d: Deps) {
  const { env } = d;
  job.attempts++;
  try {
    if (!job.repo) {
      const name = `${slugify(job.project.name)}-${job.id.slice(2, 8)}`;
      job.repo = await ensureRepo(
        env,
        d.fetch,
        name,
        `${job.project.name}: rea4u build of ${job.quote.target.label}`,
        projectPage(env, job.id),
      );
      push(job, `repo ready: ${job.repo.fullName}`);
    }
    // Persisted step by step (the job is saved even when a later step throws), so a retry
    // never creates a second repo, environment or session.
    job.environmentId ??= await createJobEnvironment(d.engine, job.id, job.quote.target);
    if (!job.sessionId) {
      job.sessionId = await startSession({
        api: d.engine,
        store: d.store,
        model: env.MODEL || 'claude-opus-5-5',
        jobId: job.id,
        target: job.quote.target,
        tier: job.quote.tier,
        budgetCents: job.budgetCents,
        task: {
          jobId: job.id,
          target: job.quote.target,
          tier: job.quote.tier,
          projectName: job.project.name,
          tokenName: job.token.name,
          tokenTicker: job.token.ticker,
        },
        buildRepo: { url: job.repo.url, branch: job.repo.branch, token: env.GITHUB_TOKEN },
        engineRepo: { url: env.ENGINE_REPO || 'https://github.com/rayman-jpg/Moola', branch: env.ENGINE_BRANCH || 'claude/moola-degen-launcher' },
        environmentId: job.environmentId,
      });
    }
    job.status = 'running';
    job.error = undefined;
    job.syncedAt = 0;
    push(job, 'engine started. recon first, then spec, then build');
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    job.error = `start attempt ${job.attempts} failed: ${msg.slice(0, 200)}`;
    if (job.attempts >= MAX_START_ATTEMPTS) {
      job.status = 'failed';
      push(job, 'could not start the engine. your payment is recorded; contact support with this job id');
    }
  }
}

function feedFrom(job: JobRecord, events: EngineEvent[]) {
  const known = new Set(job.feed.map((f) => f.at + f.text));
  for (const e of [...events].reverse()) {
    let text: string | undefined;
    if (e.type === 'agent.message' && e.text) text = e.text.split('\n').find((l) => l.trim()) ?? e.text;
    else if (e.type === 'span.outcome_evaluation_end') {
      const verdict: Record<string, string> = {
        satisfied: 'grader: PASSED',
        needs_revision: 'grader: needs another pass',
        max_iterations_reached: 'grader: out of review rounds, wrapping up',
        failed: 'grader: failed',
      };
      text = `${verdict[e.result ?? ''] ?? `grader: ${e.result}`}${e.text ? `. ${e.text}` : ''}`;
    } else if (e.type === 'session.error' && e.text) text = `engine hiccup: ${e.text}`;
    if (text && !known.has(e.at + text.replace(/\s+/g, ' ').trim().slice(0, 280))) push(job, text, e.at);
  }
}

async function sync(job: JobRecord, d: Deps) {
  const now = (d.now ?? Date.now)();
  job.syncedAt = now;
  if (!job.sessionId) return;
  const s = await d.engine.retrieveSession(job.sessionId);
  job.spentCents = Math.max(job.spentCents, s.spentCents);
  const events = await d.engine.recentEvents(job.sessionId, 30);
  feedFrom(job, events);

  if (s.status === 'running' || s.status === 'rescheduling') {
    job.status = 'running';
    return;
  }
  const idle = events.find((e) => e.type === 'session.status_idle');
  const stop = idle?.stopReason;
  if (s.status === 'idle' && stop === 'requires_action' && idle?.eventIds?.length) {
    await d.engine.denyTools(job.sessionId, idle.eventIds);
    job.status = 'running';
    return;
  }
  if (s.status === 'idle' && stop === 'budget_reached') {
    if (job.status !== 'paused') push(job, 'budget used up. top up to keep it going, or grab what is already pushed');
    job.status = 'paused';
    // the agent keeps rea4u.json/SPEC.md current, so show the partial result
    await collect(job, d);
    return;
  }
  const terminal = ['satisfied', 'max_iterations_reached', 'failed', 'interrupted'];
  const outcomeDone = s.outcome && terminal.includes(s.outcome.result);
  if (s.status === 'terminated' || (s.status === 'idle' && (outcomeDone || stop === 'end_turn' || stop === 'retries_exhausted' || stop === 'refusal'))) {
    await collect(job, d);
    if (job.manifest?.status === 'refused') {
      job.status = 'refused';
      push(job, `engine refused: ${job.manifest.refusal ?? 'target not allowed'}`);
    } else if (job.manifest) {
      job.status = 'done';
      push(job, job.manifest.status === 'complete' ? 'DONE. clone + spec are pushed' : 'done, partially. see the spec for gaps');
    } else if (stop === 'refusal') {
      job.status = 'refused';
      push(job, 'the model refused this target');
    } else {
      job.status = 'failed';
      push(job, 'engine stopped without a manifest. whatever got pushed is in the repo');
    }
    if (job.repo && job.manifest?.kind === 'static') {
      job.live = (await enablePages(d.env, d.fetch, job.repo.fullName).catch(() => null)) ?? undefined;
      if (job.live) push(job, `live on GitHub Pages: ${job.live}`);
    }
    if (job.environmentId) await d.engine.archiveEnvironment(job.environmentId).catch(() => undefined);
  }
}

export function parseManifest(text: string): Manifest | undefined {
  try {
    const m = JSON.parse(text) as Manifest;
    if (!m || typeof m !== 'object' || !['complete', 'partial', 'refused'].includes(m.status)) return undefined;
    const needs = (m.needs ?? {}) as Partial<Manifest['needs']>;
    return {
      status: m.status,
      refusal: typeof m.refusal === 'string' ? m.refusal.slice(0, 500) : undefined,
      project: String(m.project ?? '').slice(0, 64),
      summary: String(m.summary ?? '').slice(0, 2000),
      target: {
        url: String(m.target?.url ?? '').slice(0, 300),
        license: String(m.target?.license ?? 'unknown').slice(0, 40),
        approach: m.target?.approach === 'fork' ? 'fork' : 'clean-room',
      },
      stack: Array.isArray(m.stack) ? m.stack.map(String).slice(0, 20) : [],
      kind: m.kind === 'static' || m.kind === 'server' ? m.kind : 'fullstack',
      needs: {
        server: needs.server === true,
        database: (['none', 'sqlite', 'postgres', 'mysql', 'redis', 'mongo', 'other'] as const).find((x) => x === needs.database) ?? 'none',
        websockets: needs.websockets === true,
        cron: needs.cron === true,
        storage: needs.storage === true,
        env: Array.isArray(needs.env) ? needs.env.map(String).filter((s) => /^[A-Z][A-Z0-9_]{0,63}$/.test(s)).slice(0, 30) : [],
      },
      build: {
        install: typeof m.build?.install === 'string' ? m.build.install.slice(0, 200) : undefined,
        build: typeof m.build?.build === 'string' ? m.build.build.slice(0, 200) : undefined,
        start: typeof m.build?.start === 'string' ? m.build.start.slice(0, 200) : undefined,
        output: typeof m.build?.output === 'string' ? m.build.output.slice(0, 100) : undefined,
        port: Number.isInteger(m.build?.port) ? m.build.port : undefined,
      },
      features: Array.isArray(m.features)
        ? m.features.slice(0, 60).map((f) => ({
            name: String(f?.name ?? '').slice(0, 120),
            status: f?.status === 'done' || f?.status === 'partial' ? f.status : 'todo',
          }))
        : [],
      verified: {
        build: m.verified?.build === true,
        tests: typeof m.verified?.tests === 'string' ? m.verified.tests.slice(0, 120) : undefined,
        smoke: m.verified?.smoke === true,
      },
      deploy: {
        dockerfile: m.deploy?.dockerfile === true,
        files: Array.isArray(m.deploy?.files) ? m.deploy.files.map(String).slice(0, 20) : [],
      },
    };
  } catch {
    return undefined;
  }
}

/** Pulls rea4u.json + SPEC.md from session outputs, falling back to the repo. */
async function collect(job: JobRecord, d: Deps) {
  if (!job.sessionId) return;
  let manifestText: string | null = null;
  let spec: string | null = null;
  try {
    const files = await d.engine.listOutputs(job.sessionId);
    const latest = (name: string) =>
      files.filter((f) => f.filename === name || f.filename.endsWith(`/${name}`)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const m = latest('rea4u.json');
    const s = latest('SPEC.md');
    if (m) manifestText = await d.engine.downloadText(m.id, 100_000);
    if (s) spec = await d.engine.downloadText(s.id, SPEC_MAX);
  } catch {
    // fall through to the repo
  }
  if (job.repo) {
    manifestText ??= await readRepoFile(d.env, d.fetch, job.repo.fullName, 'rea4u.json').catch(() => null);
    spec ??= await readRepoFile(d.env, d.fetch, job.repo.fullName, 'SPEC.md').catch(() => null);
  }
  const manifest = manifestText ? parseManifest(manifestText) : undefined;
  if (manifest) job.manifest = manifest;
  if (spec) job.spec = spec.slice(0, SPEC_MAX);
}

/** POST /api/jobs/:id/topup: a paid top-up raises the session budget, which resumes it. */
export async function topupJob(id: string, body: { quote: Quote; payTx: string }, d: Deps): Promise<JobView> {
  const { env, store } = d;
  const q = body?.quote;
  if (!q || q.topup !== id || !(await verifyQuote(q, env.QUOTE_SECRET))) throw new HttpError(400, 'bad top-up quote');
  const job = await store.getJob(id);
  if (!job) throw new HttpError(404, 'no such job');
  if (job.status !== 'paused' && job.status !== 'running') throw new HttpError(409, `job is ${job.status}, nothing to top up`);
  const tx = String(body.payTx ?? '').trim();
  const key = payKey(q, tx);
  if (job.payments.includes(key)) return view(job);
  const check = await checkPayment(env, q, tx, d.fetch);
  if (!check.ok) throw new HttpError(check.pending ? 202 : 402, check.reason);
  if ((await store.claimPayment(key, id)) !== id) throw new HttpError(409, 'that payment was already used');
  if (!(await store.lease(id, LEASE_MS))) {
    await store.releasePayment(key, id);
    throw new HttpError(503, 'job is busy, try again in a few seconds');
  }
  try {
    const fresh = (await store.getJob(id))!;
    const s = await d.engine.retrieveSession(fresh.sessionId!);
    // The new cap must sit above what's already been spent (which can overshoot the old cap
    // by one model request), so add the top-up to whichever is higher.
    const base = Math.max(fresh.budgetCents, s.spentCents);
    fresh.budgetCents = base + q.usdCents;
    await d.engine.setBudget(fresh.sessionId!, fresh.budgetCents);
    fresh.payments.push(key);
    fresh.status = 'running';
    fresh.syncedAt = 0;
    push(fresh, `topped up ${(q.usdCents / 100).toFixed(2)} USD. back to work`);
    await store.putJob(fresh);
    return view(fresh);
  } catch (e) {
    await store.releasePayment(key, id);
    throw e;
  } finally {
    await store.unlease(id);
  }
}

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

/** POST /api/jobs/:id/token: records the launched token (shown on the project page). */
export async function recordToken(id: string, body: { mint?: string; tx?: string; url?: string; failed?: boolean }, d: Deps): Promise<JobView> {
  const job = await d.store.getJob(id);
  if (!job) throw new HttpError(404, 'no such job');
  if (job.token.status === 'live') return view(job);
  if (body?.failed) {
    job.token.status = 'failed';
  } else {
    const mint = String(body?.mint ?? '');
    const ok = job.quote.chain === 'solana' ? SOL_ADDR.test(mint) : EVM_ADDR.test(mint);
    if (!ok) throw new HttpError(400, 'bad token address');
    const proof = await tokenLaunchedBy(d, job, mint, String(body?.tx ?? ''));
    if (!proof) throw new HttpError(400, "couldn't confirm that launch on-chain yet");
    job.token = { ...job.token, status: 'live', mint, tx: String(body.tx), url: safeLaunchUrl(job.token.pad, mint) };
    push(job, `$${job.token.ticker} is live`);
  }
  await d.store.putJob(job);
  return view(job);
}

export function safeLaunchUrl(pad: PadId, mint: string): string {
  switch (pad) {
    case 'pump':
      return `https://pump.fun/coin/${mint}`;
    case 'jup':
      return `https://jup.ag/tokens/${mint}`;
    case 'bonk':
      return `https://bonk.fun/token/${mint}`;
    case 'pons':
      return `https://ponsfamily.com/launchpad/${mint.toLowerCase()}`;
    case 'stonk':
      return `https://stonk.broker/token/${mint}`;
  }
}

/** The launch tx must be confirmed, signed by the job's payer, and touch the mint. */
async function tokenLaunchedBy(d: Deps, job: JobRecord, mint: string, tx: string): Promise<boolean> {
  try {
    if (job.quote.chain === 'solana') {
      const rpcs = rpcList(d.env.SOLANA_RPC, SOLANA_RPC_DEFAULT);
      const r = await d.fetch(rpcs[0], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getTransaction',
          params: [tx, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
        }),
      });
      const j = (await r.json()) as {
        result?: { meta?: { err: unknown }; transaction?: { message?: { accountKeys?: { pubkey: string; signer: boolean }[] } } };
      };
      const keys = j.result?.transaction?.message?.accountKeys ?? [];
      return !j.result?.meta?.err && j.result?.meta !== undefined && keys.some((k) => k.pubkey === job.payer && k.signer) && keys.some((k) => k.pubkey === mint);
    }
    const rpcs = rpcList(d.env.RH_RPC, []);
    if (!rpcs.length) return false;
    const call = async (method: string, params: unknown[]) => {
      const r = await d.fetch(rpcs[0], {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return ((await r.json()) as { result?: unknown }).result;
    };
    const rc = (await call('eth_getTransactionReceipt', [tx])) as { status?: string; from?: string; logs?: { address?: string }[] } | null;
    if (!rc || rc.status !== '0x1' || rc.from?.toLowerCase() !== job.payer.toLowerCase()) return false;
    return (rc.logs ?? []).some((l) => l.address?.toLowerCase() === mint.toLowerCase());
  } catch {
    return false;
  }
}

export function view(job: JobRecord): JobView {
  return {
    id: job.id,
    createdAt: job.createdAt,
    status: job.status,
    target: job.quote.target,
    tier: job.quote.tier,
    project: job.project,
    token: job.token,
    needs: job.needs,
    chain: job.quote.chain,
    payer: job.payer,
    budgetCents: job.budgetCents,
    spentCents: job.spentCents,
    repo: job.repo,
    feed: job.feed as FeedItem[],
    manifest: job.manifest,
    spec: job.spec,
    live: job.live,
    error: job.status === 'failed' ? job.error : undefined,
  };
}
