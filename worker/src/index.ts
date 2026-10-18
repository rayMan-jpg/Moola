// rea4u API worker. Routes:
//   GET  /api/config              chains, treasuries, tiers (the site checks this to know payments are live)
//   POST /api/quote               signed price quote for a job or a top-up
//   POST /api/jobs                verify payment, start the job
//   GET  /api/jobs/:id            job status (also advances the job)
//   POST /api/jobs/:id/topup      verify a top-up payment, raise the budget
//   POST /api/jobs/:id/token      record the launched token
// A cron sweep advances in-flight jobs nobody is watching.

import Anthropic from '@anthropic-ai/sdk';
import { TIERS, type ApiConfig, type ChainId, type JobRequest, type QuoteRequest } from '../../shared/contract';
import { anthropicEngine, type EngineApi } from './engine';
import type { Env } from './env';
import { advance, createJob, getJob, recordToken, siteUrl, topupJob, type Deps } from './jobs';
import { HttpError, makeQuote, treasuryFor } from './quote';
import { D1Store, type Store } from './store';

export interface Overrides {
  store?: Store;
  engine?: EngineApi;
  fetch?: typeof fetch;
}

function origins(env: Env): Set<string> {
  const list = [new URL(siteUrl(env)).origin, ...(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim())];
  return new Set(list.filter(Boolean));
}

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  if (!origins(env).has(origin)) return { vary: 'origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

// Per-isolate rate limit; Cloudflare's own WAF limits sit in front of this.
const hits = new Map<string, { n: number; reset: number }>();
/**
 * POST /api/jobs, /topup and /token are polled by the client (every ~2.5 s while a payment or launch
 * confirms, plus retries), so their limit sits well above that.
 */
const POLL_LIMIT_PER_MIN = 60;
function limited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) {
    hits.set(key, { n: 1, reset: now + windowMs });
    if (hits.size > 5000) hits.clear();
    return false;
  }
  h.n++;
  return h.n > max;
}

async function body<T>(req: Request): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > 32_000) throw new HttpError(413, 'request too big');
  const text = await req.text();
  if (text.length > 32_000) throw new HttpError(413, 'request too big');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, 'bad json');
  }
}

function configured(env: Env): string[] {
  const missing = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GITHUB_OWNER', 'QUOTE_SECRET'].filter((k) => !env[k as keyof Env]);
  if (!env.TREASURY_SOLANA && !env.TREASURY_EVM) missing.push('TREASURY_SOLANA or TREASURY_EVM');
  return missing;
}

export function deps(env: Env, o: Overrides = {}): Deps {
  const f = o.fetch ?? fetch.bind(globalThis);
  return {
    env,
    store: o.store ?? new D1Store(env.DB),
    engine: o.engine ?? anthropicEngine(new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, fetch: f, maxRetries: 2 })),
    fetch: f,
  };
}

export async function handle(req: Request, env: Env, o: Overrides = {}): Promise<Response> {
  const h = cors(req, env);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const ip = req.headers.get('cf-connecting-ip') ?? 'local';
  try {
    if (req.method === 'GET' && (path === '/api/config' || path === '')) {
      const missing = configured(env);
      const chains = (['solana', 'robinhood'] as ChainId[]).filter((c) => treasuryFor(env, c) && (c === 'solana' || (env.RH_RPC && env.RH_CHAIN_ID)));
      const cfg: ApiConfig = {
        ok: missing.length === 0,
        treasury: Object.fromEntries(chains.map((c) => [c, treasuryFor(env, c)!])),
        chains,
        tiers: Object.values(TIERS),
        ...(env.RH_CHAIN_ID ? { evmChainId: Number(env.RH_CHAIN_ID) } : {}),
      };
      return json(missing.length ? { ...cfg, missing } : cfg, 200, h);
    }

    const missing = configured(env);
    if (missing.length) throw new HttpError(503, 'rea4u engine is not switched on yet');
    const d = deps(env, o);

    if (req.method === 'POST' && path === '/api/quote') {
      if (limited(`q:${ip}`, 30, 60_000)) throw new HttpError(429, 'slow down');
      const r = await makeQuote(await body<QuoteRequest>(req), env, {
        fetch: d.fetch,
        jobTarget: async (id) => {
          const j = await d.store.getJob(id);
          return j ? { target: j.quote.target, chain: j.quote.chain, tier: j.quote.tier } : null;
        },
      });
      return json(r, 200, h);
    }
    if (req.method === 'POST' && path === '/api/jobs') {
      if (limited(`j:${ip}`, POLL_LIMIT_PER_MIN, 60_000)) throw new HttpError(429, 'slow down');
      return json(await createJob(await body<JobRequest>(req), d), 200, h);
    }
    const m = path.match(/^\/api\/jobs\/(q_[a-z2-7]{16})(\/topup|\/token)?$/);
    if (m) {
      const [, id, sub] = m;
      if (req.method === 'GET' && !sub) {
        if (limited(`g:${ip}`, 120, 60_000)) throw new HttpError(429, 'slow down');
        return json(await getJob(id, d), 200, h);
      }
      if (req.method === 'POST' && sub === '/topup') {
        if (limited(`t:${ip}`, POLL_LIMIT_PER_MIN, 60_000)) throw new HttpError(429, 'slow down');
        return json(await topupJob(id, await body(req), d), 200, h);
      }
      if (req.method === 'POST' && sub === '/token') {
        if (limited(`k:${ip}`, POLL_LIMIT_PER_MIN, 60_000)) throw new HttpError(429, 'slow down');
        return json(await recordToken(id, await body(req), d), 200, h);
      }
    }
    throw new HttpError(404, 'not found');
  } catch (e) {
    if (e instanceof HttpError) return json(e.code ? { error: e.message, code: e.code } : { error: e.message }, e.status, h);
    console.error('rea4u api error', e);
    return json({ error: 'something broke on our side, try again' }, 500, h);
  }
}

export async function sweep(env: Env, o: Overrides = {}): Promise<number> {
  if (configured(env).length) return 0;
  const d = deps(env, o);
  // Free plan: 50 subrequests per invocation; each job sync costs 2-5.
  const ids = await d.store.activeJobIds(8, (d.now ?? Date.now)());
  for (const id of ids) {
    const job = await d.store.getJob(id);
    if (job) await advance(job, d).catch((e) => console.error('sweep', id, e));
  }
  return ids.length;
}

export default {
  fetch: (req: Request, env: Env) => handle(req, env),
  scheduled: (_c: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(sweep(env)),
} satisfies ExportedHandler<Env>;
