// On-chain payment verification. A payment counts when it is confirmed, succeeded, moved at
// least the quoted amount to the quoted treasury and landed inside the quote's window, and either
// carries the quote's tag (Solana memo / EVM calldata) or, when the wallet dropped the tag, comes
// with a claim signature from the paying wallet. Replays are stopped by the payments table.

import bs58 from 'bs58';
import { verifyMessage } from 'viem';
import { claimMessage, payMemo, type Quote } from '../../shared/contract';
import { PAY_GRACE_MS, TAGGED_GRACE_MS } from './quote';

export type PayCheck =
  | { ok: true; payer: string; paid: bigint; at: number }
  | { ok: false; pending: true; reason: string }
  /** needsClaim: an untagged payment that only the paying wallet's claim signature can unlock. */
  | { ok: false; pending: false; needsClaim?: true; reason: string };

type PayOk = Extract<PayCheck, { ok: true }>;

const SYSTEM_PROGRAM = '11111111111111111111111111111111';
const MEMO_PROGRAMS = new Set(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);
const MEMO_LOG = /^Program log: Memo \(len \d+\): "(.*)"$/;
const TAG_PREFIX = 'rea4u:';
/** Clock skew allowed for tagged payments (a memo naming the quote can't predate it anyway). */
const TAGGED_SKEW_MS = 60_000;

export const SOL_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
export const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const EVM_SIG = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;

export async function jsonRpc<T>(urls: string[], method: string, params: unknown[], f: typeof fetch): Promise<T> {
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

const reject = (reason: string): PayCheck => ({ ok: false, pending: false, reason });

/**
 * Tagged payments are bound to the quote by its HMAC'd id, so they may land long after expiry.
 * Claimed (untagged) ones are bound only by timing and the payer's signature, so they must land
 * inside the quote's own life.
 */
function inWindow(q: Quote, atMs: number, tagged: boolean): string | null {
  // Block times are whole seconds.
  const from = tagged ? q.issuedAt - TAGGED_SKEW_MS : Math.floor(q.issuedAt / 1000) * 1000;
  const until = q.expiresAt + (tagged ? TAGGED_GRACE_MS : PAY_GRACE_MS);
  if (atMs < from) return 'that payment is older than the quote';
  if (atMs >= until) return 'that payment landed after the quote expired';
  return null;
}

/** An untagged payment only counts with a valid claim signature from the wallet that paid. */
async function claimed(ok: PayOk, claimSig: string | undefined, valid: (sig: string) => boolean | Promise<boolean>): Promise<PayCheck> {
  if (!claimSig) {
    return { ok: false, pending: false, needsClaim: true, reason: 'your wallet dropped the payment tag. sign the claim message with the wallet that paid' };
  }
  if (!(await valid(claimSig))) return reject("that claim isn't signed by the wallet that paid");
  return ok;
}

/**
 * WebCrypto Ed25519, native on Workers (and Node), so a claim costs well under the Free plan's
 * 10 ms CPU even on a cold isolate (pure-JS ed25519 took 20+ ms cold).
 */
async function solClaimValid(q: Quote, tx: string, payer: string, claimSig: string): Promise<boolean> {
  try {
    const sig = Uint8Array.from(atob(claimSig), (c) => c.charCodeAt(0));
    const pub = bs58.decode(payer);
    if (sig.length !== 64 || pub.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, sig, new TextEncoder().encode(claimMessage(q.id, tx)));
  } catch {
    return false;
  }
}

async function evmClaimValid(q: Quote, hash: string, from: string, claimSig: string): Promise<boolean> {
  if (!EVM_SIG.test(claimSig)) return false;
  try {
    return await verifyMessage({ address: from as `0x${string}`, message: claimMessage(q.id, hash), signature: claimSig as `0x${string}` });
  } catch {
    return false;
  }
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

/** Every memo in the tx: memo instructions (outer and inner) and the memo program's log lines. */
function memosOf(ixs: ParsedIx[], logs: string[]): string[] {
  const out: string[] = [];
  for (const ix of ixs) if (ix.programId && MEMO_PROGRAMS.has(ix.programId) && typeof ix.parsed === 'string') out.push(ix.parsed.trim());
  for (const l of logs) {
    const m = MEMO_LOG.exec(l);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export async function verifySolanaPayment(sig: string, q: Quote, rpcs: string[], f: typeof fetch = fetch, claimSig?: string): Promise<PayCheck> {
  if (!SOL_SIG.test(sig)) return reject('bad transaction signature');
  const tx = await jsonRpc<SolTx | null>(
    rpcs,
    'getTransaction',
    // version 1 transactions are ~16% of mainnet now; 1 also covers legacy and v0
    [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }],
    f,
  );
  if (!tx || !tx.meta) return { ok: false, pending: true, reason: 'payment not confirmed yet' };
  if (tx.meta.err) return reject('that payment failed on-chain');

  const all = [...tx.transaction.message.instructions, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
  const memo = payMemo(q.id);
  const memos = memosOf(all, tx.meta.logMessages ?? []);
  // A payment tagged for another quote belongs to that quote, whoever asks.
  if (memos.some((m) => m.startsWith(TAG_PREFIX) && m !== memo)) return reject('that payment is tagged for a different quote');
  const tagged = memos.includes(memo);

  const at = (tx.blockTime ?? Math.floor(Date.now() / 1000)) * 1000;
  const late = inWindow(q, at, tagged);
  if (late) return reject(late);

  let paid = 0n;
  let payer = '';
  let biggest = -1n;
  for (const ix of all) {
    if (ix.programId !== SYSTEM_PROGRAM || !ix.parsed || typeof ix.parsed !== 'object') continue;
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
  if (paid < BigInt(q.amount)) return reject('that payment is short of the quote');
  const ok: PayOk = { ok: true, payer, paid, at };
  return tagged ? ok : claimed(ok, claimSig, (s) => solClaimValid(q, sig, payer, s));
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

export async function verifyEvmPayment(hash: string, q: Quote, rpcs: string[], f: typeof fetch = fetch, claimSig?: string): Promise<PayCheck> {
  if (!EVM_HASH.test(hash)) return reject('bad transaction hash');
  const [tx, receipt] = await Promise.all([
    jsonRpc<EvmTx | null>(rpcs, 'eth_getTransactionByHash', [hash], f),
    jsonRpc<EvmReceipt | null>(rpcs, 'eth_getTransactionReceipt', [hash], f),
  ]);
  if (!tx || !receipt || !tx.blockNumber) return { ok: false, pending: true, reason: 'payment not confirmed yet' };
  if (receipt.status !== '0x1') return reject('that payment failed on-chain');
  if (q.evmChainId && tx.chainId && BigInt(tx.chainId) !== BigInt(q.evmChainId)) return reject('that payment is on the wrong chain');
  const input = (tx.input || '0x').toLowerCase();
  const tagged = input === utf8Hex(payMemo(q.id)).toLowerCase();
  // Only a plain send whose calldata a wallet stripped can be claimed; any other data is someone else's.
  if (!tagged && input !== '0x') return reject("that payment isn't tagged with this quote");
  const block = await jsonRpc<{ timestamp: string } | null>(rpcs, 'eth_getBlockByNumber', [receipt.blockNumber, false], f);
  const at = block ? Number(BigInt(block.timestamp)) * 1000 : Date.now();
  const late = inWindow(q, at, tagged);
  if (late) return reject(late);
  if (!tx.to || tx.to.toLowerCase() !== q.treasury.toLowerCase()) return reject("that payment didn't go to the rea4u treasury");
  const paid = BigInt(tx.value);
  if (paid < BigInt(q.amount)) return reject('that payment is short of the quote');
  const ok: PayOk = { ok: true, payer: tx.from.toLowerCase(), paid, at };
  return tagged ? ok : claimed(ok, claimSig, (s) => evmClaimValid(q, hash, tx.from, s));
}

export function rpcList(v: string | undefined, fallback: string[]): string[] {
  const list = (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^https:\/\//.test(s));
  return list.length ? list : fallback;
}

export const SOLANA_RPC_DEFAULT = ['https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'];
