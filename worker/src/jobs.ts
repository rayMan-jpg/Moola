// Job lifecycle: paid -> starting (repo + session) -> running <-> paused (budget) -> done | failed | refused.
// Every transition is driven by an API call (job POST or status GET) or the cron sweep, under a
// short D1 lease. Writes are compare-and-set on the lease token, so a worker whose lease ran out
// can't overwrite the one that took over.

import {
  JOB_ID_RE,
  PAD_CHAIN,
  QUOTE_ID_RE,
  slugify,
  validateOrderNames,
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
import { stonkArmed, tokenLaunchedBy } from './launch';
import { rpcList, SOLANA_RPC_DEFAULT, verifyEvmPayment, verifySolanaPayment, type PayCheck } from './pay';
import { HttpError, verifyQuote } from './quote';
import type { JobRecord, Store } from './store';

export interface Deps {
  env: Env;
  store: Store;
  engine: EngineApi;
  fetch: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Waits between engine start attempts; the last one repeats. */
const START_BACKOFF_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000];
/** A paid job keeps retrying its start this long before it is marked failed. */
const START_DEADLINE_MS = 60 * 60_000;
const SYNC_EVERY_MS = 8_000;
const LEASE_MS = 60_000;
/** Top-ups and token records try this many times, this far apart, to get the lease from a poller. */
const LEASE_WAIT_TRIES = 4;
const LEASE_WAIT_MS = 750;
/** retries_exhausted: user.message nudges before the session is treated as finished, and the wait after each. */
const MAX_RESUMES = 3;
const RESUME_BACKOFF_MS = [30_000, 2 * 60_000];
const RESUME_TEXT =
  'Transient upstream errors interrupted your last turn. Continue exactly where you stopped: check the repo state, then carry on with the task and keep rea4u.json and SPEC.md current.';
/** Syncs that may find a finished session without a manifest before it is finalized without one. */
const COLLECT_TRIES = 3;
const FEED_MAX = 25;
const MANIFEST_MAX = 100_000;
const SPEC_MAX = 200_000;

/** Thrown when a lease-guarded write finds the lease taken over; the work stops without writing. */
class LeaseLost extends Error {}

const sleepFor = (d: Deps) => d.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));

const PADS: PadId[] = ['pump', 'jup', 'bonk', 'pons', 'stonk', 'utoken'];

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

export async function checkPayment(env: Env, q: Quote, tx: string, f: typeof fetch, claimSig?: string): Promise<PayCheck> {
  const sig = typeof claimSig === 'string' && claimSig.length <= 300 ? claimSig.trim() : undefined;
  if (q.chain === 'solana') return verifySolanaPayment(tx, q, rpcList(env.SOLANA_RPC, SOLANA_RPC_DEFAULT), f, sig);
  const rpcs = rpcList(env.RH_RPC, []);
  if (!rpcs.length) throw new HttpError(503, 'robinhood chain RPC not configured');
  return verifyEvmPayment(tx, q, rpcs, f, sig);
}

/** 202 keep polling, 428 sign a claim for the untagged payment and retry, 402 refused. */
function payFailure(c: Exclude<PayCheck, { ok: true }>): HttpError {
  if (c.pending) return new HttpError(202, c.reason);
  return c.needsClaim ? new HttpError(428, c.reason, 'needs_claim') : new HttpError(402, c.reason);
}

/** What a payment buys in session budget: the amount minus a reserve for the cap's overshoot. */
export function sessionBudget(env: Env, usdCents: number): number {
  const pct = Math.min(50, Math.max(0, Number(env.RESERVE_PCT ?? 6) || 0));
  const reserve = Math.max(50, Math.round((usdCents * pct) / 100));
  return Math.max(100, usdCents - reserve);
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

  const tx = String(req.payTx ?? '').trim();
  const existing = await store.getJob(q.id);
  if (existing) {
    if (existing.payTx !== tx) throw new HttpError(409, 'that quote was already used');
    return advance(existing, d);
  }

  const projectName = String(req.project?.name ?? '').trim();
  const token = req.token ?? ({} as JobRequest['token']);
  const tokenName = String(token.name ?? '').trim();
  const ticker = String(token.ticker ?? '').trim().toUpperCase();
  // The same checks the site runs before anything is paid (shared/contract.ts).
  const nameErr = validateOrderNames(q.target, projectName, tokenName, ticker);
  if (nameErr) throw new HttpError(400, nameErr.msg);
  if (!PADS.includes(token.pad)) throw new HttpError(400, 'pick a launchpad');
  if (PAD_CHAIN[token.pad] !== q.chain) throw new HttpError(400, `${token.pad} launches are paid on ${PAD_CHAIN[token.pad]}`);

  const check = await checkPayment(env, q, tx, d.fetch, req.claimSig);
  if (!check.ok) throw payFailure(check);

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
    budgetCents: sessionBudget(env, q.usdCents),
    spentCents: 0,
    feed: [{ at: new Date(now).toISOString(), text: `payment confirmed. engine budget ${(sessionBudget(env, q.usdCents) / 100).toFixed(2)} USD` }],
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

function needsWork(job: JobRecord, now: number): boolean {
  if (job.status === 'starting') return now >= (job.nextAttemptAt ?? 0);
  return (job.status === 'running' || job.status === 'paused') && now - (job.syncedAt ?? 0) >= SYNC_EVERY_MS;
}

/** Moves the job forward if it needs it and nobody else is already doing so. */
export async function advance(job: JobRecord, d: Deps): Promise<JobView> {
  const now = (d.now ?? Date.now)();
  if (!needsWork(job, now)) return view(job);
  const token = await d.store.lease(job.id, LEASE_MS);
  if (!token) return view(job);
  try {
    const fresh = (await d.store.getJob(job.id)) ?? job;
    if (!needsWork(fresh, now)) return view(fresh);
    const save = async (renew = false) => {
      if (!(await d.store.putJob(fresh, token))) throw new LeaseLost();
      if (renew && !(await d.store.renew(fresh.id, token, LEASE_MS))) throw new LeaseLost();
    };
    if (fresh.status === 'starting') await start(fresh, d, save);
    else await sync(fresh, d);
    await save();
    return view(fresh);
  } catch (e) {
    if (e instanceof LeaseLost) return view((await d.store.getJob(job.id)) ?? job);
    throw e;
  } finally {
    await d.store.unlease(job.id, token);
  }
}

/** Runs fn on a fresh read of the job under its lease, waiting briefly while a poller holds it. */
async function withLease<T>(id: string, d: Deps, fn: (job: JobRecord, token: string) => Promise<T>): Promise<T> {
  let token: string | null = null;
  for (let i = 0; i < LEASE_WAIT_TRIES && !token; i++) {
    if (i) await sleepFor(d)(LEASE_WAIT_MS);
    token = await d.store.lease(id, LEASE_MS);
  }
  if (!token) throw new HttpError(503, 'job is busy, try again in a few seconds');
  try {
    const job = await d.store.getJob(id);
    if (!job) throw new HttpError(404, 'no such job');
    return await fn(job, token);
  } finally {
    await d.store.unlease(id, token);
  }
}

function push(job: JobRecord, text: string, at = new Date().toISOString()) {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 280);
  if (!clean || job.feed.some((f) => f.text === clean && f.at === at)) return;
  job.feed.push({ at, text: clean });
  if (job.feed.length > FEED_MAX) job.feed.splice(0, job.feed.length - FEED_MAX);
}

function startBackoff(attempts: number): number {
  return START_BACKOFF_MS[Math.min(attempts, START_BACKOFF_MS.length) - 1];
}

/**
 * Creates the repo, environment and session, saving after each one, so a retry (or a worker that
 * takes over an expired lease) reuses what exists instead of paying for a second session.
 */
async function start(job: JobRecord, d: Deps, save: (renew?: boolean) => Promise<void>) {
  const { env } = d;
  const now = (d.now ?? Date.now)();
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
      await save();
    }
    if (!job.environmentId) {
      job.environmentId = await createJobEnvironment(d.engine, job.id, job.quote.target);
      await save();
    }
    // An earlier attempt may have created the session upstream and died (or seen an error) before
    // saving its id.
    if (!job.sessionId && job.sessionRequestedAt) job.sessionId = (await d.engine.findSession(job.id, job.createdAt)) ?? undefined;
    if (!job.sessionId) {
      job.sessionId = await startSession(
        {
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
        },
        // After the agent sync, immediately before the create: the marker goes in and the lease
        // gets a full term for the create itself.
        async () => {
          job.sessionRequestedAt = (d.now ?? Date.now)();
          await save(true);
        },
      );
    }
    job.status = 'running';
    job.error = undefined;
    job.nextAttemptAt = undefined;
    job.syncedAt = 0;
    push(job, 'engine started. recon first, then spec, then build');
  } catch (e) {
    if (e instanceof LeaseLost) throw e;
    const msg = (e as Error).message ?? String(e);
    job.error = `start attempt ${job.attempts} failed: ${msg.slice(0, 200)}`;
    if (now - job.createdAt >= START_DEADLINE_MS) {
      job.status = 'failed';
      push(job, 'could not start the engine. your payment is recorded; contact support with this job id');
    } else {
      job.nextAttemptAt = now + startBackoff(job.attempts);
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
  const outcomeDone = !!s.outcome && terminal.includes(s.outcome.result);
  // Overloaded upstream: the turn failed but the session still takes messages and has budget left.
  if (s.status === 'idle' && stop === 'retries_exhausted' && !outcomeDone && s.spentCents < job.budgetCents && (job.resumes ?? 0) < MAX_RESUMES) {
    job.status = 'running';
    if (now >= (job.resumeAfter ?? 0)) {
      // Counted before sending, so a session that refuses the message still reaches the cap.
      job.resumes = (job.resumes ?? 0) + 1;
      const n = job.resumes;
      job.resumeAfter = now + RESUME_BACKOFF_MS[Math.min(n, RESUME_BACKOFF_MS.length) - 1];
      await d.engine.resume(job.sessionId, RESUME_TEXT).then(
        () => push(job, `engine hit upstream errors. nudged it to carry on (${n}/${MAX_RESUMES})`),
        () => push(job, `engine hit upstream errors and didn't take a nudge (${n}/${MAX_RESUMES})`),
      );
    }
    return;
  }
  if (s.status === 'terminated' || (s.status === 'idle' && (outcomeDone || stop === 'end_turn' || stop === 'retries_exhausted' || stop === 'refusal'))) {
    await collect(job, d);
    // Outputs show up a few seconds after the idle event: look again on the next syncs first.
    if (!job.manifest) {
      job.collectTries = (job.collectTries ?? 0) + 1;
      if (job.collectTries < COLLECT_TRIES) {
        job.status = 'running';
        return;
      }
    }
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
    // Oversized outputs are skipped (an agent, or content it read, can write anything there).
    const latest = (name: string, max: number) =>
      files
        .filter((f) => (f.filename === name || f.filename.endsWith(`/${name}`)) && !(f.sizeBytes > max))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const m = latest('rea4u.json', MANIFEST_MAX);
    const s = latest('SPEC.md', SPEC_MAX);
    if (m) manifestText = await d.engine.downloadText(m.id, MANIFEST_MAX);
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
export async function topupJob(id: string, body: { quote: Quote; payTx: string; claimSig?: string }, d: Deps): Promise<JobView> {
  const { env, store } = d;
  const q = body?.quote;
  if (!q || q.topup !== id || !(await verifyQuote(q, env.QUOTE_SECRET))) throw new HttpError(400, 'bad top-up quote');
  const job = await store.getJob(id);
  if (!job) throw new HttpError(404, 'no such job');
  const tx = String(body.payTx ?? '').trim();
  const key = payKey(q, tx);
  const owner = await store.payment(key);
  if (owner && owner.jobId !== id) throw new HttpError(409, 'that payment was already used');
  if (owner?.credited || key === payKey(job.quote, job.payTx)) return view(job);
  if (job.status !== 'paused' && job.status !== 'running') throw new HttpError(409, `job is ${job.status}, nothing to top up`);
  const check = await checkPayment(env, q, tx, d.fetch, body.claimSig);
  if (!check.ok) throw payFailure(check);
  // A verified top-up for this job stays bound to it, even while crediting it has to be retried.
  if ((await store.claimPayment(key, id)) !== id) throw new HttpError(409, 'that payment was already used');
  return withLease(id, d, async (fresh, token) => {
    // Decided under the lease from the credited marker, which is written together with the budget.
    if ((await store.payment(key))?.credited || fresh.payments.includes(key)) return view(fresh);
    if (fresh.status !== 'paused' && fresh.status !== 'running') throw new HttpError(409, `job is ${fresh.status}, nothing to top up`);
    // Another top-up stopped between raising the cap and saving it: finish it first, at its own target.
    const prior = fresh.crediting;
    if (prior && prior.paymentKey !== key) {
      if ((await store.payment(prior.paymentKey))?.credited) fresh.crediting = undefined;
      else await credit(fresh, token, prior, d);
    }
    let c = fresh.crediting;
    if (!c) {
      const s = await d.engine.retrieveSession(fresh.sessionId!);
      // The new cap must sit above what's already been spent (which can overshoot the old cap
      // by one model request), so add the top-up to whichever is higher.
      const base = Math.max(fresh.budgetCents, s.spentCents);
      c = { paymentKey: key, targetCents: base + sessionBudget(env, q.usdCents), usdCents: q.usdCents };
      // Saved before the cap moves: once it has, spend can grow past `base`, and recomputing the
      // target on a retry would credit that spend a second time.
      fresh.crediting = c;
      if (!(await store.putJob(fresh, token))) throw new HttpError(503, 'job is busy, try again in a few seconds');
    }
    await credit(fresh, token, c, d);
    return view(fresh);
  });
}

/** Raises the session cap to a saved top-up target and records that payment credited, under the lease. */
async function credit(job: JobRecord, token: string, c: NonNullable<JobRecord['crediting']>, d: Deps) {
  await d.engine.setBudget(job.sessionId!, c.targetCents);
  job.budgetCents = c.targetCents;
  if (!job.payments.includes(c.paymentKey)) job.payments.push(c.paymentKey);
  job.crediting = undefined;
  job.status = 'running';
  job.syncedAt = 0;
  push(job, `topped up ${(c.usdCents / 100).toFixed(2)} USD. back to work`);
  if (!(await d.store.putJob(job, token, c.paymentKey))) throw new HttpError(503, 'job is busy, try again in a few seconds');
}

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;

/**
 * POST /api/jobs/:id/token: records the launched token (shown on the project page). {failed: true}
 * is ignored: anyone can call this, and only a verified launch changes the record.
 */
export async function recordToken(id: string, body: { mint?: string; tx?: string; url?: string; armTx?: string; failed?: boolean }, d: Deps): Promise<JobView> {
  const job = await d.store.getJob(id);
  if (!job) throw new HttpError(404, 'no such job');
  if (job.token.status === 'live' || body?.failed === true) return view(job);
  const mint = String(body?.mint ?? '');
  const tx = String(body?.tx ?? '');
  const ok = job.quote.chain === 'solana' ? SOL_ADDR.test(mint) : EVM_ADDR.test(mint);
  if (!ok) throw new HttpError(400, 'bad token address');
  // Proven on what never changes (payer, chain, pad), so it can run before taking the lease.
  if (!(await tokenLaunchedBy(d.env, d.fetch, job, mint, tx))) throw new HttpError(400, "couldn't confirm that launch on-chain yet");
  // A StonkLauncher token only trades once its supply is armed: require that tx too.
  if (job.token.pad === 'stonk' && !(await stonkArmed(d.env, d.fetch, job, mint, tx, String(body?.armTx ?? '')))) throw new HttpError(400, "couldn't confirm the launch was armed yet");
  return withLease(id, d, async (fresh, token) => {
    if (fresh.token.status === 'live') return view(fresh);
    fresh.token = { ...fresh.token, status: 'live', mint, tx, url: safeLaunchUrl(fresh.token.pad, mint, body.url) };
    push(fresh, `$${fresh.token.ticker} is live`);
    if (!(await d.store.putJob(fresh, token))) throw new HttpError(503, 'job is busy, try again in a few seconds');
    return view(fresh);
  });
}

/** Coin page links are built here (or strictly pattern-checked), never taken from the client as-is. */
export function safeLaunchUrl(pad: PadId, mint: string, claimed?: string): string {
  switch (pad) {
    case 'pump':
      return `https://pump.fun/coin/${mint}`;
    case 'jup':
      return `https://jup.ag/tokens/${mint}`;
    case 'bonk':
      return `https://bonk.fun/token/${mint}`;
    case 'pons':
      return `https://ponsfamily.com/launchpad/${mint.toLowerCase()}`;
    case 'utoken':
      return `https://utoken.gg/token/${mint.toLowerCase()}`;
    case 'stonk':
      // StonkBrokers keys coin pages by launch id, which only the creation receipt knows.
      return claimed && /^https:\/\/stonkbrokers\.io\/safe-launch\/token\/weth2-[a-z0-9]{1,24}-\d{1,9}$/.test(claimed)
        ? claimed
        : `https://robinhoodchain.blockscout.com/token/${mint.toLowerCase()}`;
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
