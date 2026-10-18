// Defense in depth: transactions come from third-party builders (PumpPortal, bonk.fun, Jupiter) or a
// fast-moving SDK. Before the wallet prompt we check, fail-closed:
//  1. static shape: every top-level instruction is an expected instruction of an expected program,
//     SOL only moves into the creator's own WSOL account (capped at the dev buy), ATAs are the creator's,
//     and pump's create_v2 names the user as creator (so fees can't be redirected);
//  2. effect: a mainnet simulation shows the creator spends at most the expected SOL, their wallet stays a
//     plain system account, and none of their existing token accounts (except WSOL for a dev buy) is
//     touched. That bounds what an allowed program could do via CPI to what the simulation can see.
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';
import { simulateTx, simError, type SimResult } from '../rpc';

const CREATE_V2 = 'd6904cec5f8b31b4';

/** create_v2 args: name, symbol, uri (borsh strings), then the creator pubkey. */
export function createV2Creator(data: Uint8Array): string | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 8;
  for (let i = 0; i < 3; i++) {
    if (off + 4 > data.length) return null;
    off += 4 + view.getUint32(off, true);
  }
  if (off + 32 > data.length) return null;
  return new PublicKey(data.subarray(off, off + 32)).toBase58();
}

export const PROGRAMS = {
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpPortalProxy: 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe',
  launchLab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  jupStudio: 'GL6kwZxTaXUXMGAvmmNZSXxANnwtPmKCHprHBM82zYXp',
} as const;

/** Allowed 8-byte instruction discriminators (hex) per launchpad program, taken from live builder output. */
export const DISCRIMINATORS: Record<string, string[]> = {
  [PROGRAMS.pump]: ['d6904cec5f8b31b4' /* create_v2 */, 'b817ee6167c5d33d' /* buy_v2 */],
  [PROGRAMS.pumpPortalProxy]: ['66323d1201daebea' /* PumpPortal buy */],
  [PROGRAMS.launchLab]: ['4399af27da102620' /* initialize_v2 */, 'faea0d7bd59c13ec' /* buy_exact_in */],
  [PROGRAMS.dbc]: ['c9cff3724b6f2fbd' /* create_config */, '8c55d7b06636684f' /* initialize_virtual_pool_with_spl_token */, '1407a9213a93a621' /* transfer_pool_creator */],
  [PROGRAMS.jupStudio]: ['afaf6d1f0d989bed' /* initialize */],
};

const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_TRANSFER = 2;
const TOKEN_SYNC_NATIVE = 17;
const ATA_CREATE_IDEMPOTENT = 1;
const CU_LIMIT = 2;
const CU_PRICE = 3;
const MAX_ATA_CREATES = 2;

export function wsolAta(owner: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(PROGRAMS.token).toBuffer(), new PublicKey(NATIVE_MINT).toBuffer()],
    new PublicKey(PROGRAMS.ata),
  )[0].toBase58();
}

export interface GuardOptions {
  creator: string;
  /** The mint this launch promises to create. */
  mint: string;
  /** Launchpad programs any instruction may call. ComputeBudget is always allowed. */
  allow: string[];
  /** Max lamports System transfers may move in total, and only into the creator's own WSOL account. */
  wrapLamports?: number;
}

export class GuardError extends Error {
  readonly guard = true;
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const abort = (why: string) => new GuardError(`${why} Aborted before your wallet saw it.`);

export function guardTx(tx: VersionedTransaction, o: GuardOptions): void {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  // Accounts loaded from lookup tables can't be resolved without a fetch; where an identity matters we
  // require a static key (signers and the programs themselves are always static).
  const key = (i: number) => keys[i] ?? `lookup#${i}`;
  const allowed = new Set<string>([PROGRAMS.computeBudget, ...o.allow]);
  let wrapped = 0;
  let transfers = 0;
  let ataCreates = 0;
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program || !allowed.has(program)) throw abort(`launch transaction calls an unexpected program (${program ?? 'unknown'}).`);
    const data = ix.data;
    if (program === PROGRAMS.computeBudget) {
      if (data[0] !== CU_LIMIT && data[0] !== CU_PRICE) throw abort('launch transaction has an unexpected compute budget instruction.');
    } else if (program === PROGRAMS.system) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const ok = data.length === 12 && view.getUint32(0, true) === SYSTEM_TRANSFER && key(ix.accountKeyIndexes[1]) === wsolAta(o.creator);
      if (!ok) throw abort('launch transaction tries to move SOL somewhere unexpected.');
      wrapped += Number(view.getBigUint64(4, true));
      transfers++;
      if (transfers > 1 || wrapped > (o.wrapLamports ?? 0)) throw abort('launch transaction tries to move more SOL than your dev buy.');
    } else if (program === PROGRAMS.token) {
      if (data[0] !== TOKEN_SYNC_NATIVE || key(ix.accountKeyIndexes[0]) !== wsolAta(o.creator)) throw abort('launch transaction contains an unexpected token instruction.');
    } else if (program === PROGRAMS.ata) {
      // createIdempotent accounts: [payer, ata, owner, mint, system, tokenProgram]. The ATA program
      // re-derives the address from (owner, mint), so an address equal to the creator's WSOL account
      // proves the mint is WSOL even when the mint itself is loaded from a lookup table.
      const [payer, ataAddr, owner, mint] = ix.accountKeyIndexes.map(key);
      const mintOk = mint === o.mint || mint === NATIVE_MINT || ataAddr === wsolAta(o.creator);
      ataCreates++;
      if (data[0] !== ATA_CREATE_IDEMPOTENT || payer !== o.creator || owner !== o.creator || !mintOk || ataCreates > MAX_ATA_CREATES) {
        throw abort('launch transaction creates token accounts it should not.');
      }
    } else {
      const d = hex(data.subarray(0, 8));
      const allowedIx = DISCRIMINATORS[program] ?? [];
      if (!allowedIx.includes(d)) throw abort(`launch transaction calls an unexpected ${program.slice(0, 6)}… instruction.`);
      if (program === PROGRAMS.pump && d === CREATE_V2 && createV2Creator(data) !== o.creator) {
        throw abort('launch transaction names someone else as the coin creator (they would get your creator fees).');
      }
    }
  }
}

export interface SpendCheck {
  creator: string;
  /** Most SOL the creator may lose to this transaction: dev buy + rent + fees. */
  maxSpendSol: number;
}

/** Checks a simulation's balance changes; returns an error or null. Exported for tests. */
export function checkEffects(sim: SimResult, tx: VersionedTransaction, o: SpendCheck): Error | null {
  if (!sim.preBalances || !sim.postBalances) return abort('could not verify what this transaction spends.');
  if (tx.message.staticAccountKeys[0].toBase58() !== o.creator) return abort('launch transaction has an unexpected fee payer.');
  const spent = (sim.preBalances[0] - sim.postBalances[0]) / 1e9;
  if (spent > o.maxSpendSol) return abort(`launch transaction would take ${spent.toFixed(4)} SOL from you, expected at most ${o.maxSpendSol.toFixed(4)}.`);
  // The wallet must stay a plain system account (no System::assign to some program).
  const me = sim.accounts?.[0];
  if (!me || me.owner !== PROGRAMS.system) return abort('launch transaction would change who controls your wallet.');
  // A launch creates fresh token accounts; it never needs the user's existing ones (bar WSOL for a dev buy),
  // and that rules out amount changes as well as silent authority/delegate changes.
  const keys = [...tx.message.staticAccountKeys.map((k) => k.toBase58()), ...(sim.loadedAddresses?.writable ?? []), ...(sim.loadedAddresses?.readonly ?? [])];
  const wsol = wsolAta(o.creator);
  const post = new Map((sim.postTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  for (const pre of sim.preTokenBalances ?? []) {
    if (pre.owner !== o.creator) continue;
    const after = post.get(pre.accountIndex);
    if (keys[pre.accountIndex] !== wsol) return abort(`launch transaction touches tokens you already hold (${pre.mint.slice(0, 6)}…).`);
    if (!after || after.owner !== o.creator || BigInt(after.uiTokenAmount.amount) < BigInt(pre.uiTokenAmount.amount)) {
      return abort('launch transaction would move wrapped SOL out of your wallet.');
    }
  }
  return null;
}

/**
 * Simulate against mainnet and verify effects. Throws the friendly "not enough SOL" error, a
 * GuardError, or a simulation failure. An RPC outage is not treated as a pass.
 */
export async function preflight(tx: VersionedTransaction, o: SpendCheck): Promise<void> {
  const sim = await simulateTx(tx.serialize(), [o.creator]);
  const failed = simError(sim);
  if (failed) throw failed;
  const bad = checkEffects(sim, tx, o);
  if (bad) throw bad;
}
