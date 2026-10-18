// Minimal JSON-RPC helpers: balance, simulation, broadcast and landing detection.
// api.mainnet-beta.solana.com answers 403 to any request with a browser Origin, so it is not listed.
export const DEFAULT_RPCS = ['https://solana-rpc.publicnode.com'];

const RPC_KEY = 'rea4u.rpc';
const REQUEST_TIMEOUT_MS = 10_000;

export function rpcUrls(): string[] {
  let custom = '';
  try {
    custom = localStorage.getItem(RPC_KEY) ?? '';
  } catch {
    /* storage can be blocked */
  }
  return custom ? [custom, ...DEFAULT_RPCS] : DEFAULT_RPCS;
}

export function setCustomRpc(url: string): void {
  try {
    if (url) localStorage.setItem(RPC_KEY, url);
    else localStorage.removeItem(RPC_KEY);
  } catch {
    /* ignore */
  }
}

/** The node answered with a JSON-RPC error: a definitive answer, unlike a network failure. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

let rpcId = 0;

export async function rpc<T>(method: string, params: unknown[], urls = rpcUrls()): Promise<T> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`RPC ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { message: string; code?: number } };
      if (json.error) throw new RpcError(json.error.message, json.error.code);
      return json.result as T;
    } catch (e) {
      if (e instanceof RpcError) throw e; // another node would say the same thing
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All RPCs failed');
}

export async function getBalanceSol(address: string): Promise<number> {
  const r = await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return r.value / 1e9;
}

export async function isBlockhashValid(blockhash: string): Promise<boolean> {
  const r = await rpc<{ value: boolean }>('isBlockhashValid', [blockhash, { commitment: 'processed' }]);
  return r.value;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Broadcast signed bytes. The first send runs the node's preflight so a dead transaction is reported
 * right away; rebroadcasts skip it.
 */
export async function sendRaw(signed: Uint8Array, { preflight = false } = {}): Promise<string> {
  return rpc<string>('sendTransaction', [
    toBase64(signed),
    { encoding: 'base64', skipPreflight: !preflight, preflightCommitment: 'processed', maxRetries: 0 },
  ]);
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

export interface SimAccount {
  owner: string;
  lamports: number;
}

export interface SimResult {
  err: unknown;
  /** Post-simulation state of the addresses passed in `watch`, in order. */
  accounts?: (SimAccount | null)[] | null;
  loadedAddresses?: { writable: string[]; readonly: string[] };
  logs: string[] | null;
  unitsConsumed?: number;
  preBalances?: number[];
  postBalances?: number[];
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
}

/** Dry-runs a transaction against live mainnet state without needing (or checking) signatures. */
export async function simulateTx(tx: Uint8Array, watch: string[] = []): Promise<SimResult> {
  const params = [
    toBase64(tx),
    {
      encoding: 'base64',
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
      ...(watch.length ? { accounts: { encoding: 'base64', addresses: watch } } : {}),
    },
  ];
  let r = await rpc<{ value: SimResult }>('simulateTransaction', params);
  // Balance deltas are needed for the spend check; older custom nodes may not return them.
  if (!r.value.preBalances && rpcUrls()[0] !== DEFAULT_RPCS[0]) r = await rpc<{ value: SimResult }>('simulateTransaction', params, DEFAULT_RPCS);
  return r.value;
}

const FUNDS = /insufficient lamports|insufficient funds|InsufficientFundsForFee|InsufficientFundsForRent|"AccountNotFound"|Attempt to debit an account but found no record/i;

/** Turns a failed simulation into a readable error, or returns null if it passed. */
export function simError(sim: SimResult): Error | null {
  if (!sim.err) return null;
  const logs = (sim.logs ?? []).join('\n');
  const text = `${JSON.stringify(sim.err)}\n${logs}`;
  if (FUNDS.test(text)) {
    return Object.assign(new Error('not enough SOL for fees + dev buy. top up and retry.'), { friendly: true, funds: true });
  }
  const errLine = (sim.logs ?? []).filter((l) => /Error|failed/i.test(l)).at(0) ?? '';
  return new Error(`launch simulation failed: ${JSON.stringify(sim.err)} ${errLine}`.slice(0, 280));
}

export type Landing = 'confirmed' | 'failed' | 'expired' | 'unknown';

interface SigStatus {
  err: unknown;
  confirmationStatus?: string;
}

async function status(sig: string, history: boolean): Promise<SigStatus | null> {
  const r = await rpc<{ value: (SigStatus | null)[] }>('getSignatureStatuses', [[sig], { searchTransactionHistory: history }]);
  return r.value[0];
}

/**
 * Waits until the transaction is confirmed, fails, or provably can no longer land (its blockhash
 * expired and it is not on chain). 'unknown' only when the RPC can't tell us within the time limit.
 */
export async function waitForLanding(
  sig: string,
  blockhash: string,
  { timeoutMs = 120_000, intervalMs = 2_000, rebroadcast }: { timeoutMs?: number; intervalMs?: number; rebroadcast?: () => Promise<unknown> } = {},
): Promise<{ status: Landing; err?: unknown }> {
  const start = Date.now();
  // Public RPCs drop transactions under load; re-sending the same signed bytes is idempotent.
  const timer = rebroadcast ? setInterval(() => rebroadcast().catch(() => undefined), intervalMs) : undefined;
  try {
    while (Date.now() - start < timeoutMs) {
      try {
        const s = await status(sig, false);
        if (s?.err) return { status: 'failed', err: s.err };
        if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return { status: 'confirmed' };
        if (!s && !(await isBlockhashValid(blockhash))) {
          const last = await status(sig, true);
          if (last?.err) return { status: 'failed', err: last.err };
          if (last?.confirmationStatus === 'confirmed' || last?.confirmationStatus === 'finalized') return { status: 'confirmed' };
          if (!last) return { status: 'expired' };
        }
      } catch {
        /* transient RPC hiccup, keep polling */
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    return { status: 'unknown' };
  } finally {
    if (timer) clearInterval(timer);
  }
}
