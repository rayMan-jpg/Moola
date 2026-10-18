// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ComputeBudgetProgram, Keypair, TransactionInstruction, TransactionMessage, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { resignWith } from '../../src/launchpads/pump';

const valid = (tx: VersionedTransaction) => {
  const msg = tx.message.serialize();
  return tx.message.staticAccountKeys
    .slice(0, tx.message.header.numRequiredSignatures)
    .every((k, i) => ed25519.verify(tx.signatures[i], msg, k.toBytes()));
};

describe('wallet edits the message after the mint signed', () => {
  it('re-signing the mint slot makes the transaction valid again', () => {
    const payer = Keypair.generate();
    const mint = Keypair.generate();
    const createIx = new TransactionInstruction({
      programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
      keys: [{ pubkey: mint.publicKey, isSigner: true, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }],
      data: Buffer.from([1, 2, 3]),
    });
    const bh = '11111111111111111111111111111111';
    const ours = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: [createIx] }).compileToV0Message());
    ours.sign([mint]);

    // The "wallet" appends an instruction (like a guard assertion), then signs as payer.
    const edited = new VersionedTransaction(
      new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bh, instructions: [createIx, ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })] }).compileToV0Message(),
    );
    edited.signatures[edited.message.staticAccountKeys.findIndex((k) => k.equals(mint.publicKey))] = ours.signatures[1];
    edited.sign([payer]);
    expect(valid(edited)).toBe(false); // the stale mint signature no longer matches

    const fixed = VersionedTransaction.deserialize(resignWith(mint)(edited.serialize()));
    expect(valid(fixed)).toBe(true);
    expect(fixed.message.compiledInstructions).toHaveLength(2);
  });
});
