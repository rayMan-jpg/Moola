// @vitest-environment node
import bs58 from 'bs58';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { claimMessage, type Quote } from '../../../shared/contract';
import { utf8Hex, verifyEvmPayment, verifySolanaPayment } from '../../../worker/src/pay';
import { clearPriceCache } from '../../../worker/src/price';
import { makeQuote, signQuote, verifyQuote } from '../../../worker/src/quote';
import { EVM_HASH, evmPayment, mockFetch, PAYER_EVM, PAYER_SOL, PRICES, SOL_SIG, solPaymentTx, solWallet, testEnv } from './helpers';

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

  it('no longer binds quotes to a payer (an unauthenticated address proved nothing)', async () => {
    const { fetch } = mockFetch([[...ghRepo()], PRICES.coinbase('SOL', 150), PRICES.kraken('SOLUSD', 150)]);
    const req = { target: 'affaan-m/ECC', tier: 'standard', chain: 'solana', payer: PAYER_SOL } as Parameters<typeof makeQuote>[0];
    const { quote } = await makeQuote(req, testEnv(), { fetch });
    expect(quote).not.toHaveProperty('payer');
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
  const verify = (q: Quote, tx: unknown, claimSig?: string) => verifySolanaPayment(SOL_SIG, q, ['https://sol.test'], rpc(tx), claimSig);

  it('accepts a confirmed transfer of the quoted amount with the quote memo', async () => {
    const q = await solQuote();
    const r = await verify(q, solPaymentTx(q));
    expect(r).toMatchObject({ ok: true, payer: PAYER_SOL, paid: 100_000_000n });
  });

  it('falls back to the memo program log line', async () => {
    const q = await solQuote();
    expect((await verify(q, solPaymentTx(q, { memoInLogsOnly: true }))).ok).toBe(true);
  });

  it('rejects short, failed, stale and very late payments', async () => {
    const q = await solQuote();
    const check = (o: Parameters<typeof solPaymentTx>[1]) => verify(q, solPaymentTx(q, o));
    expect(await check({ lamports: 99_999_999n })).toMatchObject({ ok: false, pending: false, reason: expect.stringMatching(/short/) });
    expect(await check({ err: { InstructionError: [0, 'x'] } })).toMatchObject({ ok: false, reason: expect.stringMatching(/failed/) });
    expect(await check({ blockTime: Math.floor(q.issuedAt / 1000) - 3600 })).toMatchObject({ ok: false, reason: expect.stringMatching(/older/) });
    expect(await check({ blockTime: Math.floor(q.expiresAt / 1000) + 25 * 3600 })).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it('accepts a tagged payment that lands long after the quote expired (a popup left open)', async () => {
    const q = await solQuote();
    expect(await verify(q, solPaymentTx(q, { blockTime: Math.floor(q.expiresAt / 1000) + 3600 }))).toMatchObject({ ok: true });
    // and a little clock skew before issuance, since the memo can't predate the quote anyway
    expect(await verify(q, solPaymentTx(q, { blockTime: Math.floor(q.issuedAt / 1000) - 30 }))).toMatchObject({ ok: true });
  });

  it('never credits a payment tagged for another quote, whoever signs for it', async () => {
    const q = await solQuote();
    const payer = solWallet();
    const other = 'rea4u:q_aaaaaaaaaaaaaaaa';
    const tx = solPaymentTx(q, { memo: other, source: payer.address });
    expect(await verify(q, tx)).toMatchObject({ ok: false, reason: expect.stringMatching(/different quote/) });
    expect(await verify(q, tx, payer.sign(claimMessage(q.id, SOL_SIG)))).toMatchObject({ ok: false, reason: expect.stringMatching(/different quote/) });
    expect(await verify(q, tx)).not.toHaveProperty('needsClaim');
    // a foreign tag that only shows up in the memo log line counts too
    expect(await verify(q, solPaymentTx(q, { memo: other, memoInLogsOnly: true }))).toMatchObject({ ok: false, reason: expect.stringMatching(/different quote/) });
  });

  it('asks for a claim on an untagged transfer and accepts only the paying wallet signature', async () => {
    const q = await solQuote();
    const payer = solWallet();
    const tx = solPaymentTx(q, { memo: 'something else', source: payer.address });
    expect(await verify(q, tx)).toMatchObject({ ok: false, pending: false, needsClaim: true });
    expect(await verify(q, tx, payer.sign(claimMessage(q.id, SOL_SIG)))).toMatchObject({ ok: true, payer: payer.address });
    // another key, a claim for another quote or tx, and garbage are all refused
    expect(await verify(q, tx, solWallet().sign(claimMessage(q.id, SOL_SIG)))).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet that paid/) });
    expect(await verify(q, tx, payer.sign(claimMessage('q_bbbbbbbbbbbbbbbb', SOL_SIG)))).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet that paid/) });
    expect(await verify(q, tx, payer.sign(claimMessage(q.id, '6'.repeat(88))))).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet that paid/) });
    expect(await verify(q, tx, 'bm9wZQ==')).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet that paid/) });
  });

  it('checks Solana claims with native WebCrypto Ed25519 (no pure-JS curve math on a 10 ms CPU budget)', async () => {
    const q = await solQuote();
    // a wallet whose key lives in WebCrypto: the signature is checked across implementations
    const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const address = bs58.encode(new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer));
    const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(claimMessage(q.id, SOL_SIG))));
    const claim = btoa(String.fromCharCode(...sig));
    const tx = solPaymentTx(q, { memo: 'something else', source: address });
    const verifySpy = vi.spyOn(crypto.subtle, 'verify');
    try {
      expect(await verify(q, tx, claim)).toMatchObject({ ok: true, payer: address });
      expect(verifySpy).toHaveBeenCalledTimes(1);
      expect(verifySpy.mock.calls[0][0]).toBe('Ed25519');
      // a flipped bit, a short signature, or a payer that isn't a 32-byte key: refused, never thrown
      const flipped = sig.slice();
      flipped[10] ^= 1;
      expect(await verify(q, tx, btoa(String.fromCharCode(...flipped)))).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet that paid/) });
      expect(await verify(q, tx, btoa(String.fromCharCode(...sig.slice(0, 63))))).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet that paid/) });
      const odd = solPaymentTx(q, { memo: 'something else', source: bs58.encode(new Uint8Array(31).fill(7)) });
      expect(await verify(q, odd, claim)).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet that paid/) });
    } finally {
      verifySpy.mockRestore();
    }
  });

  it('only lets a claimed payment land inside the quote life (no early skew, short grace)', async () => {
    const q = await solQuote();
    const payer = solWallet();
    const claim = payer.sign(claimMessage(q.id, SOL_SIG));
    const at = (ms: number) => verify(q, solPaymentTx(q, { memo: 'x', source: payer.address, blockTime: Math.floor(ms / 1000) }), claim);
    expect(await at(q.issuedAt - 30_000)).toMatchObject({ ok: false, reason: expect.stringMatching(/older/) });
    expect(await at(q.issuedAt)).toMatchObject({ ok: true });
    expect(await at(q.expiresAt + 2 * 60_000)).toMatchObject({ ok: true });
    expect(await at(q.expiresAt + 3 * 60_000 + 1000)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
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
    expect(await verify(q, tx)).toMatchObject({ ok: false, reason: expect.stringMatching(/short/) });
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
  const verify = (q: Quote, p: ReturnType<typeof evmPayment> | null, claimSig?: string) => verifyEvmPayment(EVM_HASH, q, ['https://rh.test'], rpc(p), claimSig);

  it('accepts an ETH transfer to the treasury carrying the memo as calldata', async () => {
    const q = await evmQuote();
    expect(q).toMatchObject({ asset: 'ETH', evmChainId: 4663, amount: '1666666666666667' });
    expect(await verify(q, evmPayment(q))).toMatchObject({ ok: true, payer: PAYER_EVM.toLowerCase() });
  });

  it('accepts a tagged payment up to a day after expiry, not after', async () => {
    const q = await evmQuote();
    expect(await verify(q, evmPayment(q, { ts: q.expiresAt + 3_600_000 }))).toMatchObject({ ok: true });
    expect(await verify(q, evmPayment(q, { ts: q.expiresAt + 25 * 3_600_000 }))).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });

  it('asks for a claim on calldata-stripped sends and takes only a personal_sign from the sender', async () => {
    const q = await evmQuote();
    const payer = privateKeyToAccount(generatePrivateKey());
    const stripped = evmPayment(q, { input: '0x', from: payer.address });
    expect(await verify(q, stripped)).toMatchObject({ ok: false, pending: false, needsClaim: true });
    const good = await payer.signMessage({ message: claimMessage(q.id, EVM_HASH) });
    expect(await verify(q, stripped, good)).toMatchObject({ ok: true, payer: payer.address.toLowerCase() });
    const thief = privateKeyToAccount(generatePrivateKey());
    expect(await verify(q, stripped, await thief.signMessage({ message: claimMessage(q.id, EVM_HASH) }))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/wallet that paid/),
    });
    expect(await verify(q, stripped, await payer.signMessage({ message: claimMessage('q_bbbbbbbbbbbbbbbb', EVM_HASH) }))).toMatchObject({ ok: false });
    expect(await verify(q, stripped, '0x1234')).toMatchObject({ ok: false, reason: expect.stringMatching(/wallet that paid/) });
    // a claimed send must land inside the quote life
    expect(await verify(q, evmPayment(q, { input: '0x', from: payer.address, ts: q.expiresAt + 5 * 60_000 }), good)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    expect(await verify(q, evmPayment(q, { input: '0x', from: payer.address, ts: q.issuedAt - 10_000 }), good)).toMatchObject({ ok: false, reason: expect.stringMatching(/older/) });
  });

  it('never lets other calldata (another quote tag) be claimed', async () => {
    const q = await evmQuote();
    const payer = privateKeyToAccount(generatePrivateKey());
    const sig = await payer.signMessage({ message: claimMessage(q.id, EVM_HASH) });
    const other = evmPayment(q, { input: utf8Hex('rea4u:q_aaaaaaaaaaaaaaaa'), from: payer.address });
    expect(await verify(q, other, sig)).toMatchObject({ ok: false, reason: expect.stringMatching(/tagged/) });
    expect(await verify(q, other)).not.toHaveProperty('needsClaim');
  });

  it('rejects wrong recipient, amount, chain, reverted and pending txs', async () => {
    const q = await evmQuote();
    const check = (o: Parameters<typeof evmPayment>[1]) => verify(q, evmPayment(q, o));
    expect(await check({ to: PAYER_EVM })).toMatchObject({ ok: false, reason: expect.stringMatching(/treasury/) });
    expect(await check({ value: 1n })).toMatchObject({ ok: false, reason: expect.stringMatching(/short/) });
    expect(await check({ chainId: 1 })).toMatchObject({ ok: false, reason: expect.stringMatching(/wrong chain/) });
    expect(await check({ status: '0x0' })).toMatchObject({ ok: false, reason: expect.stringMatching(/failed/) });
    expect(await verify(q, null)).toMatchObject({ ok: false, pending: true });
  });
});

describe('price feed', () => {
  const quote = (routes: Parameters<typeof mockFetch>[0]) =>
    makeQuote({ target: 'affaan-m/ECC', tier: 'lite', chain: 'solana' }, testEnv(), { fetch: mockFetch([[...ghRepo()], ...routes]).fetch });

  it('takes the median of three exchanges, ignoring one outlier', async () => {
    const { quote: q } = await quote([PRICES.coinbase('SOL', 100), PRICES.kraken('SOLUSD', 101), PRICES.gemini('SOL', 160)]);
    expect(q.priceUsd).toBe(101);
  });

  it('refuses with fewer than two answering sources', async () => {
    await expect(quote([PRICES.coinbase('SOL', 100)])).rejects.toThrow(/not enough/);
  });
});
