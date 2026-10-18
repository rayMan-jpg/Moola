// On-chain payment verification. A payment counts when it is confirmed, succeeded, moved at
// least the quoted amount to the quoted treasury, carries the quote's memo, and landed inside
// the quote's validity window. Replays are stopped by the payments table, not here.

import { payMemo, type Quote } from '../../shared/contract';
import { PAY_GRACE_MS } from './quote';

export type PayCheck =
  | { ok: true; payer: string; paid: bigint; at: number }
  | { ok: false; pending: true; reason: string }
  | { ok: false; pending: false; reason: string };

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MEMO_PROGRAMS = new Set(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);

const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;

async function jsonRpc<T>(urls: string[], method: string, params: unknown[], f: typeof fetch): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      const r = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
      const j = (await r.json()) as { result?: T; error?: { message?: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message ?? 'rpc error'}`);
      return j.result as T;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(`${method} failed`);
}

function inWindow(q: Quote, atMs: number): string | null {
  if (atMs < q.issuedAt - 60_000) return 'that payment is older than the quote';
  if (atMs > q.expiresAt + PAY_GRACE_MS) return 'that payment landed after the quote expired';
  return null;
}

interface ParsedIx {
  program?: string;
  programId?: string;
  parsed?: unknown;
}

interface SolTx {
  blockTime: number | null;
  meta: { err: unknown; logMessages?: string[]; innerInstructions?: { instructions: ParsedIx[] }[] } | null;
  transaction: { message: { instructions: ParsedIx[] } };
}

export async function verifySolanaPayment(sig: string, q: Quote, rpcs: string[], f: typeof fetch = fetch): Promise<PayCheck> {
  if (!SOL_SIG.test(sig)) return { ok: false, pending: false, reason: 'bad transaction signature' };
  const tx = await jsonRpc<SolTx | null>(
    rpcs,
    'getTransaction',
    [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }],
    f,
  );
  if (!tx) return { ok: false, pending: true, reason: 'payment not confirmed yet' };
  if (!tx.meta) return { ok: false, pending: true, reason: 'payment not confirmed yet' };
  if (tx.meta.err) return { ok: false, pending: false, reason: 'that payment failed on-chain' };
  const at = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
  const late = inWindow(q, at);
  if (late) return { ok: false, pending: false, reason: late };

  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
  let paid = 0n;
  let payer = '';
  let biggest = -1n;
  const memo = payMemo(q.id);
  let memoFound = false;
  for (const ix of all) {
    if (ix.programId === SYSTEM_PROGRAM && ix.parsed && typeof ix.parsed === 'object') {
      const p = ix.parsed as { type?: string; info?: { source?: string; destination?: string; lamports?: number | string } };
      if ((p.type === 'transfer' || p.type === 'transferWithSeed') && p.info?.destination === q.treasury) {
        const lamports = BigInt(p.info.lamports ?? 0);
        paid += lamports;
        if (lamports > biggest) {
          biggest = lamports;
          payer = p.info.source ?? '';
        }
      }
    }
    if (ix.programId && MEMO_PROGRAMS.has(ix.programId) && typeof ix.parsed === 'string' && ix.parsed.trim() === memo) memoFound = true;
  }
  if (!memoFound) {
    const needle = `"${memo}"`;
    memoFound = (tx.meta.logMessages ?? []).some((l) => l.startsWith('Program log: Memo') && l.endsWith(needle));
  }
  if (!memoFound) return { ok: false, pending: false, reason: "that payment isn't tagged with this quote" };
  if (paid < BigInt(q.amount)) return { ok: false, pending: false, reason: 'that payment is short of the quote' };
  return { ok: true, payer, paid, at };
}

interface EvmTx {
  from: string;
  to: string | null;
  value: string;
  input: string;
  chainId?: string;
  blockNumber: string | null;
}

interface EvmReceipt {
  status: string;
  blockNumber: string;
}

export function utf8Hex(s: string): string {
  return '0x' + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function verifyEvmPayment(hash: string, q: Quote, rpcs: string[], f: typeof fetch = fetch): Promise<PayCheck> {
  if (!EVM_HASH.test(hash)) return { ok: false, pending: false, reason: 'bad transaction hash' };
  const [tx, receipt] = await Promise.all([
    jsonRpc<EvmTx | null>(rpcs, 'eth_getTransactionByHash', [hash], f),
    jsonRpc<EvmReceipt | null>(rpcs, 'eth_getTransactionReceipt', [hash], f),
  ]);
  if (!tx || !receipt || !tx.blockNumber) return { ok: false, pending: true, reason: 'payment not confirmed yet' };
  if (receipt.status !== '0x1') return { ok: false, pending: false, reason: 'that payment failed on-chain' };
  if (q.evmChainId && tx.chainId && BigInt(tx.chainId) !== BigInt(q.evmChainId)) {
    return { ok: false, pending: false, reason: 'that payment is on the wrong chain' };
  }
  const block = await jsonRpc<{ timestamp: string } | null>(rpcs, 'eth_getBlockByNumber', [receipt.blockNumber, false], f);
  const at = block ? Number(BigInt(block.timestamp)) * 1000 : Date.now();
  const late = inWindow(q, at);
  if (late) return { ok: false, pending: false, reason: late };
  if (!tx.to || tx.to.toLowerCase() !== q.treasury.toLowerCase()) return { ok: false, pending: false, reason: "that payment didn't go to the rea4u treasury" };
  if (tx.input.toLowerCase() !== utf8Hex(payMemo(q.id)).toLowerCase()) return { ok: false, pending: false, reason: "that payment isn't tagged with this quote" };
  const paid = BigInt(tx.value);
  if (paid < BigInt(q.amount)) return { ok: false, pending: false, reason: 'that payment is short of the quote' };
  return { ok: true, payer: tx.from.toLowerCase(), paid, at };
}

export function rpcList(v: string | undefined, fallback: string[]): string[] {
  const list = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https:\/\//.test(s));
  return list.length ? list : fallback;
}

export const SOLANA_RPC_DEFAULT = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
