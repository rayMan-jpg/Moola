// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import type { JobRequest, Quote } from '../../../shared/contract';
import { RUBRIC } from '../../../engine/task';
import { createJob, getJob, recordToken, topupJob, type Deps } from '../../../worker/src/jobs';
import { clearPriceCache } from '../../../worker/src/price';
import { makeQuote } from '../../../worker/src/quote';
import { MemoryStore } from '../../../worker/src/store';
import { FakeEngine, mockFetch, PAYER_SOL, PRICES, SOL_SIG, solPaymentTx, testEnv } from './helpers';

const MANIFEST = {
  status: 'complete',
  project: 'Agent Forge',
  summary: 'A rebranded agent harness.',
  target: { url: 'https://github.com/affaan-m/ECC', license: 'MIT', approach: 'fork' },
  stack: ['node'],
  kind: 'static',
  needs: { server: false, database: 'none', websockets: false, cron: false, storage: false, env: ['OPENAI_KEY', 'bad key'] },
  build: { install: 'npm ci', build: 'npm run build', output: 'dist' },
  features: [{ name: 'Browse agents', status: 'done' }],
  verified: { build: true, tests: '3 passed', smoke: true },
};

interface World {
  d: Deps;
  engine: FakeEngine;
  store: MemoryStore;
  calls: { method: string; url: string; body: unknown }[];
  quote: Quote;
  payTx: unknown;
  now: { t: number };
  gh: { created: unknown[]; pages: boolean; ghPagesBranch: boolean };
}

async function world(): Promise<World> {
  const env = testEnv();
  const engine = new FakeEngine();
  const store = new MemoryStore();
  const now = { t: Date.now() };
  const gh = { created: [] as unknown[], pages: false, ghPagesBranch: true };
  const w = { payTx: null as unknown } as World;
  const { fetch, calls } = mockFetch([
    ['GET', /api\.github\.com\/repos\/affaan-m\/ECC$/, () => ({ private: false, archived: false, size: 900 })],
    PRICES.coinbase('SOL', 150),
    PRICES.kraken('SOLUSD', 150),
    ['rpc:getTransaction', /sol\.test/, () => w.payTx],
    ['GET', /api\.github\.com\/users\/rea4u-builds$/, () => ({ type: 'Organization' })],
    ['GET', /api\.github\.com\/repos\/rea4u-builds\/[^/]+$/, () => new Response('{}', { status: 404 })],
    [
      'POST',
      /api\.github\.com\/orgs\/rea4u-builds\/repos$/,
      ({ body }) => {
        gh.created.push(body);
        const name = (body as { name: string }).name;
        return { html_url: `https://github.com/rea4u-builds/${name}`, full_name: `rea4u-builds/${name}`, default_branch: 'main' };
      },
    ],
    ['GET', /\/branches\/gh-pages$/, () => (gh.ghPagesBranch ? { name: 'gh-pages' } : new Response('{}', { status: 404 }))],
    ['GET', /\/pages$/, () => new Response('{}', { status: 404 })],
    [
      'POST',
      /\/pages$/,
      () => {
        gh.pages = true;
        return { html_url: 'x' };
      },
    ],
  ]);
  const quote = (await makeQuote({ target: 'affaan-m/ECC', tier: 'standard', chain: 'solana' }, env, { fetch })).quote;
  w.payTx = solPaymentTx(quote);
  Object.assign(w, { d: { env, store, engine, fetch, now: () => now.t }, engine, store, calls, quote, now, gh });
  return w;
}

function req(w: World, over: Partial<JobRequest> = {}): JobRequest {
  return {
    quote: w.quote,
    payTx: SOL_SIG,
    project: { name: 'Agent Forge' },
    token: { name: 'Agent Forge', ticker: 'FORGE', pad: 'pump' },
    needs: { budget: 'free', traffic: 'hobby', customDomain: false },
    ...over,
  };
}

beforeEach(() => clearPriceCache());

describe('job lifecycle', () => {
  it('verifies payment, creates the repo and a budget-capped, outcome-driven session', async () => {
    const w = await world();
    const job = await createJob(req(w), w.d);
    expect(job).toMatchObject({ id: w.quote.id, status: 'running', payer: PAYER_SOL, budgetCents: 1410, tier: 'standard' }); // $15 minus the 6% overshoot reserve
    expect(job.repo?.fullName).toMatch(/^rea4u-builds\/agent-forge-[a-z2-7]{6}$/);
    expect(w.gh.created[0]).toMatchObject({ private: false, auto_init: true, homepage: `https://rea4u.test/app/#/p/${w.quote.id}` });

    expect(w.engine.agents).toHaveLength(1);
    expect(w.engine.envs[0].hosts).toContain('github.com');
    const s = w.engine.sessions[0];
    expect(s.budgetCents).toBe(1410);
    expect(s.effort).toBe('high');
    expect(s.buildRepo).toEqual({ url: job.repo!.url, branch: 'main', token: 'ghp_test' });
    expect(s.engineRepo.url).toMatch(/github\.com/);
    expect(s.outcome.type).toBe('user.define_outcome');
    expect(s.outcome.rubric.content).toBe(RUBRIC);
    expect(s.outcome.max_iterations).toBe(3);
    expect(s.outcome.description).toContain('https://github.com/affaan-m/ECC');
    expect(s.outcome.description).toContain('Agent Forge');
  });

  it('is idempotent for the same quote + payment and refuses reuse elsewhere', async () => {
    const w = await world();
    await createJob(req(w), w.d);
    const again = await createJob(req(w), w.d);
    expect(again.id).toBe(w.quote.id);
    expect(w.engine.sessions).toHaveLength(1);
    await expect(createJob(req(w, { payTx: '6'.repeat(88) }), w.d)).rejects.toThrow(/already used/);

    // Same payment, different (validly signed) quote
    const q2 = (await makeQuote({ target: 'affaan-m/ECC', tier: 'standard', chain: 'solana' }, w.d.env, { fetch: w.d.fetch })).quote;
    w.payTx = solPaymentTx(q2);
    await expect(createJob(req(w, { quote: q2 }), w.d)).rejects.toThrow(/another job/);
  });

  it('rejects tampered quotes, brand clashes, chain mismatches and unpaid jobs', async () => {
    const w = await world();
    await expect(createJob(req(w, { quote: { ...w.quote, usdCents: 999999 } }), w.d)).rejects.toThrow(/tampered/);
    await expect(createJob(req(w, { token: { name: 'ECC Coin', ticker: 'ECCX', pad: 'pump' } }), w.d)).rejects.toThrow(/ecc/);
    await expect(createJob(req(w, { token: { name: 'Forge', ticker: 'FORGE', pad: 'pons' } }), w.d)).rejects.toThrow(/robinhood/);
    await expect(createJob(req(w, { project: { name: '<b>' } }), w.d)).rejects.toThrow(/project name/);
    w.payTx = null;
    await expect(createJob(req(w), w.d)).rejects.toMatchObject({ status: 202 });
    w.payTx = solPaymentTx(w.quote, { lamports: 1n });
    await expect(createJob(req(w), w.d)).rejects.toMatchObject({ status: 402 });
    expect(w.engine.sessions).toHaveLength(0);
  });

  it('retries a failed engine start on the next poll', async () => {
    const w = await world();
    w.engine.failCreateSession = 1;
    const first = await createJob(req(w), w.d);
    expect(first.status).toBe('starting');
    expect(w.engine.sessions).toHaveLength(0);
    const second = await getJob(w.quote.id, w.d);
    expect(second.status).toBe('running');
    expect(w.engine.sessions).toHaveLength(1);
    expect(w.engine.envs).toHaveLength(1); // environment reused across attempts
    expect(w.gh.created).toHaveLength(1);
  });

  it('pauses at the budget, resumes on a paid top-up, and finishes with outputs + Pages', async () => {
    const w = await world();
    await createJob(req(w), w.d);

    w.engine.snapshot = { status: 'running', spentCents: 420 };
    w.engine.events = [{ id: 'e1', type: 'agent.message', at: '2026-10-18T00:00:01Z', text: 'Recon done: MIT licensed, forking.\nmore' }];
    w.now.t += 10_000;
    let v = await getJob(w.quote.id, w.d);
    expect(v).toMatchObject({ status: 'running', spentCents: 420 });
    expect(v.feed.map((f) => f.text)).toContain('Recon done: MIT licensed, forking.');

    // Polls inside the sync window don't hit the engine again
    w.engine.snapshot = { status: 'idle', spentCents: 1502 };
    w.engine.events.push({ id: 'e2', type: 'session.status_idle', at: '2026-10-18T00:01:00Z', stopReason: 'budget_reached' });
    v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('running');
    w.now.t += 10_000;
    v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('paused');

    // Top-up: $10 more on top of what was actually spent (which overshot the cap)
    const { quote: tq } = await makeQuote({ target: '', tier: 'lite', chain: 'solana', topup: w.quote.id, usdCents: 1000 }, w.d.env, {
      fetch: w.d.fetch,
      jobTarget: async () => ({ target: w.quote.target, chain: 'solana', tier: 'standard' }),
    });
    w.payTx = solPaymentTx(tq);
    v = await topupJob(w.quote.id, { quote: tq, payTx: '7'.repeat(88) }, w.d);
    expect(v).toMatchObject({ status: 'running', budgetCents: 2442 }); // spent 1502 + ($10 - 60c reserve)
    expect(w.engine.budgets).toEqual([{ id: 'sesn_1', cents: 2442 }]);
    // the same top-up payment can't be applied twice
    await topupJob(w.quote.id, { quote: tq, payTx: '7'.repeat(88) }, w.d);
    expect(w.engine.budgets).toHaveLength(1);

    // Finish: grader satisfied, outputs written
    w.engine.snapshot = { status: 'idle', spentCents: 2100, outcome: { result: 'satisfied', explanation: 'all met', iteration: 1 } };
    w.engine.events.push(
      { id: 'e3', type: 'span.outcome_evaluation_end', at: '2026-10-18T00:09:00Z', result: 'satisfied', text: 'All 12 criteria met' },
      { id: 'e4', type: 'session.status_idle', at: '2026-10-18T00:09:01Z', stopReason: 'end_turn' },
    );
    w.engine.outputs = [
      { id: 'f1', filename: 'rea4u.json', createdAt: '2026-10-18T00:08:00Z', text: JSON.stringify(MANIFEST) },
      { id: 'f2', filename: 'SPEC.md', createdAt: '2026-10-18T00:08:00Z', text: '# Agent Forge spec' },
    ];
    w.now.t += 10_000;
    v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('done');
    expect(v.manifest).toMatchObject({ status: 'complete', kind: 'static', needs: { env: ['OPENAI_KEY'] } });
    expect(v.spec).toBe('# Agent Forge spec');
    expect(v.live).toMatch(/^https:\/\/rea4u-builds\.github\.io\/agent-forge-/);
    expect(w.gh.pages).toBe(true);
    expect(w.engine.envs[0].archived).toBe(true);
    expect(v.feed.some((f) => f.text.startsWith('grader: PASSED'))).toBe(true);
  });

  it('marks refused targets from the manifest', async () => {
    const w = await world();
    await createJob(req(w), w.d);
    w.engine.snapshot = { status: 'idle', spentCents: 30, outcome: { result: 'satisfied', explanation: '', iteration: 0 } };
    w.engine.events = [{ id: 'e', type: 'session.status_idle', at: 't', stopReason: 'end_turn' }];
    w.engine.outputs = [{ id: 'f', filename: 'rea4u.json', createdAt: 't', text: JSON.stringify({ status: 'refused', refusal: 'bank login clone' }) }];
    w.now.t += 10_000;
    const v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('refused');
    expect(v.manifest?.refusal).toBe('bank login clone');
  });

  it('auto-denies tool approvals so unattended runs never stall', async () => {
    const w = await world();
    await createJob(req(w), w.d);
    w.engine.snapshot = { status: 'idle', spentCents: 30 };
    w.engine.events = [{ id: 'e', type: 'session.status_idle', at: 't', stopReason: 'requires_action', eventIds: ['sevt_1'] }];
    w.now.t += 10_000;
    const v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('running');
    expect(w.engine.denied).toEqual([['sevt_1']]);
  });

  it('records a launched token only when the launch tx is signed by the payer and touches the mint', async () => {
    const w = await world();
    await createJob(req(w), w.d);
    const mint = 'Mint1111111111111111111111111111111111111pump'.slice(0, 44);
    const good = { meta: { err: null }, transaction: { message: { accountKeys: [{ pubkey: PAYER_SOL, signer: true }, { pubkey: mint, signer: true }] } } };
    w.payTx = { ...good, transaction: { message: { accountKeys: [{ pubkey: 'Other1111111111111111111111111111111111111', signer: true }, { pubkey: mint, signer: true }] } } };
    await expect(recordToken(w.quote.id, { mint, tx: SOL_SIG }, w.d)).rejects.toThrow(/confirm/);
    w.payTx = good;
    const v = await recordToken(w.quote.id, { mint, tx: SOL_SIG }, w.d);
    expect(v.token).toMatchObject({ status: 'live', mint, url: `https://pump.fun/coin/${mint}` });
  });
});
