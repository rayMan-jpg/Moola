// Quotes: what a job costs (the Claude budget in USD) converted to SOL or ETH at the current
// price, signed with HMAC so the client can carry it to the payment and back.

import { CHAIN_ASSET, TIERS, parseTarget, usdToAtomic, type ChainId, type Quote, type QuoteRequest, type Target } from '../../shared/contract';
import type { Env } from './env';
import { usdPrice } from './price';

export const QUOTE_TTL_MS = 10 * 60_000;
/** An untagged (claimed) payment may land this long after the quote expired (slow wallets, slow blocks). */
export const PAY_GRACE_MS = 3 * 60_000;
/**
 * A payment tagged with the quote's id may land this long after expiry: a wallet popup can sit open
 * for ages and EVM txs never expire. The HMAC'd id binds it and the payments table stops replays.
 */
export const TAGGED_GRACE_MS = 24 * 60 * 60_000;
export const TOPUP_MIN_CENTS = 200;
export const TOPUP_MAX_CENTS = 20_000;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    /** Machine-readable reason the client acts on, e.g. 'needs_claim'. */
    public code?: string,
  ) {
    super(message);
  }
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

export function newQuoteId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += B32[b & 31];
  return `q_${s}`;
}

function canonical(q: Omit<Quote, 'sig'>): string {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
              .map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(sortKeys(q));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function signQuote(q: Omit<Quote, 'sig'>, secret: string): Promise<Quote> {
  return { ...q, sig: await hmac(secret, canonical(q)) };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Checks the HMAC. Expiry is checked against the payment time by the caller. */
export async function verifyQuote(q: Quote, secret: string): Promise<boolean> {
  if (!q || typeof q !== 'object' || typeof q.sig !== 'string') return false;
  const { sig, ...rest } = q;
  return timingSafeEqual(sig, await hmac(secret, canonical(rest)));
}

export function treasuryFor(env: Env, chain: ChainId): string | undefined {
  return chain === 'solana' ? env.TREASURY_SOLANA : env.TREASURY_EVM;
}

export interface QuoteDeps {
  fetch: typeof fetch;
  price?: (sym: 'SOL' | 'ETH') => Promise<number>;
  /** Looks up an existing job's target when quoting a top-up. */
  jobTarget?: (id: string) => Promise<{ target: Target; chain: ChainId; tier: Quote['tier'] } | null>;
}

interface RepoInfo {
  private: boolean;
  archived: boolean;
  size: number;
  disabled?: boolean;
}

/** GitHub targets must exist and be public (the engine clones them without credentials). */
async function checkRepo(target: Target, env: Env, f: typeof fetch): Promise<RepoInfo> {
  const r = await f(`https://api.github.com/repos/${target.owner}/${target.repo}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'rea4u',
      ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    },
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 404) throw new HttpError(400, "can't find that repo. it has to be public");
  if (!r.ok) throw new HttpError(502, `GitHub said ${r.status}, try again`);
  const info = (await r.json()) as RepoInfo;
  if (info.private) throw new HttpError(400, 'that repo is private. rea4u only works on public stuff');
  if (info.disabled) throw new HttpError(400, 'that repo is disabled on GitHub');
  return info;
}

export async function makeQuote(req: QuoteRequest, env: Env, deps: QuoteDeps): Promise<{ quote: Quote; note?: string }> {
  if (!req || typeof req !== 'object') throw new HttpError(400, 'bad request');
  const chain = req.chain;
  if (chain !== 'solana' && chain !== 'robinhood') throw new HttpError(400, 'pick a chain');
  const treasury = treasuryFor(env, chain);
  if (!treasury) throw new HttpError(503, `${chain} payments aren't switched on yet`);
  const evmChainId = chain === 'robinhood' ? Number(env.RH_CHAIN_ID) || undefined : undefined;
  if (chain === 'robinhood' && !evmChainId) throw new HttpError(503, 'robinhood chain id not configured');

  let target: Target;
  let tier = req.tier;
  let usdCents: number;
  let note: string | undefined;

  if (req.topup) {
    const job = await deps.jobTarget?.(req.topup);
    if (!job) throw new HttpError(404, 'no such job');
    if (job.chain !== chain) throw new HttpError(400, `top up on ${job.chain}, where the job was paid`);
    target = job.target;
    tier = job.tier;
    usdCents = Math.round(Number(req.usdCents));
    if (!Number.isFinite(usdCents) || usdCents < TOPUP_MIN_CENTS || usdCents > TOPUP_MAX_CENTS) {
      throw new HttpError(400, `top up between $${TOPUP_MIN_CENTS / 100} and $${TOPUP_MAX_CENTS / 100}`);
    }
  } else {
    if (!(tier in TIERS)) throw new HttpError(400, 'pick a tier');
    try {
      target = parseTarget(String(req.target ?? ''));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (target.kind === 'github') {
      const info = await checkRepo(target, env, deps.fetch);
      if (info.archived) note = 'heads up: that repo is archived';
      if (info.size > 200_000 && tier === 'lite') note = 'big repo. lite will mostly be spec; standard or deep gets you more clone';
    }
    usdCents = TIERS[tier].usdCents;
  }

  const margin = Math.max(0, Number(env.MARGIN_PCT ?? 0) || 0);
  const chargeCents = Math.ceil(usdCents * (1 + margin / 100));
  const asset = CHAIN_ASSET[chain];
  const price = await (deps.price ?? ((s) => usdPrice(s, deps.fetch)))(asset.symbol);
  const amount = usdToAtomic(chargeCents, price, asset.decimals);
  const now = Date.now();
  const quote = await signQuote(
    {
      v: 1,
      id: newQuoteId(),
      ...(req.topup ? { topup: req.topup } : {}),
      target,
      tier,
      usdCents,
      chain,
      asset: asset.symbol,
      amount: amount.toString(),
      priceUsd: price,
      treasury,
      ...(evmChainId ? { evmChainId } : {}),
      issuedAt: now,
      expiresAt: now + QUOTE_TTL_MS,
    },
    env.QUOTE_SECRET,
  );
  return { quote, note };
}
