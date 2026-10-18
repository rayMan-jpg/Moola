// Minimal JSON-RPC helpers. Wallets broadcast for us; we only need blockhash, balance and status polling.
export const DEFAULT_RPCS = [
  'https://api.mainnet-beta.solana.com',
  'https://solana-rpc.publicnode.com',
];

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
  return rpc<string>('sendTransaction', [toBase64(signed), { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
}

export type TxStatus = 'confirmed' | 'failed' | 'timeout';

export async function waitForSignature(
  sig: string,
  { timeoutMs = 90_000, intervalMs = 2_000 } = {},
): Promise<{ status: TxStatus; err?: unknown }> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
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
