// Client for the rea4u API worker. The API base URL and the treasury addresses come from
// ./config.json, served from this site (written at deploy time), so a compromised or spoofed
// API can never redirect payments: quotes naming any other treasury are refused here.

import type { ApiConfig, ChainId, JobRequest, JobView, Quote, QuoteRequest } from '../shared/contract';

export interface SiteConfig {
  api: string;
  treasury: Partial<Record<ChainId, string>>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable reason, e.g. 'needs_claim'. */
    public code?: string,
  ) {
    super(message);
  }
}

/** The payment lost its rea4u tag: the paying wallet has to sign claimMessage(quote.id, tx). */
export function needsClaim(e: unknown): boolean {
  return e instanceof ApiError && e.status === 428 && e.code === 'needs_claim';
}

/** The engine refused for good (bad quote, wrong payment, late payment...): retrying won't help. */
export function refused(e: unknown): e is ApiError {
  return e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 428 && e.status !== 429;
}

let cached: Promise<SiteConfig | null> | null = null;

function devOverride(): string | null {
  const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  const api = new URLSearchParams(location.search).get('api');
  return local && api && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(api) ? api : null;
}

export function siteConfig(): Promise<SiteConfig | null> {
  cached ??= (async () => {
    try {
      const r = await fetch('./config.json', { cache: 'no-store' });
      if (!r.ok) return null;
      const c = (await r.json()) as SiteConfig;
      const api = devOverride() ?? c.api;
      if (!api || !/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)/.test(api)) return null;
      return { api: api.replace(/\/+$/, ''), treasury: c.treasury ?? {} };
    } catch {
      return null;
    }
  })();
  return cached;
}

/** For tests. */
export function resetSiteConfig() {
  cached = null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const cfg = await siteConfig();
  if (!cfg) throw new ApiError(503, 'the rea4u engine is not connected yet');
  let r: Response;
  try {
    r = await fetch(`${cfg.api}${path}`, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new ApiError(0, "can't reach the rea4u engine. check your connection and try again");
  }
  const body = (await r.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!r.ok || r.status === 202) throw new ApiError(r.status, body.error ?? `engine said ${r.status}`, body.code);
  return body;
}

export async function engineStatus(): Promise<ApiConfig | null> {
  try {
    return await call<ApiConfig>('/api/config');
  } catch {
    return null;
  }
}

export async function getQuote(req: QuoteRequest): Promise<{ quote: Quote; note?: string }> {
  const r = await call<{ quote: Quote; note?: string }>('/api/quote', { method: 'POST', body: JSON.stringify(req) });
  await checkQuote(r.quote, req.chain);
  return r;
}

/** Refuses quotes that would send money anywhere but the treasury pinned in this site's config. */
export async function checkQuote(q: Quote, chain: ChainId) {
  const cfg = await siteConfig();
  const pinned = cfg?.treasury[chain];
  if (!pinned) throw new ApiError(503, `${chain} payments aren't set up on this site`);
  const same = chain === 'solana' ? q.treasury === pinned : q.treasury.toLowerCase() === pinned.toLowerCase();
  if (!same || q.chain !== chain) throw new ApiError(400, 'the engine returned a quote for an unknown treasury. nothing was paid. refresh and try again');
  if (!/^\d+$/.test(q.amount) || BigInt(q.amount) <= 0n) throw new ApiError(400, 'bad quote amount');
  if (q.expiresAt < Date.now()) throw new ApiError(400, 'that quote expired, try again');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps POSTing while the engine says "not yet" (202), is unreachable, overloaded (5xx) or
 * rate limiting (429, with backoff). Anything else, including 428 needs_claim, goes to the caller.
 */
async function untilAccepted<T>(send: () => Promise<T>, onWait: ((msg: string) => void) | undefined, timeoutMs: number): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (let limitedFor = 0; ; ) {
    try {
      return await send();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : -1;
      const retry = status === 202 || status === 0 || status === 429 || status >= 500;
      if (!retry || Date.now() > until) throw e;
      onWait?.(status === 429 ? 'the engine is busy, retrying...' : (e as Error).message);
      limitedFor = status === 429 ? limitedFor + 1 : 0;
      await sleep(limitedFor ? Math.min(20_000, 2500 * 2 ** limitedFor) : 2500);
    }
  }
}

/** Registers the paid job. The engine answers 202 until the payment is confirmed; keep asking. */
export function createJob(req: JobRequest, onWait?: (msg: string) => void, timeoutMs = 120_000): Promise<JobView> {
  return untilAccepted(() => call<JobView>('/api/jobs', { method: 'POST', body: JSON.stringify(req) }), onWait, timeoutMs);
}

export function getJob(id: string): Promise<JobView> {
  return call<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
}

export interface TopupRequest {
  quote: Quote;
  payTx: string;
  /** Same as JobRequest.claimSig, for a top-up payment that lost its tag. */
  claimSig?: string;
}

export function topupJob(id: string, req: TopupRequest, onWait?: (msg: string) => void, timeoutMs = 120_000): Promise<JobView> {
  const body = JSON.stringify({ quote: req.quote, payTx: req.payTx, ...(req.claimSig ? { claimSig: req.claimSig } : {}) });
  return untilAccepted(() => call<JobView>(`/api/jobs/${encodeURIComponent(id)}/topup`, { method: 'POST', body }), onWait, timeoutMs);
}

export interface TokenProof {
  mint: string;
  tx: string;
  url?: string;
  armTx?: string;
}

export async function recordToken(id: string, proof: TokenProof, tries = 6): Promise<JobView> {
  // The launch tx can take a few seconds to show up on the API's RPC (400 until then).
  for (let i = 1; ; i++) {
    try {
      return await call<JobView>(`/api/jobs/${encodeURIComponent(id)}/token`, { method: 'POST', body: JSON.stringify(proof) });
    } catch (e) {
      const s = e instanceof ApiError ? e.status : -1;
      if (i >= tries || !(s === 0 || s === 400 || s === 429 || s >= 500)) throw e;
      await sleep(s === 429 ? 6000 : 3000);
    }
  }
}

// ── jobs this browser started ("my reas") ──
const MINE = 'rea4u.jobs';

export interface MyJob {
  id: string;
  project: string;
  target: string;
  at: number;
}

export function myJobs(): MyJob[] {
  try {
    const v = JSON.parse(localStorage.getItem(MINE) ?? '[]') as MyJob[];
    return Array.isArray(v) ? v.filter((j) => typeof j?.id === 'string') : [];
  } catch {
    return [];
  }
}

export function rememberJob(j: MyJob) {
  saveMine([j, ...myJobs().filter((x) => x.id !== j.id)].slice(0, 50));
}

/** For a payment that provably never happened. */
export function forgetJob(id: string) {
  saveMine(myJobs().filter((x) => x.id !== id));
}

function saveMine(list: MyJob[]) {
  try {
    localStorage.setItem(MINE, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}
