// @vitest-environment node
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { outcomeEvent } from '../../../engine/task';
import { parseTarget } from '../../../shared/contract';
import { agentConfig, allowedHosts, anthropicEngine, ensureAgent } from '../../../worker/src/engine';
import { handle } from '../../../worker/src/index';
import { MemoryStore } from '../../../worker/src/store';
import { FakeEngine, mockFetch, PRICES, testEnv } from './helpers';

function sdk(routes: Parameters<typeof mockFetch>[0]) {
  const m = mockFetch(routes);
  const headers: Record<string, string>[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
    return m.fetch(input, init);
  }) as typeof fetch;
  const client = new Anthropic({ apiKey: 'sk-test', fetch: f, maxRetries: 0 });
  return { api: anthropicEngine(client), calls: m.calls, headers };
}

describe('Managed Agents adapter (real SDK, mocked HTTP)', () => {
  it('creates sessions with a hard budget, both repos, the outcome and per-tier effort', async () => {
    const { api, calls, headers } = sdk([['POST', /\/v1\/sessions/, () => ({ id: 'sesn_1', type: 'session' })]]);
    const target = parseTarget('affaan-m/ECC');
    const outcome = outcomeEvent({ jobId: 'q_aaaaaaaaaaaaaaaa', target, tier: 'lite', projectName: 'Forge', tokenName: 'Forge', tokenTicker: 'FRG' });
    const id = await api.createSession({
      agentId: 'agent_1',
      agentVersion: 3,
      model: 'claude-opus-5-5',
      effort: 'medium',
      environmentId: 'env_1',
      title: 't',
      budgetCents: 500,
      buildRepo: { url: 'https://github.com/rea4u-builds/forge-aaaaaa', branch: 'main', token: 'ghp_x' },
      engineRepo: { url: 'https://github.com/rayman-jpg/Moola', branch: 'b' },
      metadata: { rea4u_job: 'q_aaaaaaaaaaaaaaaa' },
      outcome,
    });
    expect(id).toBe('sesn_1');
    const body = calls[0].body as Record<string, unknown>;
    expect(calls[0].url).toMatch(/\/v1\/sessions\?beta=true$/);
    expect(headers[0]['anthropic-beta']).toContain('managed-agents-2026-04-01');
    expect(body.agent).toEqual({ type: 'agent_with_overrides', id: 'agent_1', version: 3, model: { id: 'claude-opus-5-5', effort: 'medium' } });
    expect(body.budget).toEqual({ type: 'limit', max_list_cost: { amount: '500', currency: 'USD' } });
    expect(body.environment_id).toBe('env_1');
    const resources = body.resources as Record<string, unknown>[];
    expect(resources[0]).toMatchObject({ type: 'github_repository', authorization_token: 'ghp_x', mount_path: '/workspace/build' });
    expect(resources[1]).toMatchObject({ type: 'github_repository', mount_path: '/workspace/rea4u' });
    expect(resources[1]).not.toHaveProperty('authorization_token');
    expect(body.initial_events).toEqual([outcome]);
    expect((body.initial_events as { max_iterations: number }[])[0].max_iterations).toBe(2);
  });

  it('locks each job environment down to GitHub plus the target site', async () => {
    const { api, calls } = sdk([['POST', /\/v1\/environments/, () => ({ id: 'env_9' })]]);
    const hosts = allowedHosts(parseTarget('https://app.example.co.uk/x'));
    expect(hosts).toEqual(expect.arrayContaining(['github.com', 'app.example.co.uk', 'example.co.uk', '*.example.co.uk']));
    expect(await api.createEnvironment('rea4u-q', hosts)).toBe('env_9');
    expect(calls[0].body).toMatchObject({
      name: 'rea4u-q',
      config: { type: 'cloud', networking: { type: 'limited', allow_package_managers: true, allow_mcp_servers: false, allowed_hosts: hosts } },
    });
  });

  it('reads cost, outcome and events, and raises budgets', async () => {
    const { api, calls } = sdk([
      [
        'GET',
        /\/v1\/sessions\/sesn_1\/events/,
        () => ({
          data: [
            { id: 'e2', type: 'session.status_idle', processed_at: 't2', stop_reason: { type: 'budget_reached' } },
            { id: 'e1', type: 'agent.message', processed_at: 't1', content: [{ type: 'text', text: 'hello' }] },
          ],
          next_page: null,
        }),
      ],
      [
        'GET',
        /\/v1\/sessions\/sesn_1\?beta=true$/,
        () => ({
          id: 'sesn_1',
          status: 'idle',
          usage: { list_cost: { amount: '1234', currency: 'USD' } },
          outcome_evaluations: [{ outcome_id: 'o', result: 'running', explanation: null, iteration: 0 }],
        }),
      ],
      ['POST', /\/v1\/sessions\/sesn_1\?beta=true$/, () => ({ id: 'sesn_1' })],
    ]);
    expect(await api.retrieveSession('sesn_1')).toEqual({ status: 'idle', spentCents: 1234, outcome: { result: 'running', explanation: null, iteration: 0 } });
    const ev = await api.recentEvents('sesn_1', 30);
    expect(ev[0]).toMatchObject({ type: 'session.status_idle', stopReason: 'budget_reached' });
    expect(ev[1]).toMatchObject({ type: 'agent.message', text: 'hello' });
    expect(calls.find((c) => c.url.includes('/events'))!.url).toMatch(/order=desc/);
    await api.setBudget('sesn_1', 2500);
    expect(calls.at(-1)!.body).toEqual({ budget: { type: 'limit', max_list_cost: { amount: '2500', currency: 'USD' } } });
  });

  it('lists session outputs with the managed-agents beta and downloads them', async () => {
    const { api, headers, calls } = sdk([
      ['GET', /\/v1\/files\/file_1\/content/, () => new Response('{"status":"partial"}')],
      ['GET', /\/v1\/files/, () => ({ data: [{ id: 'file_1', filename: 'rea4u.json', created_at: 't', size_bytes: 20 }], has_more: false })],
    ]);
    expect(await api.listOutputs('sesn_1')).toEqual([{ id: 'file_1', filename: 'rea4u.json', createdAt: 't' }]);
    expect(calls[0].url).toMatch(/scope_id=sesn_1/);
    expect(headers[0]['anthropic-beta']).toContain('managed-agents-2026-04-01');
    expect(await api.downloadText('file_1', 1000)).toBe('{"status":"partial"}');
  });

  it('creates the agent once and only updates it when the config changes', async () => {
    const engine = new FakeEngine();
    const store = new MemoryStore();
    const a = await ensureAgent(engine, store, 'claude-opus-5-5');
    const b = await ensureAgent(engine, store, 'claude-opus-5-5');
    expect(a).toEqual(b);
    expect(engine.agents).toHaveLength(1);
    // A fresh worker (empty cache) finds the existing agent instead of creating another
    const c = await ensureAgent(engine, new MemoryStore(), 'claude-opus-5-5');
    expect(c.id).toBe(a.id);
    expect(engine.agents).toHaveLength(1);
    // Model change -> update in place, new version
    const d = await ensureAgent(engine, store, 'claude-sonnet-5-5');
    expect(d).toEqual({ id: a.id, version: 2 });
    expect(agentConfig('m').tools?.[0]).toMatchObject({ default_config: { permission_policy: { type: 'always_allow' } } });
  });
});

describe('router', () => {
  const env = testEnv();
  const store = new MemoryStore();
  const engine = new FakeEngine();

  it('serves config with CORS for the site origin only', async () => {
    const ok = await handle(new Request('https://api.test/api/config', { headers: { origin: 'https://rea4u.test' } }), env, { store, engine });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://rea4u.test');
    expect(await ok.json()).toMatchObject({ ok: true, chains: ['solana', 'robinhood'], evmChainId: 4663 });
    const evil = await handle(new Request('https://api.test/api/config', { headers: { origin: 'https://evil.test' } }), env, { store, engine });
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await handle(new Request('https://api.test/api/quote', { method: 'OPTIONS', headers: { origin: 'https://rea4u.test' } }), env, { store, engine });
    expect(pre.status).toBe(204);
  });

  it('reports missing secrets and refuses work until configured', async () => {
    const bare = testEnv({ ANTHROPIC_API_KEY: '', TREASURY_SOLANA: undefined, TREASURY_EVM: undefined });
    const cfg = await (await handle(new Request('https://api.test/api/config'), bare)).json();
    expect(cfg).toMatchObject({ ok: false, missing: ['ANTHROPIC_API_KEY', 'TREASURY_SOLANA or TREASURY_EVM'] });
    const q = await handle(new Request('https://api.test/api/quote', { method: 'POST', body: '{}' }), bare);
    expect(q.status).toBe(503);
  });

  it('quotes over HTTP and maps errors to status codes', async () => {
    const { fetch } = mockFetch([
      ['GET', /api\.github\.com\/repos\/affaan-m\/ECC$/, () => ({ private: false, archived: false, size: 1 })],
      PRICES.coinbase('SOL', 200),
      PRICES.kraken('SOLUSD', 200),
    ]);
    const r = await handle(
      new Request('https://api.test/api/quote', { method: 'POST', body: JSON.stringify({ target: 'affaan-m/ECC', tier: 'deep', chain: 'solana' }) }),
      env,
      { store, engine, fetch },
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as { quote: { amount: string } }).quote.amount).toBe('200000000');
    const bad = await handle(new Request('https://api.test/api/jobs/q_zzzzzzzzzzzzzzzz'), env, { store, engine, fetch });
    expect(bad.status).toBe(404);
    const junk = await handle(new Request('https://api.test/api/jobs', { method: 'POST', body: 'nope' }), env, { store, engine, fetch });
    expect(junk.status).toBe(400);
  });
});
