// The two payment transactions the site builds, simulated on mainnet. Nothing is sent.
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { payMemo, type Quote } from '../../shared/contract';
import { evmRpc, utf8Hex } from '../../src/evm/chain';
import { solPaymentInstructions } from '../../src/payment';
import { rpc } from '../../src/rpc';
import { fundedPayer, sim } from './helpers';

const quote = (o: Partial<Quote>): Quote => ({
  v: 1,
  id: 'q_abcdefghijklmnop',
  target: { kind: 'github', url: 'https://github.com/affaan-m/ECC', host: 'github.com', label: 'affaan-m/ECC', brand: ['ecc'] },
  tier: 'lite',
  usdCents: 500,
  chain: 'solana',
  asset: 'SOL',
  amount: '33333334',
  priceUsd: 150,
  treasury: '4ohMhNctr8aLPkqQoSkxtQa16PvZi1LqHeVvmPvZ66Q5',
  issuedAt: Date.now(),
  expiresAt: Date.now() + 600_000,
  sig: 'x',
  ...o,
});

describe('payments (mainnet simulation)', () => {
  it('solana: transfer + memo moves exactly the quote to the treasury and logs the memo', async () => {
    const payer = await fundedPayer(1);
    const q = quote({});
    const { value } = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    const key = new PublicKey(payer);
    const tx = new VersionedTransaction(
      new TransactionMessage({ payerKey: key, recentBlockhash: value.blockhash, instructions: solPaymentInstructions(q, key) }).compileToV0Message(),
    );
    expect(tx.serialize().length).toBeLessThan(400);
    const r = await sim(tx, [q.treasury]);
    expect(r.err).toBeNull();
    expect(r.logs?.some((l) => l === `Program log: Memo (len ${payMemo(q.id).length}): "${payMemo(q.id)}"`)).toBe(true);
    const tIdx = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === q.treasury);
    expect(r.postBalances![tIdx] - r.preBalances![tIdx]).toBe(Number(q.amount));
    expect(r.unitsConsumed).toBeLessThan(30_000);
  }, 60_000);

  it('robinhood chain: ETH transfer with the memo as calldata goes through to a plain EOA', async () => {
    const from = '0x00000000000000000000000000000000000bEEF5';
    const treasury = '0x307576dd4f73f91bb8c4a2edb762938e8e067d31'; // a plain EOA (no code)
    expect(await evmRpc<string>('eth_getCode', [treasury, 'latest'])).toBe('0x');
    const gas = BigInt(
      await evmRpc<string>('eth_estimateGas', [
        { from, to: treasury, value: '0x38d7ea4c68000', data: utf8Hex(payMemo('q_abcdefghijklmnop')) },
        'latest',
        { [from]: { balance: '0xde0b6b3a7640000' } },
      ]),
    );
    expect(gas).toBeGreaterThan(21_000n);
    expect(gas).toBeLessThan(100_000n);
  }, 60_000);
});
