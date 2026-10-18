// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import type { Quote } from '../../../shared/contract';
import { verifyEvmPayment, verifySolanaPayment } from '../../../worker/src/pay';
import { clearPriceCache } from '../../../worker/src/price';
import { makeQuote, signQuote, verifyQuote } from '../../../worker/src/quote';
import { EVM_HASH, evmPayment, mockFetch, PAYER_EVM, PAYER_SOL, PRICES, SOL_SIG, solPaymentTx, testEnv } from './helpers';

const ghRepo = (over: object = {}) => ['GET', /api\.github\.com\/repos\/affaan-m\/ECC$/, () => ({ private: false, archived: false, size: 5000, ...over })] as const;

async function solQuote(): Promise<Quote> {
  const { fetch } = mockFetch([[...ghRepo()], PRICES.coinbase('SOL', 150), PRICES.kraken('SOLUSD', 150)]);
  return (await makeQuote({ target: 'affaan-m/ECC', tier: 'standard', chain: 'solana' }, testEnv(), { fetch })).quote;
}

beforeEach(() => clearPriceCache());

describe('quotes', () => {
  it('prices the tier in SOL and signs it', async () => {
    const q = await solQuote();
    expect(q).toMatchObject({ tier: 'standard', usdCents: 1500, chain: 'solana', asset: 'SOL', amount: '100000000', priceUsd: 150 });
    expect(q.id).toMatch(/^q_[a-z2-7]{16}$/);
    expect(q.expiresAt - q.issuedAt).toBe(600_000);
    expect(await verifyQuote(q, testEnv().QUOTE_SECRET)).toBe(true);
  });

  it('rejects any tampering, including a swapped treasury or a cheaper amount', async () => {
    const q = await solQuote();
    const s = testEnv().QUOTE_SECRET;
    expect(await verifyQuote({ ...q, amount: '1' }, s)).toBe(false);
    expect(await verifyQuote({ ...q, treasury: PAYER_SOL }, s)).toBe(false);
    expect(await verifyQuote({ ...q, target: { ...q.target, url: 'https://evil.test' } }, s)).toBe(false);
    expect(await verifyQuote(q, 'other-secret')).toBe(false);
    const { sig: _sig, ...rest } = q;
    expect(await verifyQuote(await signQuote(rest, s), s)).toBe(true);
  });

  it('applies the configured margin to the charge, not to the job budget', async () => {
    const { fetch } = mockFetch([[...ghRepo()], PRICES.coinbase('SOL', 100), PRICES.kraken('SOLUSD', 100)]);
    const { quote } = await makeQuote({ target: 'affaan-m/ECC', tier: 'lite', chain: 'solana' }, testEnv({ MARGIN_PCT: '10' }), { fetch });
    expect(quote.usdCents).toBe(500);
    expect(quote.amount).toBe('55000000'); // $5.50 at $100
  });

  it('refuses private or missing repos, bad targets and unconfigured chains', async () => {
    const env = testEnv();
    const priv = mockFetch([['GET', /api\.github\.com\/repos/, () => ({ private: true, archived: false, size: 1 })]]);
    await expect(makeQuote({ target: 'a/b', tier: 'lite', chain: 'solana' }, env, { fetch: priv.fetch })).rejects.toThrow(/private/);
    const missing = mockFetch([]);
    await expect(makeQuote({ target: 'a/b', tier: 'lite', chain: 'solana' }, env, { fetch: missing.fetch })).rejects.toThrow(/public/);
    await expect(makeQuote({ target: 'localhost', tier: 'lite', chain: 'solana' }, env, { fetch: missing.fetch })).rejects.toThrow(/public website/);
    await expect(makeQuote({ target: 'a/b', tier: 'lite', chain: 'solana' }, testEnv({ TREASURY_SOLANA: undefined }), { fetch: missing.fetch })).rejects.toThrow(/switched on/);
  });

  it('refuses to quote when price sources disagree', async () => {
    const { fetch } = mockFetch([[...ghRepo()], PRICES.coinbase('SOL', 150), PRICES.kraken('SOLUSD', 120)]);
    await expect(makeQuote({ target: 'affaan-m/ECC', tier: 'lite', chain: 'solana' }, testEnv(), { fetch })).rejects.toThrow(/disagree/);
  });

  it('quotes top-ups against the existing job and bounds the amount', async () => {
    const q = await solQuote();
    const { fetch } = mockFetch([PRICES.coinbase('SOL', 150), PRICES.kraken('SOLUSD', 150)]);
    const jobTarget = async () => ({ target: q.target, chain: 'solana' as const, tier: 'standard' as const });
    const r = await makeQuote({ target: '', tier: 'lite', chain: 'solana', topup: q.id, usdCents: 1000 }, testEnv(), { fetch, jobTarget });
    expect(r.quote).toMatchObject({ topup: q.id, usdCents: 1000, tier: 'standard', target: q.target });
    await expect(makeQuote({ target: '', tier: 'lite', chain: 'solana', topup: q.id, usdCents: 50 }, testEnv(), { fetch, jobTarget })).rejects.toThrow(/between/);
    await expect(makeQuote({ target: '', tier: 'lite', chain: 'robinhood', topup: q.id, usdCents: 1000 }, testEnv(), { fetch, jobTarget })).rejects.toThrow(/top up on solana/);
  });
});

describe('solana payment verification (real tx shape)', () => {
  const rpc = (tx: unknown) => mockFetch([['rpc:getTransaction', /sol\.test/, () => tx]]).fetch;

  it('accepts a confirmed transfer of the quoted amount with the quote memo', async () => {
    const q = await solQuote();
    const r = await verifySolanaPayment(SOL_SIG, q, ['https://sol.test'], rpc(solPaymentTx(q)));
    expect(r).toMatchObject({ ok: true, payer: PAYER_SOL, paid: 100_000_000n });
  });

  it('falls back to the memo program log line', async () => {
    const q = await solQuote();
    const r = await verifySolanaPayment(SOL_SIG, q, ['https://sol.test'], rpc(solPaymentTx(q, { memoInLogsOnly: true })));
    expect(r.ok).toBe(true);
  });

  it('rejects short, untagged, failed, stale and late payments', async () => {
    const q = await solQuote();
    const check = (o: Parameters<typeof solPaymentTx>[1]) => verifySolanaPayment(SOL_SIG, q, ['https://sol.test'], rpc(solPaymentTx(q, o)));
    expect(await check({ lamports: 99_999_999n })).toMatchObject({ ok: false, pending: false, reason: expect.stringMatching(/short/) });
    expect(await check({ memo: 'rea4u:q_aaaaaaaaaaaaaaaa' })).toMatchObject({ ok: false, reason: expect.stringMatching(/tagged/) });
    expect(await check({ err: { InstructionError: [0, 'x'] } })).toMatchObject({ ok: false, reason: expect.stringMatching(/failed/) });
    expect(await check({ blockTime: Math.floor(q.issuedAt / 1000) - 3600 })).toMatchObject({ ok: false, reason: expect.stringMatching(/older/) });
    expect(await check({ blockTime: Math.floor(q.expiresAt / 1000) + 3600 })).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it('reports pending while the tx is not confirmed, and rejects garbage signatures', async () => {
    const q = await solQuote();
    expect(await verifySolanaPayment(SOL_SIG, q, ['https://sol.test'], rpc(null))).toMatchObject({ ok: false, pending: true });
    expect(await verifySolanaPayment('nope', q, ['https://sol.test'], rpc(null))).toMatchObject({ ok: false, pending: false });
  });

  it('only counts transfers into the treasury', async () => {
    const q = await solQuote();
    const tx = solPaymentTx(q);
    const t = (tx.transaction.message.instructions as Record<string, unknown>[]).find((i) => i.program === 'system') as {
      parsed: { info: Record<string, unknown> };
    };
    t.parsed.info.destination = PAYER_SOL;
    expect(await verifySolanaPayment(SOL_SIG, q, ['https://sol.test'], rpc(tx))).toMatchObject({ ok: false, reason: expect.stringMatching(/short/) });
  });
});

describe('robinhood chain payment verification', () => {
  async function evmQuote(): Promise<Quote> {
    const { fetch } = mockFetch([[...ghRepo()], PRICES.coinbase('ETH', 3000), PRICES.kraken('XETHZUSD', 3000)]);
    return (await makeQuote({ target: 'affaan-m/ECC', tier: 'lite', chain: 'robinhood' }, testEnv(), { fetch })).quote;
  }
  const rpc = (p: ReturnType<typeof evmPayment> | null) =>
    mockFetch([
      ['rpc:eth_getTransactionByHash', /rh\.test/, () => p?.tx ?? null],
      ['rpc:eth_getTransactionReceipt', /rh\.test/, () => p?.receipt ?? null],
      ['rpc:eth_getBlockByNumber', /rh\.test/, () => p?.block ?? null],
    ]).fetch;

  it('accepts an ETH transfer to the treasury carrying the memo as calldata', async () => {
    const q = await evmQuote();
    expect(q).toMatchObject({ asset: 'ETH', evmChainId: 4663, amount: '1666666666666667' });
    expect(await verifyEvmPayment(EVM_HASH, q, ['https://rh.test'], rpc(evmPayment(q)))).toMatchObject({ ok: true, payer: PAYER_EVM.toLowerCase() });
  });

  it('rejects wrong recipient, memo, amount, chain, reverted and pending txs', async () => {
    const q = await evmQuote();
    const check = (o: Parameters<typeof evmPayment>[1]) => verifyEvmPayment(EVM_HASH, q, ['https://rh.test'], rpc(evmPayment(q, o)));
    expect(await check({ to: PAYER_EVM })).toMatchObject({ ok: false, reason: expect.stringMatching(/treasury/) });
    expect(await check({ input: '0x' })).toMatchObject({ ok: false, reason: expect.stringMatching(/tagged/) });
    expect(await check({ value: 1n })).toMatchObject({ ok: false, reason: expect.stringMatching(/short/) });
    expect(await check({ chainId: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/wrong chain/) });
    expect(await check({ status: '0x0' })).toMatchObject({ ok: false, reason: expect.stringMatching(/failed/) });
    expect(await check({ ts: q.expiresAt + 3_600_000 })).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(await verifyEvmPayment(EVM_HASH, q, ['https://rh.test'], rpc(null))).toMatchObject({ ok: false, pending: true });
  });
});
