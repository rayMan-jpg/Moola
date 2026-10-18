// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { RUBRIC } from '../../../engine/task';
import { validateOrderNames } from '../../../shared/contract';
import { sweep } from '../../../worker/src/index';
import { createJob, getJob, topupJob } from '../../../worker/src/jobs';
import { clearPriceCache } from '../../../worker/src/price';
import { makeQuote, type HttpError } from '../../../worker/src/quote';
import type { JobRecord } from '../../../worker/src/store';
import { PAYER_SOL, solPaymentTx } from './helpers';
import { MANIFEST, req, topupQuote, world, type World } from './world';

beforeEach(() => clearPriceCache());

const SEC = 1000;
const MIN = 60 * SEC;

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
    expect(s.metadata.rea4u_job).toBe(w.quote.id);
    expect(s.buildRepo).toEqual({ url: job.repo!.url, branch: 'main', token: 'ghp_test' });
    expect(s.engineRepo.url).toMatch(/github\.com/);
    expect(s.outcome.type).toBe('user.define_outcome');
    expect(s.outcome.rubric.content).toBe(RUBRIC);
    expect(s.outcome.max_iterations).toBe(3);
    expect(s.outcome.description).toContain('https://github.com/affaan-m/ECC');
    expect(s.outcome.description).toContain('Agent Forge');
    // first start: nothing to look up
    expect(w.engine.findSessionCalls).toBe(0);
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

  it('checks names exactly as the site does (shared validateOrderNames), so "_" works on both sides', async () => {
    const cases: [project: string, name: string, ticker: string][] = [
      ['Agent_Forge', 'Agent_Forge', 'FORGE'],
      ['Agent Forge', "Bob's $Forge & Co!", 'FORGE2'],
      ['Agent Forge', 'Forge.v2-beta', 'FV2'],
      ['Agent Forge', 'A', 'FORGE'],
      ['Agent Forge', 'Agent#Forge', 'FORGE'],
      ['Agent Forge', 'Agent Forge', 'F'],
      ['Agent Forge', 'Agent Forge', 'FORGE_'],
      ['<b>', 'Agent Forge', 'FORGE'],
      ['Agent Forge', 'ECC Forge', 'FORGE'],
      ['ECC Clone', 'Agent Forge', 'FORGE'],
    ];
    for (const [project, name, ticker] of cases) {
      const w = await world();
      const site = validateOrderNames(w.quote.target, project, name, ticker);
      const api = await createJob(req(w, { project: { name: project }, token: { name, ticker, pad: 'pump' } }), w.d).then(
        (v) => v,
        (e: HttpError) => e,
      );
      if (site) expect(api, `${project} / ${name} / ${ticker}`).toMatchObject({ status: 400, message: site.msg });
      else expect(api, `${project} / ${name} / ${ticker}`).toMatchObject({ status: 'running', token: { name, ticker } });
    }
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
    const tq = await topupQuote(w);
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
});

describe('engine start: retries, persistence and the lease', () => {
  it('backs off between failed starts instead of burning attempts at poll speed', async () => {
    const w = await world();
    w.engine.failCreateSession = 1;
    const first = await createJob(req(w), w.d);
    expect(first.status).toBe('starting');
    expect(w.engine.sessions).toHaveLength(0);
    // polls inside the backoff don't retry
    for (let i = 0; i < 10; i++) await getJob(w.quote.id, w.d);
    expect((await w.store.getJob(w.quote.id))!.attempts).toBe(1);
    w.now.t += 15 * SEC;
    const second = await getJob(w.quote.id, w.d);
    expect(second.status).toBe('running');
    expect(w.engine.sessions).toHaveLength(1);
    expect(w.engine.envs).toHaveLength(1); // environment reused across attempts
    expect(w.gh.created).toHaveLength(1);
  });

  it('keeps a paid job starting through an upstream outage and only fails it after an hour', async () => {
    const w = await world();
    w.gh.createFailures = 1_000;
    const v = await createJob(req(w), w.d);
    expect(v.status).toBe('starting');
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const job = (await w.store.getJob(w.quote.id))!;
      waits.push(job.nextAttemptAt! - w.now.t);
      w.now.t = job.nextAttemptAt!;
      expect((await getJob(w.quote.id, w.d)).status).toBe('starting');
    }
    expect(waits).toEqual([15 * SEC, MIN, 5 * MIN, 15 * MIN, 15 * MIN, 15 * MIN]);
    // GitHub recovers before the deadline: the job starts
    w.gh.createFailures = 0;
    w.now.t = (await w.store.getJob(w.quote.id))!.nextAttemptAt!;
    expect((await getJob(w.quote.id, w.d)).status).toBe('running');
    expect(w.engine.sessions).toHaveLength(1);
  });

  it('marks the job failed once the start deadline has passed', async () => {
    const w = await world();
    w.gh.createFailures = 1_000;
    await createJob(req(w), w.d);
    w.now.t += 61 * MIN;
    const v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('failed');
    expect(v.error).toMatch(/start attempt 2 failed/);
  });

  it('retries GitHub 5xx and rate limits inside one attempt', async () => {
    const w = await world();
    w.gh.createFailures = 2;
    expect((await createJob(req(w), w.d)).status).toBe('running');
    expect(w.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/orgs/rea4u-builds/repos'))).toHaveLength(3);

    const w2 = await world();
    w2.gh.createFailures = 1;
    w2.gh.createStatus = 403; // secondary rate limit: 403 with retry-after
    expect((await createJob(req(w2), w2.d)).status).toBe('running');
  });

  it('reuses a session whose create committed upstream but reported an error', async () => {
    const w = await world();
    w.engine.failAfterCreateSession = 1;
    expect((await createJob(req(w), w.d)).status).toBe('starting');
    expect(w.engine.sessions).toHaveLength(1);
    const saved = (await w.store.getJob(w.quote.id))!;
    // repo, environment and the session marker were each saved as they happened
    expect(saved).toMatchObject({ environmentId: 'env_1', repo: { fullName: expect.stringMatching(/^rea4u-builds\//) } });
    expect(saved.sessionRequestedAt).toBeGreaterThan(0);
    expect(saved.sessionId).toBeUndefined();

    w.now.t += 15 * SEC;
    const v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('running');
    expect(w.engine.sessions).toHaveLength(1);
    expect(w.engine.findSessionCalls).toBe(1);
    expect((await w.store.getJob(w.quote.id))!.sessionId).toBe('sesn_1');
  });

  it('reuses a session created by a request that died before saving it', async () => {
    const w = await world();
    let saved: string | undefined;
    w.engine.onCreateSession = () => {
      if (saved) return;
      // sessions.create commits upstream, then the isolate is killed: nothing after it runs
      saved = w.store.jobs.get(w.quote.id)!.data;
      w.engine.sessions.push({ id: 'sesn_1', metadata: { rea4u_job: w.quote.id } } as never);
      throw new Error('isolate killed');
    };
    await createJob(req(w), w.d);
    const row = w.store.jobs.get(w.quote.id)!;
    Object.assign(row, { data: saved, leaseUntil: Date.now() + 60_000, leaseToken: 'dead-isolate' });
    expect(JSON.parse(row.data).sessionRequestedAt).toBeGreaterThan(0);
    expect((await getJob(w.quote.id, w.d)).status).toBe('starting'); // its lease is still held
    row.leaseUntil = 0; // ...until it expires
    const v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('running');
    expect(w.engine.sessions).toHaveLength(1);
    expect((await w.store.getJob(w.quote.id))!.sessionId).toBe('sesn_1');
  });

  it('syncs the agent before marking the session requested, so a slow agent sync can’t lead to a second session', async () => {
    const w = await world();
    let tookOver = false;
    w.engine.onFindAgent = async () => {
      if (tookOver) return;
      tookOver = true;
      // the first start is stuck in the agent sync (agents.list/update) past its lease
      const row = w.store.jobs.get(w.quote.id)!;
      expect(JSON.parse(row.data).sessionRequestedAt).toBeUndefined();
      row.leaseUntil = 0;
      // a poll takes the job over and starts it
      expect((await getJob(w.quote.id, w.d)).status).toBe('running');
    };
    const v = await createJob(req(w), w.d);
    expect(tookOver).toBe(true);
    // the first worker's marker write finds the lease gone, so it never reaches sessions.create
    expect(w.engine.sessions.map((s) => s.id)).toEqual(['sesn_1']);
    expect(v).toMatchObject({ status: 'running' });
    expect((await w.store.getJob(w.quote.id))!.sessionId).toBe('sesn_1');
  });

  it('renews the lease right before sessions.create, after the agent sync', async () => {
    const w = await world();
    const order: string[] = [];
    const renew = w.store.renew.bind(w.store);
    w.store.renew = async (...a) => {
      order.push('renew');
      return renew(...a);
    };
    w.engine.onFindAgent = () => void order.push('findAgent');
    w.engine.onCreateSession = () => void order.push('createSession');
    await createJob(req(w), w.d);
    expect(order).toEqual(['findAgent', 'renew', 'createSession']);
  });

  it('a worker that lost its lease stops, writes nothing and leaves the new holder alone', async () => {
    const w = await world();
    let stolen: string | null = null;
    w.engine.onCreateEnvironment = async () => {
      if (stolen) return;
      // our lease runs out mid-start and another poller takes the job over
      w.store.jobs.get(w.quote.id)!.leaseUntil = 0;
      stolen = await w.store.lease(w.quote.id, 60_000);
    };
    const v = await createJob(req(w), w.d);
    expect(stolen).toBeTruthy();
    expect(v.status).toBe('starting');
    expect(w.engine.sessions).toHaveLength(0); // never got as far as a session
    const stored = w.store.jobs.get(w.quote.id)!;
    expect(stored.leaseToken).toBe(stolen); // our unlease didn't clear their lease
    expect(JSON.parse(stored.data).environmentId).toBeUndefined(); // our write after the env was refused
    // a stale writer's put is refused outright
    const job = (await w.store.getJob(w.quote.id))!;
    expect(await w.store.putJob({ ...job, status: 'failed' }, 'not-our-lease')).toBe(false);
    expect((await w.store.getJob(w.quote.id))!.status).toBe('starting');

    await w.store.unlease(w.quote.id, stolen!);
    expect((await getJob(w.quote.id, w.d)).status).toBe('running');
    expect(w.engine.sessions).toHaveLength(1);
    expect(w.gh.created).toHaveLength(1);
  });
});

describe('session sync', () => {
  async function running(w: World) {
    await createJob(req(w), w.d);
    w.now.t += 10 * SEC;
  }

  it('nudges a retries_exhausted session to continue, with backoff, up to 3 times', async () => {
    const w = await world();
    await running(w);
    w.engine.snapshot = { status: 'idle', spentCents: 200 };
    w.engine.events = [{ id: 'e1', type: 'session.status_idle', at: 't1', stopReason: 'retries_exhausted' }];
    let v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('running');
    expect(v.feed.at(-1)?.text).toMatch(/nudged it to carry on \(1\/3\)/);
    expect(w.engine.resumed).toHaveLength(1);
    expect(w.engine.resumed[0]).toMatchObject({ id: 'sesn_1', text: expect.stringMatching(/continue/i) });
    // inside the backoff: no second nudge
    w.now.t += 10 * SEC;
    await getJob(w.quote.id, w.d);
    expect(w.engine.resumed).toHaveLength(1);
    w.now.t += 25 * SEC;
    await getJob(w.quote.id, w.d);
    expect(w.engine.resumed).toHaveLength(2);
    w.now.t += 2 * MIN;
    await getJob(w.quote.id, w.d);
    expect(w.engine.resumed).toHaveLength(3);
    // cap reached: finalize (after the outputs grace syncs)
    for (let i = 0; i < 3; i++) {
      w.now.t += 10 * SEC;
      v = await getJob(w.quote.id, w.d);
    }
    expect(w.engine.resumed).toHaveLength(3);
    expect(v.status).toBe('failed');
    expect(w.engine.envs[0].archived).toBe(true);
  });

  it('finalizes retries_exhausted at once when the budget is spent or the outcome is final', async () => {
    const w = await world();
    await running(w);
    w.engine.snapshot = { status: 'idle', spentCents: 30, outcome: { result: 'satisfied', explanation: '', iteration: 1 } };
    w.engine.events = [{ id: 'e1', type: 'session.status_idle', at: 't1', stopReason: 'retries_exhausted' }];
    w.engine.outputs = [{ id: 'f1', filename: 'rea4u.json', createdAt: 't', text: JSON.stringify(MANIFEST) }];
    expect((await getJob(w.quote.id, w.d)).status).toBe('done');
    expect(w.engine.resumed).toHaveLength(0);
  });

  it('waits a couple of syncs for outputs to show up before finalizing without a manifest', async () => {
    const w = await world();
    await running(w);
    w.engine.snapshot = { status: 'idle', spentCents: 30 };
    w.engine.events = [{ id: 'e1', type: 'session.status_idle', at: 't1', stopReason: 'end_turn' }];
    // first idle sync: outputs not indexed yet
    expect((await getJob(w.quote.id, w.d)).status).toBe('running');
    expect(w.engine.envs[0].archived).toBe(false);
    // then the refusal manifest appears
    w.engine.outputs = [{ id: 'f1', filename: 'rea4u.json', createdAt: 't', text: JSON.stringify({ status: 'refused', refusal: 'phishing kit' }) }];
    w.now.t += 10 * SEC;
    const v = await getJob(w.quote.id, w.d);
    expect(v.status).toBe('refused');
    expect(v.manifest?.refusal).toBe('phishing kit');
  });

  it('skips oversized output files instead of downloading them', async () => {
    const w = await world();
    await running(w);
    w.engine.snapshot = { status: 'idle', spentCents: 30, outcome: { result: 'satisfied', explanation: '', iteration: 1 } };
    w.engine.events = [{ id: 'e1', type: 'session.status_idle', at: 't1', stopReason: 'end_turn' }];
    const downloads: string[] = [];
    const download = w.engine.downloadText.bind(w.engine);
    w.engine.downloadText = async (id, max) => {
      downloads.push(id);
      return download(id, max);
    };
    w.engine.outputs = [
      { id: 'huge', filename: 'rea4u.json', createdAt: '2026-10-18T00:09:00Z', sizeBytes: 64 * 1024 * 1024, text: JSON.stringify(MANIFEST) },
      { id: 'ok', filename: 'out/rea4u.json', createdAt: '2026-10-18T00:08:00Z', text: JSON.stringify(MANIFEST) },
      { id: 'spec', filename: 'SPEC.md', createdAt: 't', sizeBytes: 300_000, text: '# huge' },
    ];
    const v = await getJob(w.quote.id, w.d);
    expect(downloads).toEqual(['ok']);
    expect(v.status).toBe('done');
    expect(v.spec).toBeUndefined();
  });
});

describe('top-ups', () => {
  async function paused(w: World) {
    await createJob(req(w), w.d);
    w.engine.snapshot = { status: 'idle', spentCents: 1502 };
    w.engine.events = [{ id: 'e2', type: 'session.status_idle', at: 't', stopReason: 'budget_reached' }];
    w.now.t += 10 * SEC;
    await getJob(w.quote.id, w.d);
  }

  it('decides "already credited" from the payments table, so a stale job write cannot reopen a top-up', async () => {
    const w = await world();
    await paused(w);
    const stale = (await w.store.getJob(w.quote.id))!; // read by some request before the top-up landed
    const tq = await topupQuote(w);
    w.payTx = solPaymentTx(tq);
    const tx = '7'.repeat(88);
    await topupJob(w.quote.id, { quote: tq, payTx: tx }, w.d);
    expect(w.engine.budgets).toHaveLength(1);
    expect(w.store.payments.get(`solana:${tx}`)).toEqual({ jobId: w.quote.id, credited: true });
    // a stale, unguarded write rolls the record back (budget and payments list)
    await w.store.putJob(stale);
    const v = await topupJob(w.quote.id, { quote: tq, payTx: tx }, w.d);
    expect(w.engine.budgets).toHaveLength(1);
    expect(v.budgetCents).toBe(stale.budgetCents);
  });

  it('keeps a verified but uncredited top-up bound to the job and credits it on retry', async () => {
    const w = await world();
    await paused(w);
    const tq = await topupQuote(w);
    w.payTx = solPaymentTx(tq);
    const tx = '7'.repeat(88);
    const setBudget = w.engine.setBudget.bind(w.engine);
    w.engine.setBudget = async () => {
      throw new Error('overloaded');
    };
    await expect(topupJob(w.quote.id, { quote: tq, payTx: tx }, w.d)).rejects.toThrow(/overloaded/);
    expect(w.store.payments.get(`solana:${tx}`)).toEqual({ jobId: w.quote.id, credited: false });
    w.engine.setBudget = setBudget;
    expect((await topupJob(w.quote.id, { quote: tq, payTx: tx }, w.d)).budgetCents).toBe(2442);
    expect(w.store.payments.get(`solana:${tx}`)!.credited).toBe(true);
  });

  /** Makes the next setBudget lose the lease right after raising the cap, while the session spends on. */
  function loseLeaseAfterSetBudget(w: World, spentSince: number) {
    const setBudget = w.engine.setBudget.bind(w.engine);
    const state = { thief: null as string | null };
    w.engine.setBudget = async (id, cents) => {
      await setBudget(id, cents);
      if (state.thief) return;
      w.engine.snapshot = { status: 'running', spentCents: spentSince };
      w.store.jobs.get(w.quote.id)!.leaseUntil = 0;
      state.thief = await w.store.lease(w.quote.id, 60_000);
    };
    return state;
  }

  it('finishes a top-up that lost its lease after raising the cap at that same cap, not on top of spend made since', async () => {
    const w = await world();
    await paused(w);
    const tq = await topupQuote(w);
    w.payTx = solPaymentTx(tq);
    const tx = '7'.repeat(88);
    const key = `solana:${tx}`;
    const lost = loseLeaseAfterSetBudget(w, 2000);
    await expect(topupJob(w.quote.id, { quote: tq, payTx: tx }, w.d)).rejects.toMatchObject({ status: 503 });
    expect(w.store.payments.get(key)!.credited).toBe(false);
    // the target was saved under the lease before the cap moved
    expect((await w.store.getJob(w.quote.id))!.crediting).toEqual({ paymentKey: key, targetCents: 2442, usdCents: 1000 });
    await w.store.unlease(w.quote.id, lost.thief!);
    const v = await topupJob(w.quote.id, { quote: tq, payTx: tx }, w.d);
    expect(v.budgetCents).toBe(2442); // not 2000 + 940
    expect(w.engine.budgets.map((b) => b.cents)).toEqual([2442, 2442]);
    expect(w.store.payments.get(key)!.credited).toBe(true);
    const stored = (await w.store.getJob(w.quote.id))!;
    expect(stored.crediting).toBeUndefined();
    expect(stored.payments).toEqual([expect.any(String), key]);
  });

  it('the next top-up finishes an interrupted one at its own cap, then adds itself', async () => {
    const w = await world();
    await paused(w);
    const a = await topupQuote(w);
    w.payTx = solPaymentTx(a);
    const lost = loseLeaseAfterSetBudget(w, 2000);
    await expect(topupJob(w.quote.id, { quote: a, payTx: '7'.repeat(88) }, w.d)).rejects.toMatchObject({ status: 503 });
    await w.store.unlease(w.quote.id, lost.thief!);
    // A is never retried; B arrives
    const b = await topupQuote(w, 500);
    w.payTx = solPaymentTx(b);
    const v = await topupJob(w.quote.id, { quote: b, payTx: '6'.repeat(88) }, w.d);
    expect(w.engine.budgets.map((x) => x.cents)).toEqual([2442, 2442, 2442 + 450]);
    expect(v.budgetCents).toBe(2892);
    expect(w.store.payments.get(`solana:${'7'.repeat(88)}`)!.credited).toBe(true);
    expect(w.store.payments.get(`solana:${'6'.repeat(88)}`)!.credited).toBe(true);
    expect(v.feed.filter((f) => f.text.startsWith('topped up')).map((f) => f.text)).toEqual(['topped up 10.00 USD. back to work', 'topped up 5.00 USD. back to work']);
    // and A's own retry is a no-op
    w.payTx = solPaymentTx(a);
    expect((await topupJob(w.quote.id, { quote: a, payTx: '7'.repeat(88) }, w.d)).budgetCents).toBe(2892);
    expect(w.engine.budgets).toHaveLength(3);
  });

  it('waits briefly for a busy lease, then answers 503 without losing the payment', async () => {
    const w = await world();
    await paused(w);
    const tq = await topupQuote(w);
    w.payTx = solPaymentTx(tq);
    const holder = await w.store.lease(w.quote.id, 60_000);
    await expect(topupJob(w.quote.id, { quote: tq, payTx: '7'.repeat(88) }, w.d)).rejects.toMatchObject({ status: 503 });
    expect(w.sleeps.length).toBeGreaterThan(0);
    await w.store.unlease(w.quote.id, holder!);
    expect((await topupJob(w.quote.id, { quote: tq, payTx: '7'.repeat(88) }, w.d)).budgetCents).toBe(2442);
  });

  it('never accepts the job’s own payment as a top-up', async () => {
    const w = await world();
    await paused(w);
    const tq = await topupQuote(w);
    const v = await topupJob(w.quote.id, { quote: tq, payTx: req(w).payTx }, w.d);
    expect(w.engine.budgets).toHaveLength(0);
    expect(v.budgetCents).toBe(1410);
  });
});

describe('cron sweep', () => {
  it('skips starting jobs parked in backoff, so they can’t crowd running jobs out of the sweep', async () => {
    const w = await world();
    await createJob(req(w), w.d);
    const running = (await w.store.getJob(w.quote.id))!;
    expect(running.status).toBe('running');
    // nine older paid jobs, all waiting out an upstream outage
    const parked = Array.from({ length: 9 }, (_, i): JobRecord => ({
      ...running,
      id: `q_parked${'abcdefghi'[i]}aaaaaaa`,
      createdAt: running.createdAt - (i + 1) * MIN,
      status: 'starting',
      sessionId: undefined,
      nextAttemptAt: Date.now() + 10 * MIN,
    }));
    for (const j of parked) await w.store.insertJob(j);
    const due = { ...parked[0], id: 'q_dueaaaaaaaaaaaaa', createdAt: running.createdAt - 20 * MIN, nextAttemptAt: Date.now() - 1 };
    await w.store.insertJob(due);
    expect(await w.store.activeJobIds(8, Date.now())).toEqual([due.id, running.id]);

    w.engine.snapshot = { status: 'running', spentCents: 333 };
    expect(await sweep(w.d.env, { store: w.store, engine: w.engine, fetch: w.d.fetch })).toBe(2);
    const synced = (await w.store.getJob(w.quote.id))!;
    expect(synced.syncedAt).toBeGreaterThan(0);
    expect(synced.spentCents).toBe(333);
    // the parked jobs were not touched
    for (const j of parked) expect((await w.store.getJob(j.id))!.attempts).toBe(running.attempts);
  });
});
