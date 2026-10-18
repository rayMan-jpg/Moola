// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { guardTx, checkEffects, wsolAta, PROGRAMS, DISCRIMINATORS, GuardError } from '../../src/launchpads/guard';
import type { SimResult } from '../../src/rpc';

const creator = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const WSOL = new PublicKey('So11111111111111111111111111111111111111112');
const tx = (...ixs: TransactionInstruction[]) =>
  new VersionedTransaction(new TransactionMessage({ payerKey: creator, recentBlockhash: '11111111111111111111111111111111', instructions: ixs }).compileToV0Message());
const disc = (program: string, i = 0) => Buffer.from(DISCRIMINATORS[program][i], 'hex');
const call = (program: string, data: Uint8Array = disc(program)) =>
  new TransactionInstruction({ programId: new PublicKey(program), keys: [{ pubkey: creator, isSigner: true, isWritable: true }, { pubkey: mint, isSigner: true, isWritable: true }], data: Buffer.from(data) });
const ata = (owner: PublicKey, m: PublicKey, payer = creator) =>
  new TransactionInstruction({
    programId: new PublicKey(PROGRAMS.ata),
    keys: [payer, Keypair.generate().publicKey, owner, m, SystemProgram.programId, new PublicKey(PROGRAMS.token)].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i < 2 })),
    data: Buffer.from([1]),
  });
const wrap = (lamports: number) => SystemProgram.transfer({ fromPubkey: creator, toPubkey: new PublicKey(wsolAta(creator.toBase58())), lamports });
const sync = () => new TransactionInstruction({ programId: new PublicKey(PROGRAMS.token), keys: [{ pubkey: new PublicKey(wsolAta(creator.toBase58())), isSigner: false, isWritable: true }], data: Buffer.from([17]) });
const cb = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
const bonkOpts = { creator: creator.toBase58(), mint: mint.toBase58(), allow: [PROGRAMS.launchLab, PROGRAMS.ata, PROGRAMS.system, PROGRAMS.token], wrapLamports: 50_000_000 };

describe('guardTx (static shape)', () => {
  it('accepts a legit bonk-shaped launch with a WSOL wrap of the dev buy', () => {
    const t = tx(cb, call(PROGRAMS.launchLab), ata(creator, mint), ata(creator, WSOL), wrap(50_000_000), sync(), call(PROGRAMS.launchLab, disc(PROGRAMS.launchLab, 1)));
    expect(() => guardTx(t, bonkOpts)).not.toThrow();
  });

  it('blocks an unknown program', () => {
    expect(() => guardTx(tx(cb, call(Keypair.generate().publicKey.toBase58(), new Uint8Array(8))), bonkOpts)).toThrow(GuardError);
  });

  it('blocks unexpected instructions of an allowed program', () => {
    expect(() => guardTx(tx(call(PROGRAMS.launchLab, Buffer.from('0102030405060708', 'hex'))), bonkOpts)).toThrow(/unexpected/);
  });

  it('blocks a SOL transfer to anyone but the creator WSOL account', () => {
    const drain = SystemProgram.transfer({ fromPubkey: creator, toPubkey: Keypair.generate().publicKey, lamports: 1 });
    expect(() => guardTx(tx(cb, drain), bonkOpts)).toThrow(/move SOL/);
  });

  it('caps wraps in total, not per transfer', () => {
    expect(() => guardTx(tx(wrap(50_000_001)), bonkOpts)).toThrow(/more SOL/);
    expect(() => guardTx(tx(wrap(30_000_000), wrap(30_000_000)), bonkOpts)).toThrow(/more SOL/);
  });

  it('blocks other system instructions (e.g. assign)', () => {
    const assign = SystemProgram.assign({ accountPubkey: creator, programId: Keypair.generate().publicKey });
    expect(() => guardTx(tx(assign), bonkOpts)).toThrow(/move SOL/);
  });

  it('blocks token transfers and ATAs for someone else or for random mints', () => {
    expect(() => guardTx(tx(call(PROGRAMS.token, Buffer.from([3]))), bonkOpts)).toThrow(/token instruction/);
    expect(() => guardTx(tx(ata(Keypair.generate().publicKey, mint)), bonkOpts)).toThrow(/token accounts/);
    expect(() => guardTx(tx(ata(creator, Keypair.generate().publicKey)), bonkOpts)).toThrow(/token accounts/);
    expect(() => guardTx(tx(ata(creator, mint), ata(creator, mint), ata(creator, WSOL)), bonkOpts)).toThrow(/token accounts/);
  });

  it('blocks odd compute budget instructions', () => {
    expect(() => guardTx(tx(ComputeBudgetProgram.requestHeapFrame({ bytes: 32 * 1024 })), bonkOpts)).toThrow(/compute budget/);
  });

  it('only allows the PumpPortal proxy when asked', () => {
    const t = tx(cb, call(PROGRAMS.pump), call(PROGRAMS.pumpPortalProxy));
    const o = { creator: creator.toBase58(), mint: mint.toBase58() };
    expect(() => guardTx(t, { ...o, allow: [PROGRAMS.pump, PROGRAMS.ata] })).toThrow(GuardError);
    expect(() => guardTx(t, { ...o, allow: [PROGRAMS.pump, PROGRAMS.ata, PROGRAMS.pumpPortalProxy] })).not.toThrow();
  });
});

describe('checkEffects (simulated balance changes)', () => {
  const t = tx(cb, call(PROGRAMS.pump));
  const sim = (pre: number, post: number, extra: Partial<SimResult> = {}): SimResult => ({ err: null, logs: [], preBalances: [pre, 0], postBalances: [post, 0], ...extra });
  const o = { creator: creator.toBase58(), maxSpendSol: 0.02 };

  it('passes a launch within budget', () => {
    expect(checkEffects(sim(1e9, 1e9 - 6e6), t, o)).toBeNull();
  });

  it('fails closed over budget, e.g. a CPI drain by an allowed program', () => {
    expect(checkEffects(sim(1e9, 1e9 - 0.5e9), t, o)?.message).toMatch(/would take 0.5000 SOL/);
  });

  it('fails closed if the RPC gave no balances', () => {
    expect(checkEffects({ err: null, logs: [] }, t, o)).toBeInstanceOf(GuardError);
  });

  it('fails if any of the creator token balances goes down', () => {
    const tok = (amount: string) => [{ accountIndex: 1, mint: mint.toBase58(), owner: creator.toBase58(), uiTokenAmount: { amount } }];
    expect(checkEffects(sim(1e9, 1e9, { preTokenBalances: tok('100'), postTokenBalances: tok('99') }), t, o)?.message).toMatch(/move tokens/);
    expect(checkEffects(sim(1e9, 1e9, { preTokenBalances: tok('100'), postTokenBalances: [] }), t, o)?.message).toMatch(/move tokens/);
    expect(checkEffects(sim(1e9, 1e9, { preTokenBalances: tok('100'), postTokenBalances: tok('150') }), t, o)).toBeNull();
  });
});
