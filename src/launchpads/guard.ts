// Defense in depth: transactions come from third-party builders (PumpPortal, bonk.fun, Jupiter) or a
// fast-moving SDK. Before the wallet prompt, check that every top-level instruction targets a program
// we expect for that launchpad, so a compromised builder can't slip in e.g. a SOL transfer to itself.
import { PublicKey, type VersionedTransaction } from '@solana/web3.js';

export const PROGRAMS = {
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  system: '11111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  pump: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  pumpPortalProxy: 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe',
  launchLab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',
  dbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',
  jupStudio: 'GL6kwZxTaXUXMGAvmmNZSXxANnwtPmKCHprHBM82zYXp',
} as const;

const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const SYSTEM_TRANSFER = 2;
const TOKEN_SYNC_NATIVE = 17;
const ATA_CREATE_IDEMPOTENT = 1;

export function wsolAta(owner: string): string {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(PROGRAMS.token).toBuffer(), new PublicKey(NATIVE_MINT).toBuffer()],
    new PublicKey(PROGRAMS.ata),
  )[0].toBase58();
}

export interface GuardOptions {
  creator: string;
  /** Programs any instruction may call. ComputeBudget is always allowed. */
  allow: string[];
  /** Max lamports a top-level System transfer may move, and only into the creator's own WSOL account. */
  wrapLamports?: number;
}

export class GuardError extends Error {}

export function guardTx(tx: VersionedTransaction, o: GuardOptions): void {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const allowed = new Set<string>([PROGRAMS.computeBudget, ...o.allow]);
  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    if (!program || !allowed.has(program)) {
      throw new GuardError(`launch transaction calls an unexpected program (${program ?? 'unknown'}). Aborted before your wallet saw it.`);
    }
    if (program === PROGRAMS.system) {
      const view = new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength);
      const to = keys[ix.accountKeyIndexes[1]];
      const lamports = ix.data.length >= 12 ? Number(view.getBigUint64(4, true)) : NaN;
      if (view.getUint32(0, true) !== SYSTEM_TRANSFER || to !== wsolAta(o.creator) || !(lamports <= (o.wrapLamports ?? 0))) {
        throw new GuardError('launch transaction tries to move SOL somewhere unexpected. Aborted before your wallet saw it.');
      }
    }
    if (program === PROGRAMS.token && ix.data[0] !== TOKEN_SYNC_NATIVE) {
      throw new GuardError('launch transaction contains an unexpected token instruction. Aborted before your wallet saw it.');
    }
    if (program === PROGRAMS.ata && ix.data[0] !== ATA_CREATE_IDEMPOTENT) {
      throw new GuardError('launch transaction contains an unexpected account instruction. Aborted before your wallet saw it.');
    }
  }
}
