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
  ) {
    super(message);
  }
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
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok || r.status === 202) throw new ApiError(r.status, body.error ?? `engine said ${r.status}`);
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

/** Registers the paid job. The engine answers 202 until the payment is confirmed; keep asking. */
export async function createJob(req: JobRequest, onWait?: (msg: string) => void, timeoutMs = 120_000): Promise<JobView> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await call<JobView>('/api/jobs', { method: 'POST', body: JSON.stringify(req) });
    } catch (e) {
      const retry = e instanceof ApiError && (e.status === 202 || e.status === 0 || e.status >= 500);
      if (!retry || Date.now() > until) throw e;
      onWait?.((e as Error).message);
      await sleep(2500);
    }
  }
}

export function getJob(id: string): Promise<JobView> {
  return call<JobView>(`/api/jobs/${encodeURIComponent(id)}`);
}

export async function topupJob(id: string, quote: Quote, payTx: string, onWait?: (msg: string) => void): Promise<JobView> {
  const until = Date.now() + 120_000;
  for (;;) {
    try {
      return await call<JobView>(`/api/jobs/${encodeURIComponent(id)}/topup`, { method: 'POST', body: JSON.stringify({ quote, payTx }) });
    } catch (e) {
      const retry = e instanceof ApiError && (e.status === 202 || e.status === 0 || e.status === 503 || e.status >= 500);
      if (!retry || Date.now() > until) throw e;
      onWait?.((e as Error).message);
      await sleep(2500);
    }
  }
}

export async function recordToken(id: string, body: { mint?: string; tx?: string; failed?: boolean }): Promise<JobView> {
  // The launch tx can take a few seconds to show up on the API's RPC.
  for (let i = 0; ; i++) {
    try {
      return await call<JobView>(`/api/jobs/${encodeURIComponent(id)}/token`, { method: 'POST', body: JSON.stringify(body) });
    } catch (e) {
      if (i >= 5 || !(e instanceof ApiError) || (e.status !== 400 && e.status < 500)) throw e;
      await sleep(3000);
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
  try {
    const list = [j, ...myJobs().filter((x) => x.id !== j.id)].slice(0, 50);
    localStorage.setItem(MINE, JSON.stringify(list));
  } catch {
    /* private mode */
  }
}
