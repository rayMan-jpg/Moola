// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { guardTx, checkEffects, createV2Creator, wsolAta, PROGRAMS, DISCRIMINATORS, GuardError } from '../../src/launchpads/guard';
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

const createV2 = (who: PublicKey) => {
  const str = (x: string) => {
    const b = Buffer.from(x);
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    return Buffer.concat([len, b]);
  };
  return Buffer.concat([disc(PROGRAMS.pump), str('Moola'), str('MOOLA'), str('https://turbo-gateway.com/abc'), who.toBuffer(), Buffer.from([0])]);
};

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
    const t = tx(cb, call(PROGRAMS.pump, createV2(creator)), call(PROGRAMS.pumpPortalProxy));
    const o = { creator: creator.toBase58(), mint: mint.toBase58() };
    expect(() => guardTx(t, { ...o, allow: [PROGRAMS.pump, PROGRAMS.ata] })).toThrow(GuardError);
    expect(() => guardTx(t, { ...o, allow: [PROGRAMS.pump, PROGRAMS.ata, PROGRAMS.pumpPortalProxy] })).not.toThrow();
  });
});

describe('pump create_v2 creator check', () => {
  const o = { creator: creator.toBase58(), mint: mint.toBase58(), allow: [PROGRAMS.pump, PROGRAMS.ata] };
  it('decodes the creator argument', () => {
    expect(createV2Creator(createV2(creator))).toBe(creator.toBase58());
    expect(createV2Creator(disc(PROGRAMS.pump))).toBeNull();
  });
  it('accepts the user as creator and blocks anyone else', () => {
    expect(() => guardTx(tx(call(PROGRAMS.pump, createV2(creator))), o)).not.toThrow();
    expect(() => guardTx(tx(call(PROGRAMS.pump, createV2(Keypair.generate().publicKey))), o)).toThrow(/creator fees/);
  });
});

describe('checkEffects (simulated balance changes)', () => {
  const t = tx(cb, call(PROGRAMS.pump), sync());
  const wsolIdx = t.message.staticAccountKeys.findIndex((k) => k.toBase58() === wsolAta(creator.toBase58()));
  const system = { owner: PROGRAMS.system, lamports: 1 };
  const sim = (pre: number, post: number, extra: Partial<SimResult> = {}): SimResult => ({ err: null, logs: [], preBalances: [pre, 0], postBalances: [post, 0], accounts: [system], ...extra });
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

  it('fails if the wallet stops being a plain system account, or that is unknown', () => {
    expect(checkEffects(sim(1e9, 1e9, { accounts: [{ owner: Keypair.generate().publicKey.toBase58(), lamports: 1 }] }), t, o)?.message).toMatch(/controls your wallet/);
    expect(checkEffects(sim(1e9, 1e9, { accounts: undefined }), t, o)).toBeInstanceOf(GuardError);
  });

  it('never touches tokens the user already holds', () => {
    const tok = (i: number, amount: string, owner = creator.toBase58()) => [{ accountIndex: i, mint: mint.toBase58(), owner, uiTokenAmount: { amount } }];
    expect(checkEffects(sim(1e9, 1e9, { preTokenBalances: tok(1, '100'), postTokenBalances: tok(1, '100') }), t, o)?.message).toMatch(/already hold/);
  });

  it('allows the WSOL account only if nothing leaves it and it stays the user\'s', () => {
    const tok = (amount: string, owner = creator.toBase58()) => [{ accountIndex: wsolIdx, mint: WSOL.toBase58(), owner, uiTokenAmount: { amount } }];
    expect(checkEffects(sim(1e9, 1e9, { preTokenBalances: tok('100'), postTokenBalances: tok('100') }), t, o)).toBeNull();
    expect(checkEffects(sim(1e9, 1e9, { preTokenBalances: tok('100'), postTokenBalances: tok('99') }), t, o)?.message).toMatch(/wrapped SOL/);
    expect(checkEffects(sim(1e9, 1e9, { preTokenBalances: tok('100'), postTokenBalances: tok('100', Keypair.generate().publicKey.toBase58()) }), t, o)?.message).toMatch(/wrapped SOL/);
    expect(checkEffects(sim(1e9, 1e9, { preTokenBalances: tok('100'), postTokenBalances: [] }), t, o)?.message).toMatch(/wrapped SOL/);
  });
});
