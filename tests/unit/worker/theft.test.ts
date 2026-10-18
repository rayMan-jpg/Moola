// @vitest-environment node
// Finding 0: a payment must never fund a quote its payer didn't pay for. Tagged payments belong to
// the quote they name; untagged ones only to whoever proves they control the paying wallet.
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimMessage, type JobRequest, type Quote } from '../../../shared/contract';
import { handle } from '../../../worker/src/index';
import { createJob, topupJob } from '../../../worker/src/jobs';
import { clearPriceCache } from '../../../worker/src/price';
import { makeQuote } from '../../../worker/src/quote';
import { EVM_HASH, evmPayment, SOL_SIG, solPaymentTx, solWallet } from './helpers';
import { req, topupQuote, world, type World } from './world';

beforeEach(() => clearPriceCache());

const newQuote = async (w: World) => (await makeQuote({ target: 'affaan-m/ECC', tier: 'standard', chain: w.quote.chain }, w.d.env, { fetch: w.d.fetch })).quote;
const thiefOrder = (w: World, quote: Quote, over: Partial<JobRequest> = {}) =>
  req(w, { quote, project: { name: 'Evil Corp' }, token: { name: 'Evil Corp', ticker: 'EVIL', pad: w.pad }, ...over });

async function post(w: World, body: unknown) {
  const r = await handle(new Request('https://api.test/api/jobs', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': `theft-${Math.random()}` } }), w.d.env, {
    store: w.store,
    engine: w.engine,
    fetch: w.d.fetch,
  });
  return { status: r.status, body: (await r.json()) as { error?: string; code?: string; id?: string; payer?: string } };
}

describe('solana: one payment, one quote', () => {
  it('a payment tagged for quote A cannot fund quote B; A still gets it', async () => {
    const w = await world();
    const victimQuote = w.quote; // the payment (w.payTx) is tagged rea4u:<victimQuote.id>
    const thiefQuote = await newQuote(w);
    const stolen = await post(w, thiefOrder(w, thiefQuote));
    expect(stolen.status).toBe(402);
    expect(stolen.body.error).toMatch(/different quote/);
    expect(stolen.body.code).toBeUndefined(); // not claimable
    expect(w.store.payments.size).toBe(0);
    // the payer's own order still goes through
    const own = await post(w, req(w));
    expect(own.status).toBe(200);
    expect(own.body.id).toBe(victimQuote.id);
  });

  it('cannot be redirected into another job as a top-up', async () => {
    const w = await world();
    await createJob(req(w), w.d); // thief's own job, paid with their own tagged payment
    const victim = await newQuote(w);
    w.payTx = solPaymentTx(victim); // the victim's payment, tagged for the victim's quote
    const tq = await topupQuote(w, 1000);
    await expect(topupJob(w.quote.id, { quote: tq, payTx: '4'.repeat(88) }, w.d)).rejects.toMatchObject({ status: 402 });
    expect(w.engine.budgets).toHaveLength(0);
  });

  it('an untagged payment needs a claim signed by the paying wallet (428 needs_claim first)', async () => {
    const w = await world();
    const payer = solWallet();
    w.payTx = solPaymentTx(w.quote, { memo: 'gm', source: payer.address });

    // a thief racing with their own quote: asked to claim, can't sign as the payer
    const thiefQuote = await newQuote(w);
    const race = await post(w, thiefOrder(w, thiefQuote));
    expect(race).toMatchObject({ status: 428, body: { code: 'needs_claim' } });
    const forged = await post(w, thiefOrder(w, thiefQuote, { claimSig: solWallet().sign(claimMessage(thiefQuote.id, SOL_SIG)) }));
    expect(forged.status).toBe(402);
    expect(forged.body.error).toMatch(/wallet that paid/);
    // replaying the payer's signature for the payer's quote doesn't help either
    const replay = await post(w, thiefOrder(w, thiefQuote, { claimSig: payer.sign(claimMessage(w.quote.id, SOL_SIG)) }));
    expect(replay.status).toBe(402);
    expect(w.store.payments.size).toBe(0);

    // the payer: asked to sign, signs, gets the job
    expect(await post(w, req(w))).toMatchObject({ status: 428, body: { code: 'needs_claim' } });
    const claimed = await post(w, req(w, { claimSig: payer.sign(claimMessage(w.quote.id, SOL_SIG)) }));
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ id: w.quote.id, payer: payer.address });
  });
});

describe('robinhood chain: calldata-stripped sends', () => {
  it('only the sender’s personal_sign claims a stripped send', async () => {
    const w = await world({ chain: 'robinhood' });
    const payer = privateKeyToAccount(generatePrivateKey());
    w.evm[EVM_HASH] = evmPayment(w.quote, { input: '0x', from: payer.address });

    const thiefQuote = await newQuote(w);
    expect(await post(w, thiefOrder(w, thiefQuote))).toMatchObject({ status: 428, body: { code: 'needs_claim' } });
    const thief = privateKeyToAccount(generatePrivateKey());
    const forged = await post(w, thiefOrder(w, thiefQuote, { claimSig: await thief.signMessage({ message: claimMessage(thiefQuote.id, EVM_HASH) }) }));
    expect(forged.status).toBe(402);

    const claimed = await post(w, req(w, { claimSig: await payer.signMessage({ message: claimMessage(w.quote.id, EVM_HASH) }) }));
    expect(claimed.status).toBe(200);
    expect(claimed.body.payer).toBe(payer.address.toLowerCase());
  });

  it('a send tagged for another quote is refused outright', async () => {
    const w = await world({ chain: 'robinhood' });
    const thiefQuote = await newQuote(w);
    const r = await post(w, thiefOrder(w, thiefQuote));
    expect(r.status).toBe(402);
    expect(r.body.code).toBeUndefined();
  });
});
