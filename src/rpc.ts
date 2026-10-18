// Minimal JSON-RPC helpers. Wallets broadcast for us; we only need blockhash, balance and status polling.
// api.mainnet-beta.solana.com answers 403 to any request with a browser Origin, so it is not listed.
export const DEFAULT_RPCS = ['https://solana-rpc.publicnode.com'];

const RPC_KEY = 'moola.rpc';

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

let rpcId = 0;

export async function rpc<T>(method: string, params: unknown[], urls = rpcUrls()): Promise<T> {
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      });
      if (!res.ok) throw new Error(`RPC ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(json.error.message);
      return json.result as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All RPCs failed');
}

export async function getBalanceSol(address: string): Promise<number> {
  const r = await rpc<{ value: number }>('getBalance', [address, { commitment: 'confirmed' }]);
  return r.value / 1e9;
}

export async function getLatestBlockhash(): Promise<string> {
  const r = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  return r.value.blockhash;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function sendRaw(signed: Uint8Array): Promise<string> {
  return rpc<string>('sendTransaction', [toBase64(signed), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]);
}

export interface SimResult {
  err: unknown;
  logs: string[] | null;
  unitsConsumed?: number;
}

/** Dry-runs a transaction against live mainnet state without needing (or checking) signatures. */
export async function simulateTx(tx: Uint8Array): Promise<SimResult> {
  const r = await rpc<{ value: SimResult }>('simulateTransaction', [
    toBase64(tx),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' },
  ]);
  return r.value;
}

/** Turns a failed simulation into a readable error, or returns null if it passed. */
export function simError(sim: SimResult): Error | null {
  if (!sim.err) return null;
  const logs = sim.logs ?? [];
  const errLine = [...logs].reverse().find((l) => /Error|insufficient|failed/i.test(l)) ?? '';
  const text = `${JSON.stringify(sim.err)} ${errLine}`;
  if (/insufficient lamports|insufficient funds|AccountNotFound|"InsufficientFundsForRent"/i.test(text) || /Attempt to debit an account but found no record/i.test(text)) {
    return Object.assign(new Error('not enough SOL for fees + dev buy. top up and retry.'), { friendly: true, funds: true });
  }
  return new Error(`launch simulation failed: ${text.slice(0, 240)}`);
}

export type TxStatus = 'confirmed' | 'failed' | 'timeout';

export async function waitForSignature(
  sig: string,
  { timeoutMs = 90_000, intervalMs = 2_000, rebroadcast }: { timeoutMs?: number; intervalMs?: number; rebroadcast?: () => Promise<unknown> } = {},
): Promise<{ status: TxStatus; err?: unknown }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // Public RPCs drop transactions under load; re-sending the same signed bytes is idempotent.
    if (rebroadcast && Date.now() - start < 60_000) rebroadcast().catch(() => undefined);
    try {
      const r = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>(
        'getSignatureStatuses',
        [[sig], { searchTransactionHistory: false }],
      );
      const s = r.value[0];
      if (s?.err) return { status: 'failed', err: s.err };
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { status: 'confirmed' };
    } catch {
      /* transient RPC hiccup, keep polling */
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { status: 'timeout' };
}
