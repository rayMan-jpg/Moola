// Builds the Solana payment for a quote: one SOL transfer to the treasury plus a memo that ties
// it to the quote id. The API looks for exactly this pair when it verifies the payment.

import { ComputeBudgetProgram, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { Buffer } from 'buffer';
import { payMemo, type Quote } from '../shared/contract';
import { rpc } from './rpc';

export const MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

/** Network fee headroom on top of the quoted amount (base fee + priority fee). */
export const PAY_FEE_SOL = 0.0001;

export function solPaymentInstructions(q: Quote, payer: PublicKey): TransactionInstruction[] {
  if (q.chain !== 'solana') throw new Error('not a solana quote');
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(q.treasury), lamports: BigInt(q.amount) }),
    new TransactionInstruction({
      programId: MEMO_PROGRAM,
      keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
      data: Buffer.from(payMemo(q.id), 'utf8'),
    }),
  ];
}

export async function buildSolPayment(q: Quote, payer: string): Promise<VersionedTransaction> {
  const key = new PublicKey(payer);
  const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const msg = new TransactionMessage({ payerKey: key, recentBlockhash: value.blockhash, instructions: solPaymentInstructions(q, key) }).compileToV0Message();
  return new VersionedTransaction(msg);
}
