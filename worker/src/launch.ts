// On-chain proof that a job's payer launched a token on the job's launchpad. Job ids are public
// and the first verified record is final, so the proof must show the token was created by that
// launch, not merely touched by some tx the payer signed.

import { toEventSelector } from 'viem';
import type { PadId } from '../../shared/contract';
import type { Env } from './env';
import { EVM_HASH, jsonRpc, rpcList, SOL_SIG, SOLANA_RPC_DEFAULT } from './pay';
import type { JobRecord } from './store';

/** Launch programs per Solana pad (src/launchpads/guard.ts PROGRAMS). */
const SOL_PAD_PROGRAM: Partial<Record<PadId, string>> = {
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  bonk: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  jup: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
};

const PONS_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const PONS_ROUTER = '0xe33e9e479df8802cb0866d5d05258bec4cf62948';
export const STONK_PAD = '0xfcd61b25bbf3abd6cf0070d6328e351cc30eec9f';
const UTOKEN_FACTORY = '0xd03fb35ee057df5933a8a95b362cc3e11a56d4cf';
const STONK_CREATED = '0xa4d3b2dc54656491295ce21a0b888cd8df38e69113e44371344da5088e480a43';
// LaunchArmed(uint256 indexed id, uint256 supply, uint256 vQuote0, uint64 quoteUsd8, uint64 deadline):
// the id is topic 1 (StonkSafeLaunchpadV2 ABI, and so on mainnet).
const STONK_ARMED = toEventSelector('LaunchArmed(uint256,uint256,uint256,uint64,uint64)');
/** SPL Token and Token-2022: whichever one initializes a launch's mint. */
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);

interface EvmPad {
  /** Contracts the launch tx may be sent to. */
  to: string[];
  /** Contract that emits the creation event. */
  emitter: string;
  topic0: string;
  /** Index of the indexed topic holding the new token's address. */
  tokenTopic: number;
}

const EVM_PADS: Partial<Record<PadId, EvmPad>> = {
  // TokenLaunched(address indexed token, address indexed curve, address indexed deployer, ...)
  pons: { to: [PONS_FACTORY, PONS_ROUTER], emitter: PONS_FACTORY, topic0: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607', tokenTopic: 1 },
  // LaunchCreated(uint256 indexed id, address indexed token, address indexed creator, bool externalToken)
  stonk: { to: [STONK_PAD], emitter: STONK_PAD, topic0: STONK_CREATED, tokenTopic: 2 },
  utoken: {
    to: [UTOKEN_FACTORY],
    emitter: UTOKEN_FACTORY,
    topic0: toEventSelector('LaunchStarted(uint256,address,address,address,uint256)'),
    tokenTopic: 2,
  },
};

/** A launch can't predate the order it belongs to (blocks reusing one of the payer's older launches). */
const LAUNCH_SKEW_MS = 60_000;

interface SolIx {
  programId?: string;
  parsed?: unknown;
}

interface SolTokenBalance {
  mint?: string;
}

interface SolLaunchTx {
  blockTime: number | null;
  meta: {
    err: unknown;
    innerInstructions?: { instructions: SolIx[] }[];
    preTokenBalances?: SolTokenBalance[];
    postTokenBalances?: SolTokenBalance[];
  } | null;
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: SolIx[] } };
}

interface EvmLog {
  address?: string;
  topics?: string[];
}

interface EvmLaunchReceipt {
  status?: string;
  from?: string;
  to?: string | null;
  blockNumber?: string;
  logs?: EvmLog[];
}

const topicAddress = (addr: string) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const tooEarly = (job: JobRecord, atMs: number) => atMs < job.quote.issuedAt - LAUNCH_SKEW_MS;

/**
 * The tx created `mint`: the token program initialized it here, or it holds balances after the tx
 * and none before. A Jupiter Studio create is also signed by its curve config and Jupiter's
 * co-signer, so signing alone doesn't make a key the mint.
 */
function createsMint(r: SolLaunchTx, ixs: SolIx[], mint: string): boolean {
  const initialized = ixs.some((ix) => {
    if (!ix.programId || !TOKEN_PROGRAMS.has(ix.programId) || !ix.parsed || typeof ix.parsed !== 'object') return false;
    const p = ix.parsed as { type?: string; info?: { mint?: string } };
    return (p.type === 'initializeMint' || p.type === 'initializeMint2') && p.info?.mint === mint;
  });
  const holds = (b: SolTokenBalance[] | undefined) => (b ?? []).some((x) => x.mint === mint);
  return initialized || (holds(r.meta?.postTokenBalances) && !holds(r.meta?.preTokenBalances));
}

/**
 * Solana: confirmed without error, signed by the payer AND by the mint (every pad's create takes the
 * new mint as a signer), invoking the job's launchpad program, and creating that mint.
 */
async function solanaLaunch(env: Env, f: typeof fetch, job: JobRecord, mint: string, tx: string): Promise<boolean> {
  const program = SOL_PAD_PROGRAM[job.token.pad];
  if (!program || !SOL_SIG.test(tx) || mint === job.payer) return false;
  const r = await jsonRpc<SolLaunchTx | null>(
    rpcList(env.SOLANA_RPC, SOLANA_RPC_DEFAULT),
    'getTransaction',
    [tx, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }],
    f,
  );
  if (!r?.meta || r.meta.err !== null) return false;
  if (r.blockTime != null && tooEarly(job, r.blockTime * 1000)) return false;
  const keys = r.transaction.message.accountKeys;
  const signed = (k: string) => keys.some((x) => x.pubkey === k && x.signer);
  if (!signed(job.payer) || !signed(mint)) return false;
  const ixs = [...r.transaction.message.instructions, ...(r.meta.innerInstructions ?? []).flatMap((i) => i.instructions)];
  return ixs.some((ix) => ix.programId === program) && createsMint(r, ixs, mint);
}

async function evmReceipt(env: Env, f: typeof fetch, tx: string): Promise<{ rc: EvmLaunchReceipt; rpcs: string[] } | null> {
  const rpcs = rpcList(env.RH_RPC, []);
  if (!rpcs.length || !EVM_HASH.test(tx)) return null;
  const rc = await jsonRpc<EvmLaunchReceipt | null>(rpcs, 'eth_getTransactionReceipt', [tx], f);
  return rc ? { rc, rpcs } : null;
}

/**
 * Robinhood Chain: succeeded, sent by the payer to the pad's own contract, and the pad's creation
 * event (from the pad's contract) names the token.
 */
async function evmLaunch(env: Env, f: typeof fetch, job: JobRecord, mint: string, tx: string): Promise<boolean> {
  const pad = EVM_PADS[job.token.pad];
  const got = pad ? await evmReceipt(env, f, tx) : null;
  if (!pad || !got) return false;
  const { rc, rpcs } = got;
  if (rc.status !== '0x1' || rc.from?.toLowerCase() !== job.payer.toLowerCase() || !pad.to.includes(rc.to?.toLowerCase() ?? '')) return false;
  const token = topicAddress(mint);
  const created = (rc.logs ?? []).some(
    (l) => l.address?.toLowerCase() === pad.emitter && l.topics?.[0]?.toLowerCase() === pad.topic0 && l.topics?.[pad.tokenTopic]?.toLowerCase() === token,
  );
  if (!created || !rc.blockNumber) return false;
  const block = await jsonRpc<{ timestamp: string } | null>(rpcs, 'eth_getBlockByNumber', [rc.blockNumber, false], f);
  return !!block && !tooEarly(job, Number(BigInt(block.timestamp)) * 1000);
}

export async function tokenLaunchedBy(env: Env, f: typeof fetch, job: JobRecord, mint: string, tx: string): Promise<boolean> {
  try {
    return job.quote.chain === 'solana' ? await solanaLaunch(env, f, job, mint, tx) : await evmLaunch(env, f, job, mint, tx);
  } catch {
    return false;
  }
}

/**
 * A StonkLauncher token only trades once armed: a second tx, from the payer to the pad, that
 * succeeded and whose LaunchArmed event names the launch id the creation tx's LaunchCreated gave
 * this token.
 */
export async function stonkArmed(env: Env, f: typeof fetch, job: JobRecord, mint: string, tx: string, armTx: string): Promise<boolean> {
  try {
    if (armTx.toLowerCase() === tx.toLowerCase()) return false;
    const [created, armed] = await Promise.all([evmReceipt(env, f, tx), evmReceipt(env, f, armTx)]);
    if (!created || !armed) return false;
    const token = topicAddress(mint);
    const id = (created.rc.logs ?? [])
      .find((l) => l.address?.toLowerCase() === STONK_PAD && l.topics?.[0]?.toLowerCase() === STONK_CREATED && l.topics?.[2]?.toLowerCase() === token)
      ?.topics?.[1]?.toLowerCase();
    const { rc } = armed;
    return (
      !!id &&
      rc.status === '0x1' &&
      rc.from?.toLowerCase() === job.payer.toLowerCase() &&
      rc.to?.toLowerCase() === STONK_PAD &&
      (rc.logs ?? []).some((l) => l.address?.toLowerCase() === STONK_PAD && l.topics?.[0]?.toLowerCase() === STONK_ARMED && l.topics?.[1]?.toLowerCase() === id)
    );
  } catch {
    return false;
  }
}
