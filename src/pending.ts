// Local recovery records. Once money has moved, everything needed to finish the job is kept in this
// browser until the engine confirms it, so a closed tab, a flaky RPC or a slow engine never loses a
// paid order, a paid top-up or a launched token. The project page retries whatever is left here.

import type { ChainId, JobRequest, Quote } from '../shared/contract';

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

function keys(prefix: string): string[] {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
}

// ── a paid job the engine hasn't registered yet ──
export interface PendingJob {
  req: JobRequest;
  /** The paying wallet, so the project page can ask the right one to sign a claim. */
  payer: string;
  chain: ChainId;
  /** Solana: the payment's recent blockhash. Once it expired with the signature unknown, nothing was charged. */
  blockhash?: string;
  /** EVM: the payment's nonce. If the hash vanishes but the nonce got used, the wallet replaced it (speed up). */
  nonce?: number;
  /** When the payment was sent (ms). */
  at?: number;
}

const PENDING = (id: string) => `rea4u.pending.${id}`;

export function savePending(p: PendingJob) {
  write(PENDING(p.req.quote.id), p);
}

export function loadPending(id: string): PendingJob | null {
  const v = read<PendingJob | JobRequest>(PENDING(id));
  if (!v || typeof v !== 'object') return null;
  // Older builds stored the bare JobRequest.
  if ('quote' in v) return { req: v, payer: '', chain: v.quote.chain };
  return v.req?.quote ? v : null;
}

export function clearPending(id: string) {
  write(PENDING(id), null);
}

// ── a paid top-up the engine hasn't credited yet ──
export interface PendingTopup {
  jobId: string;
  quote: Quote;
  payTx: string;
  payer: string;
  claimSig?: string;
  /** The engine wants a claim signature (the wallet dropped the payment's tag). */
  needsClaim?: boolean;
  /** The engine refused it for good; shown until dismissed. */
  rejected?: string;
  /** Solana: the payment's recent blockhash (see PendingJob.blockhash). */
  blockhash?: string;
  /** EVM: the payment's nonce (see PendingJob.nonce). */
  nonce?: number;
  /** The wallet replaced the payment (speed up): waiting for the user to paste the new hash. */
  replaced?: boolean;
  /** When the payment was sent (ms). */
  at?: number;
}

const TOPUP = 'rea4u.topup.';

export function saveTopup(t: PendingTopup) {
  write(TOPUP + t.quote.id, t);
}

export function loadTopups(jobId: string): PendingTopup[] {
  return keys(TOPUP)
    .map((k) => read<PendingTopup>(k))
    .filter((t): t is PendingTopup => !!t?.quote && t.jobId === jobId);
}

export function clearTopup(quoteId: string) {
  write(TOPUP + quoteId, null);
}

// ── a launched token the engine hasn't recorded yet ──
/** On-chain (or sent): only needs POST /token. */
export interface UnrecordedLaunch {
  kind: 'record';
  mint: string;
  tx: string;
  url?: string;
  armTx?: string;
  /** Solana: the launch's recent blockhash, so the page can drop a launch that provably expired. */
  blockhash?: string;
  /** When the launch was sent (ms). */
  at?: number;
}

/** StonkLauncher: createLaunch went out, approve + arm still to do. */
export interface UnfinishedStonk {
  kind: 'stonk';
  createTx: string;
  /** Empty until the create receipt has been read. */
  launchId: string;
  token: string;
  url?: string;
  /** Older builds: the one arm tx sent. */
  armTx?: string;
  /** Every arm tx sent, oldest first. None is dropped until one is known to have succeeded. */
  armTxs?: string[];
}

/** All the arm txs a saved StonkLauncher launch has sent, oldest first. */
export function armsOf(s: UnfinishedStonk): string[] {
  return [...new Set([...(s.armTx ? [s.armTx] : []), ...(s.armTxs ?? [])])];
}

export type SavedLaunch = UnrecordedLaunch | UnfinishedStonk;

const LAUNCH = (jobId: string) => `rea4u.launch.${jobId}`;

export function saveLaunch(jobId: string, l: SavedLaunch) {
  write(LAUNCH(jobId), l);
}

export function loadLaunch(jobId: string): SavedLaunch | null {
  const v = read<SavedLaunch>(LAUNCH(jobId));
  return v && (v.kind === 'record' || v.kind === 'stonk') ? v : null;
}

export function clearLaunch(jobId: string) {
  write(LAUNCH(jobId), null);
}
