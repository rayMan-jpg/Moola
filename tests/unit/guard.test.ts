// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { guardTx, wsolAta, PROGRAMS, GuardError } from '../../src/launchpads/guard';

const creator = Keypair.generate().publicKey;
const tx = (...ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: creator, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message());
const call = (program: string, data: number[] = [0]) => new TransactionInstruction({ programId: new PublicKey(program), keys: [{ pubkey: creator, isSigner: true, isWritable: true }], data: Buffer.from(data) });
const cb = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
const opts = { creator: creator.toBase58(), allow: [PROGRAMS.launchLab, PROGRAMS.ata, PROGRAMS.system, PROGRAMS.token], wrapLamports: 50_000_000 };

describe('guardTx', () => {
  it('accepts a legit bonk-shaped launch with a WSOL wrap of the dev buy', () => {
    const wrap = SystemProgram.transfer({ fromPubkey: creator, toPubkey: new PublicKey(wsolAta(creator.toBase58())), lamports: 50_000_000 });
    expect(() => guardTx(tx(cb, call(PROGRAMS.launchLab, [67]), call(PROGRAMS.ata, [1]), wrap, call(PROGRAMS.token, [17])), opts)).not.toThrow();
  });

  it('blocks an unknown program', () => {
    expect(() => guardTx(tx(cb, call(Keypair.generate().publicKey.toBase58())), opts)).toThrow(GuardError);
  });

  it('blocks a SOL transfer to anyone but the creator WSOL account', () => {
    const drain = SystemProgram.transfer({ fromPubkey: creator, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    expect(() => guardTx(tx(cb, call(PROGRAMS.launchLab), drain), opts)).toThrow(/move SOL/);
  });

  it('blocks a wrap bigger than the dev buy', () => {
    const wrap = SystemProgram.transfer({ fromPubkey: creator, toPubkey: new PublicKey(wsolAta(creator.toBase58())), lamports: 50_000_001 });
    expect(() => guardTx(tx(cb, wrap), opts)).toThrow(/move SOL/);
  });

  it('blocks other system instructions (e.g. assign)', () => {
    const assign = SystemProgram.assign({ accountPubkey: creator, programId: Keypair.generate().publicKey });
    expect(() => guardTx(tx(cb, assign), opts)).toThrow(/move SOL/);
  });

  it('blocks token transfers and non-idempotent ATA calls', () => {
    expect(() => guardTx(tx(call(PROGRAMS.token, [3])), opts)).toThrow(/token instruction/);
    expect(() => guardTx(tx(call(PROGRAMS.ata, [2])), opts)).toThrow(/account instruction/);
  });

  it('only allows the PumpPortal proxy when asked', () => {
    const t = tx(cb, call(PROGRAMS.pump), call(PROGRAMS.pumpPortalProxy, [102]));
    expect(() => guardTx(t, { creator: creator.toBase58(), allow: [PROGRAMS.pump, PROGRAMS.ata] })).toThrow(GuardError);
    expect(() => guardTx(t, { creator: creator.toBase58(), allow: [PROGRAMS.pump, PROGRAMS.ata, PROGRAMS.pumpPortalProxy] })).not.toThrow();
  });
});
