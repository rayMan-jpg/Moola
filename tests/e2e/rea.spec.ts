// End to end: the real UI, the real API worker code (run in-process, answering the page's API
// calls), mock wallets that sign nothing, and every transaction simulated on mainnet instead of
// broadcast. Proves the exact payment + launch transactions the UI builds would execute, and that
// the worker accepts the payment and records the token.
import { test, expect, type Page, type Route } from '@playwright/test';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { MOCK_EVM_SCRIPT, MOCK_WALLET_SCRIPT } from './mockWallet';
import { ed25519 } from '@noble/curves/ed25519.js';
import { layout, newKey, payer, signatureOf, signPayer, staticKeys, withPayer } from './txbytes';
import { handle } from '../../worker/src/index';
import { MemoryStore } from '../../worker/src/store';
import { FakeEngine } from '../unit/worker/fakeEngine';
import type { Env } from '../../worker/src/env';

const SOL_RPC = 'https://solana-rpc.publicnode.com';
const RH_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const API = 'https://api.rea4u.test';
// Big system-owned mainnet wallet: the mock wallet's address, so simulations have funds. No key.
const PAYER = process.env.SIM_PAYER ?? '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const TREASURY_SOL = '4ohMhNctr8aLPkqQoSkxtQa16PvZi1LqHeVvmPvZ66Q5';
// A rich Robinhood Chain EOA (no code) as the EVM wallet; a plain EOA as the treasury.
const EVM_USER = '0x53091256ebd2d8aa37b45536a5fd864ca764f32f';
const TREASURY_EVM = '0x307576dd4f73f91bb8c4a2edb762938e8e067d31';
const PONS_FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const STONK_PAD = '0xfcd61b25bbf3abd6cf0070d6328e351cc30eec9f';
const UTOKEN_FACTORY = '0xd03fb35ee057df5933a8a95b362cc3e11a56d4cf';

/** JSON-RPC with retries: the public Robinhood RPC rate-limits bursts (HTTP 429 / code 429). */
async function rpc(url: string, method: string, params: unknown[]) {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).catch(() => null);
    const j = r ? ((await r.json().catch(() => null)) as { result?: any; error?: { code?: number; message: string } } | null) : null;
    const limited = !j || r!.status === 429 || j.error?.code === 429 || j.error?.code === -32005;
    if (!limited || i >= 4) return j ?? { error: { message: 'rpc unreachable' } };
    await new Promise((res) => setTimeout(res, 500 * 2 ** i));
  }
}

interface Sent {
  sig: string;
  bytes: Uint8Array;
  err: unknown;
  /** balance deltas of watched keys */
  logs: string[];
}

interface World {
  prompts: number;
  signedPerPrompt: number[];
  reject: boolean;
  sol: Sent[];
  evm: { hash: string; tx: Record<string, string>; token?: string; logs: { address: string; topics: string[]; data: string }[] }[];
  api: { method: string; path: string; body: any }[];
  engine: FakeEngine;
  store: MemoryStore;
}

function env(): Env {
  return {
    DB: undefined as never,
    ANTHROPIC_API_KEY: 'sk-test',
    GITHUB_TOKEN: 'ghp_test',
    GITHUB_OWNER: 'rea4u-builds',
    QUOTE_SECRET: 'e2e-secret-e2e-secret',
    TREASURY_SOLANA: TREASURY_SOL,
    TREASURY_EVM,
    SOLANA_RPC: 'https://sol.worker.test',
    RH_RPC: 'https://rh.worker.test',
    RH_CHAIN_ID: '4663',
    SITE_URL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:4173/',
  };
}

const j = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { headers: { 'content-type': 'application/json' } });

/** The worker's outbound world: GitHub, price feeds and chain reads, answered from what the page sent. */
function workerFetch(w: World): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    if (url.includes('api.coinbase.com')) return Response.json({ data: { amount: url.includes('SOL') ? '150' : '3000' } });
    if (url.includes('api.kraken.com')) return Response.json({ error: [], result: { X: { c: [url.includes('SOL') ? '150' : '3000'] } } });
    if (url.startsWith('https://api.github.com/repos/affaan-m/')) return Response.json({ private: false, archived: false, size: 900 });
    if (url.endsWith('/users/rea4u-builds')) return Response.json({ type: 'Organization' });
    if (url.match(/\/repos\/rea4u-builds\/[^/]+$/) && method === 'GET') return new Response('{}', { status: 404 });
    if (url.endsWith('/orgs/rea4u-builds/repos')) {
      const name = (JSON.parse(String(init!.body)) as { name: string }).name;
      return Response.json({ html_url: `https://github.com/rea4u-builds/${name}`, full_name: `rea4u-builds/${name}`, default_branch: 'main' });
    }
    if (url.startsWith('https://sol.worker.test') && body?.method === 'getTransaction') {
      // Shaped like mainnet's jsonParsed getTransaction, built from the bytes the page broadcast.
      const s = w.sol.find((x) => x.sig === body.params[0]);
      if (!s || s.err !== null) return j(null);
      const { keys, signers } = staticKeys(s.bytes);
      const text = Buffer.from(s.bytes).toString('latin1');
      const memo = text.match(/rea4u:q_[a-z2-7]{16}/)?.[0];
      const instructions: unknown[] = [];
      const lamports = s.logs.find((l) => l.startsWith('transfer:'))?.split(':')[1];
      if (memo && lamports) {
        instructions.push({ programId: '11111111111111111111111111111111', program: 'system', parsed: { type: 'transfer', info: { source: bs58.encode(keys[0]), destination: TREASURY_SOL, lamports: Number(lamports) } } });
        instructions.push({ programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', program: 'spl-memo', parsed: memo });
      }
      return j({
        blockTime: Math.floor(Date.now() / 1000),
        meta: { err: null, logMessages: s.logs, innerInstructions: [] },
        transaction: { message: { instructions, accountKeys: keys.map((k, i) => ({ pubkey: bs58.encode(k), signer: i < signers })) } },
      });
    }
    if (url.startsWith('https://rh.worker.test')) {
      const h = w.evm.find((x) => x.hash === body.params[0]);
      if (body.method === 'eth_getTransactionByHash') return j(h && { from: h.tx.from, to: h.tx.to, value: h.tx.value, input: h.tx.data, chainId: '0x1237', blockNumber: '0x10' });
      if (body.method === 'eth_getTransactionReceipt') return j(h && { status: '0x1', blockNumber: '0x10', from: h.tx.from, to: h.tx.to, logs: h.logs });
      if (body.method === 'eth_getBlockByNumber') return j({ timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}` });
    }
    return new Response(JSON.stringify({ message: `not mocked ${method} ${url}` }), { status: 404 });
  }) as typeof fetch;
}

type Key = ReturnType<typeof newKey>;
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Simulates tx bytes on mainnet. With an alias key (a real throwaway wallet that holds no SOL),
 * the funded PAYER stands in as fee payer so the simulation has money.
 */
async function simulate(b64: string, alias?: Key, config: Record<string, unknown> = {}) {
  let bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  const cfg: Record<string, unknown> = { ...config, encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' };
  if (alias && sameBytes(payer(bytes), alias.publicKey)) {
    bytes = withPayer(bytes, bs58.decode(PAYER));
    const acc = cfg.accounts as { addresses: string[] } | undefined;
    if (acc) cfg.accounts = { ...acc, addresses: acc.addresses.map((a) => (a === bs58.encode(alias.publicKey) ? PAYER : a)) };
  }
  return rpc(SOL_RPC, 'simulateTransaction', [Buffer.from(bytes).toString('base64'), cfg]);
}

async function setup(page: Page, opts: { evm?: boolean; sol?: boolean; alias?: Key } = { sol: true }): Promise<World> {
  const alias = opts.alias;
  const address = alias ? bs58.encode(alias.publicKey) : PAYER;
  if (process.env.E2E_DEBUG) {
    page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));
    page.on('requestfailed', (r) => console.log('FAILED', r.method(), r.url().slice(0, 120), r.failure()?.errorText));
    page.on('response', (r) => r.status() >= 400 && console.log('HTTP', r.status(), r.url().slice(0, 120)));
  }
  const w: World = { prompts: 0, signedPerPrompt: [], reject: false, sol: [], evm: [], api: [], engine: new FakeEngine(), store: new MemoryStore() };
  const e = env();
  const wf = workerFetch(w);

  await page.route('**/config.json', (r) => r.fulfill({ json: { api: API, treasury: { solana: TREASURY_SOL, robinhood: TREASURY_EVM } } }));
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const headers = req.headers();
    const body = req.postData();
    w.api.push({ method: req.method(), path: new URL(req.url()).pathname, body: body ? JSON.parse(body) : undefined });
    const res = await handle(new Request(req.url(), { method: req.method(), headers, body: req.method() === 'GET' ? undefined : body }), e, { store: w.store, engine: w.engine, fetch: wf });
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() });
  });
  // The page's own GitHub lookup (target info line): keep it offline.
  await page.route('https://api.github.com/**', (r) => r.fulfill({ json: { stargazers_count: 1, license: { spdx_id: 'MIT' }, language: 'JavaScript' } }));
  // Don't pin test images to Arweave: answer like Turbo does.
  await page.route('https://upload.ardrive.io/**', async (route) => {
    const item = route.request().postDataBuffer()!;
    return route.fulfill({ json: { id: createHash('sha256').update(item.subarray(2, 66)).digest('base64url'), winc: '0' } });
  });

  if (opts.sol) {
    await page.exposeFunction('__mockSign', async (txs: number[][]) => {
      w.prompts++;
      w.signedPerPrompt.push(txs.length);
      if (w.reject) throw new Error('User rejected the request.');
      // No key: a stand-in signature (hash of the message) so each tx gets a distinct id.
      // Mainnet simulation runs with sigVerify=false.
      if (alias) return txs.map((t) => Array.from(signPayer(Uint8Array.from(t), alias.secretKey)));
      return txs.map((t) => {
        const b = Uint8Array.from(t);
        const { sigStart, msgStart } = layout(b);
        b.set(createHash('sha512').update(b.subarray(msgStart)).digest(), sigStart);
        return Array.from(b);
      });
    });
    await page.exposeFunction('__mockSignMessage', async (m: number[]) => {
      w.prompts++;
      if (w.reject) throw new Error('User rejected the request.');
      return Array.from(alias ? ed25519.sign(Uint8Array.from(m), alias.secretKey) : new Uint8Array(64));
    });
    await page.exposeFunction('__mockSend', async () => {
      throw new Error('signAndSend should not be used when signTransaction exists');
    });
    await page.addInitScript(MOCK_WALLET_SCRIPT, { address, publicKey: Array.from(bs58.decode(address)) });
    // Jupiter broadcasts whatever is posted to /submit: simulate it instead.
    await page.route('https://api.jup.ag/studio/v1/dbc-pool/submit', async (route) => {
      const form = route.request().postData() ?? '';
      const b64 = form.match(/name="transaction"\r\n\r\n([A-Za-z0-9+/=]+)/)?.[1] ?? '';
      const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
      const sim = await simulate(b64, alias);
      w.sol.push({ sig: bs58.encode(signatureOf(bytes)), bytes, err: sim.result ? sim.result.value.err : (sim.error ?? 'no result'), logs: sim.result?.value?.logs ?? [] });
      return route.fulfill({ json: { success: true, data: { mint: 'from-create-tx' } } });
    });
    // Broadcasting becomes a mainnet simulation of the exact bytes the wallet returned.
    await page.route(`${SOL_RPC}/**`, async (route: Route) => {
      const b = route.request().postDataJSON() as { method: string; params: unknown[]; id: number };
      if (b?.method === 'sendTransaction') {
        const [b64] = b.params as [string];
        const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
        const sig = bs58.encode(signatureOf(bytes));
        if (!w.sol.some((s) => s.sig === sig)) {
          const sim = await simulate(b64, alias, { accounts: { encoding: 'base64', addresses: [TREASURY_SOL] } });
          const v = sim.result?.value;
          const logs: string[] = [...(v?.logs ?? [])];
          const keys = staticKeys(bytes).keys.map((k) => bs58.encode(k));
          const ti = keys.indexOf(TREASURY_SOL);
          if (ti >= 0 && v?.postBalances) logs.push(`transfer:${v.postBalances[ti] - v.preBalances[ti]}`);
          else if (ti >= 0 && v?.accounts?.[0]) {
            const before = (await rpc(SOL_RPC, 'getBalance', [TREASURY_SOL])).result?.value ?? 0;
            logs.push(`transfer:${v.accounts[0].lamports - before}`);
          }
          w.sol.push({ sig, bytes, err: v ? v.err : (sim.error ?? 'no result'), logs });
        }
        return route.fulfill({ json: { jsonrpc: '2.0', id: b.id, result: sig } });
      }
      if (b?.method === 'getSignatureStatuses') {
        const s = w.sol.find((x) => x.sig === (b.params[0] as string[])[0]);
        const value = s ? [s.err === null ? { confirmationStatus: 'confirmed', err: null } : { confirmationStatus: 'processed', err: { sim: 'failed' } }] : [null];
        return route.fulfill({ json: { jsonrpc: '2.0', id: b.id, result: { context: { slot: 1 }, value } } });
      }
      if (alias && b?.method === 'simulateTransaction') {
        const [b64, cfg] = b.params as [string, Record<string, unknown>];
        return route.fulfill({ json: { ...(await simulate(b64, alias, cfg)), jsonrpc: '2.0', id: b.id } });
      }
      if (alias && b?.method === 'getBalance' && (b.params as string[])[0] === address) {
        return route.fulfill({ json: { jsonrpc: '2.0', id: b.id, result: { context: { slot: 1 }, value: 10e9 } } });
      }
      const real = await rpc(SOL_RPC, b.method, b.params);
      return route.fulfill({ json: { ...real, jsonrpc: '2.0', id: b.id } });
    });
  }

  if (opts.evm) {
    await page.exposeFunction('__mockEvmSend', async (tx: Record<string, string>) => {
      w.prompts++;
      if (w.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      // Replay everything this wallet "sent" before, in one simulated block, so follow-up txs
      // (StonkLauncher's approve + arm) see the token the earlier tx created.
      const calls = [...w.evm.map((e) => e.tx), tx].map((t) => ({ from: t.from, to: t.to, data: t.data, value: t.value ?? '0x0' }));
      const sim = await rpc(RH_RPC, 'eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']);
      const last = sim.result?.[0]?.calls?.at(-1) as { status: string; returnData: string; error?: unknown } | undefined;
      if (process.env.E2E_DEBUG) console.log('EVM SIM', tx.data.slice(0, 10), JSON.stringify(last ?? sim).slice(0, 400));
      if (!last || last.status !== '0x1') throw new Error(`simulation reverted: ${JSON.stringify(last?.error ?? sim.error)}`);
      const hash = `0x${createHash('sha256').update(JSON.stringify(tx) + w.evm.length).digest('hex')}`;
      // The receipt carries the real logs the simulation produced (TokenLaunched, LaunchCreated, LaunchArmed...).
      const logs = ((last as unknown as { logs?: { address: string; topics: string[]; data: string }[] }).logs ?? []).map((l) => ({ address: l.address, topics: l.topics, data: l.data }));
      const rec: World['evm'][number] = { hash, tx, logs };
      const word = (i: number) => last.returnData.slice(2 + 64 * i, 2 + 64 * (i + 1));
      const to = tx.to.toLowerCase();
      if (to === PONS_FACTORY) rec.token = `0x${word(0).slice(24)}`;
      else if (to === STONK_PAD && tx.data.startsWith('0x6cb0ea4e')) rec.token = `0x${word(1).slice(24)}`;
      else if (to === UTOKEN_FACTORY) rec.token = `0x${word(1).slice(24)}`;
      w.evm.push(rec);
      return hash;
    });
    await page.addInitScript(MOCK_EVM_SCRIPT, { address: EVM_USER });
    await page.route(`${RH_RPC}/**`, async (route: Route) => {
      const b = route.request().postDataJSON() as { method: string; params: unknown[]; id: number };
      const sent = w.evm.find((x) => x.hash === (b.params?.[0] as string));
      if (b.method === 'eth_getTransactionReceipt' && sent) {
        return route.fulfill({ json: { jsonrpc: '2.0', id: b.id, result: { status: '0x1', blockNumber: '0x10', logs: sent.logs } } });
      }
      const real = await rpc(RH_RPC, b.method, b.params);
      return route.fulfill({ json: { ...real, jsonrpc: '2.0', id: b.id } });
    });
  }
  return w;
}

async function fillOrder(page: Page, o: { target?: string; tier?: RegExp; pad: RegExp; name?: string; ticker?: string }) {
  await page.goto('./');
  await expect(page.locator('#engine-banner')).toBeHidden();
  if (o.target) await page.fill('#target', o.target);
  if (o.tier) await page.getByRole('radio', { name: o.tier }).click();
  if (o.name) await page.fill('#name', o.name);
  if (o.ticker) await page.fill('#ticker', o.ticker);
  await page.locator('#pads').getByRole('radio', { name: o.pad }).click();
}

test('engine offline: nothing can be paid, form still works', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#engine-banner')).toBeVisible();
  await expect(page.locator('#rea-it')).toHaveText('ENGINE OFFLINE');
  await expect(page.locator('#target')).toHaveValue('affaan-m/ECC');
  await expect(page.locator('#name')).not.toHaveValue('');
  await page.locator('#rea-it').click();
  await expect(page.locator('#order-msg')).toContainText('not connected');
  await expect(page.locator('#modal')).toBeHidden();
});

test('solana order on pump.fun: ONE prompt signs payment + launch, worker verifies, token recorded', async ({ page }) => {
  const w = await setup(page);
  await fillOrder(page, { tier: /^Lite/, pad: /pump\.fun/, name: 'Agent Forge', ticker: 'FORGE' });
  await expect(page.locator('#summary')).toContainText('$5');
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });

  expect(w.prompts).toBe(1);
  expect(w.signedPerPrompt).toEqual([2]);
  // payment first, then launch; both simulate cleanly on mainnet
  expect(w.sol).toHaveLength(2);
  expect(w.sol.map((s) => s.err)).toEqual([null, null]);
  expect(w.sol[0].logs.some((l) => /Memo \(len 24\): "rea4u:q_[a-z2-7]{16}"/.test(l))).toBe(true);
  const id = page.url().split('/p/')[1];
  const job = await w.store.getJob(id);
  expect(job).toMatchObject({ status: 'running', payer: PAYER, budgetCents: 450, payTx: w.sol[0].sig }); // $5 minus the 50c reserve
  expect(w.sol[0].logs).toContain(`transfer:${job!.quote.amount}`);
  expect(job!.token).toMatchObject({ status: 'live', ticker: 'FORGE', pad: 'pump' });
  expect(job!.token.url).toMatch(/^https:\/\/pump\.fun\/coin\//);
  expect(w.engine.sessions[0]).toMatchObject({ budgetCents: 450, effort: 'medium' });

  // the project page shows the live job
  await expect(page.locator('#p-title')).toHaveText('Agent Forge');
  await expect(page.locator('.badge')).toHaveText('REA-ING');
  await expect(page.locator('.token')).toContainText('$FORGE is live');
  await expect(page.locator('.feed')).toContainText('engine started');
  await expect(page.locator('.repo a').first()).toHaveAttribute('href', /github\.com\/rea4u-builds\/agent-forge-/);
});

for (const [pad, prompts, url] of [
  ['Jupiter Studio', 2, /^https:\/\/jup\.ag\/tokens\//],
  ['Bonk.fun', 1, /^https:\/\/bonk\.fun\/token\//],
] as const) {
  test(`solana order on ${pad}: payment + launch signed together, both simulate OK`, async ({ page }) => {
    // Jupiter verifies the sign-in signature server-side, so that wallet needs a real (throwaway) key.
    const w = await setup(page, pad === 'Jupiter Studio' ? { sol: true, alias: newKey() } : { sol: true });
    await fillOrder(page, { pad: new RegExp(pad.replace('.', '\\.')), name: 'Agent Forge', ticker: 'FORGE' });
    await page.locator('#rea-it').click();
    await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 150_000 });
    expect(w.prompts).toBe(prompts); // Jupiter adds its sign-in message
    expect(w.signedPerPrompt).toEqual([2]);
    expect(w.sol.map((s) => s.err)).toEqual([null, null]);
    const job = await w.store.getJob(page.url().split('/p/')[1]);
    expect(job!.token.status).toBe('live');
    expect(job!.token.url).toMatch(url);
  });
}

test('robinhood chain order on Pons: pay, then launch, simulated on the live chain', async ({ page }) => {
  const w = await setup(page, { evm: true });
  await fillOrder(page, { pad: /Pons/, name: 'Agent Forge', ticker: 'FORGE' });
  await expect(page.locator('#summary')).toContainText('paid in ETH');
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  expect(w.prompts).toBe(2);
  expect(w.evm[0].tx.to.toLowerCase()).toBe(TREASURY_EVM);
  expect(Buffer.from(w.evm[0].tx.data.slice(2), 'hex').toString()).toMatch(/^rea4u:q_[a-z2-7]{16}$/);
  expect(w.evm[1].tx.to.toLowerCase()).toBe('0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');
  const id = page.url().split('/p/')[1];
  const job = await w.store.getJob(id);
  expect(job).toMatchObject({ status: 'running', payer: EVM_USER, budgetCents: 1410 });
  expect(job!.quote.payer).toBe(EVM_USER);
  expect(job!.token).toMatchObject({ status: 'live', pad: 'pons', mint: w.evm[1].token });
  expect(job!.token.url).toBe(`https://ponsfamily.com/launchpad/${w.evm[1].token}`);
  await expect(page.locator('.token')).toContainText('$FORGE is live');
});

test('robinhood chain order on StonkLauncher: pay, create, approve, arm', async ({ page }) => {
  const w = await setup(page, { evm: true });
  await fillOrder(page, { pad: /StonkLauncher/, name: 'Agent Forge', ticker: 'FORGE' });
  await expect(page.locator('#summary')).toContainText('4 wallet prompts');
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  expect(w.prompts).toBe(4);
  expect(w.evm.map((e) => e.tx.data.slice(0, 10))).toEqual([expect.stringMatching(/^0x7265/), '0x6cb0ea4e', '0x095ea7b3', '0x92040b44']);
  const job = await w.store.getJob(page.url().split('/p/')[1]);
  expect(job!.token).toMatchObject({ status: 'live', pad: 'stonk', mint: w.evm[1].token });
  expect(job!.token.url).toMatch(/^https:\/\/stonkbrokers\.io\/safe-launch\/token\/weth2-forge-\d+$/);
  await expect(page.locator('.token')).toContainText('$FORGE is live');
});

test('robinhood chain order on µToken (the launchpad behind stonk.broker): pay, then one launch tx', async ({ page }) => {
  const w = await setup(page, { evm: true });
  await fillOrder(page, { pad: /µToken/, name: 'Agent Forge', ticker: 'FORGE' });
  await expect(page.locator('#summary')).toContainText('2 wallet prompts');
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  expect(w.prompts).toBe(2);
  expect(w.evm[1].tx.to.toLowerCase()).toBe(UTOKEN_FACTORY);
  const job = await w.store.getJob(page.url().split('/p/')[1]);
  expect(job!.token).toMatchObject({ status: 'live', pad: 'utoken', mint: w.evm[1].token, url: `https://utoken.gg/token/${w.evm[1].token}` });
});

test('rejecting the wallet prompt pays nothing and starts nothing', async ({ page }) => {
  const w = await setup(page);
  w.reject = true;
  await fillOrder(page, { pad: /pump\.fun/ });
  await page.locator('#rea-it').click();
  await expect(page.locator('#order-msg')).toContainText('rejected', { timeout: 90_000 });
  expect(w.sol).toHaveLength(0);
  expect(w.api.filter((a) => a.path === '/api/jobs')).toHaveLength(0);
  await expect(page.locator('#rea-it')).toBeEnabled();
});

test("brand reuse and bad targets are stopped before any prompt", async ({ page }) => {
  const w = await setup(page);
  await fillOrder(page, { pad: /pump\.fun/, name: 'ECC Turbo', ticker: 'TURBO' });
  await page.locator('#rea-it').click();
  await expect(page.locator('#name-err')).toContainText('ecc');
  await page.fill('#name', 'Agent Forge');
  await page.fill('#ticker', 'ECC');
  await page.locator('#rea-it').click();
  await expect(page.locator('#ticker-err')).toContainText('ecc');
  await page.fill('#target', 'localhost:3000');
  await page.locator('#rea-it').click();
  await expect(page.locator('#target-err')).toContainText('public');
  expect(w.prompts).toBe(0);
});

test('project page: paused job offers top-ups, finished job shows spec + ranked hosting', async ({ page }) => {
  const w = await setup(page);
  await fillOrder(page, { pad: /pump\.fun/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\//, { timeout: 120_000 });
  const id = page.url().split('/p/')[1];

  w.engine.snapshot = { status: 'idle', spentCents: 1503 };
  w.engine.events = [{ id: 'e1', type: 'session.status_idle', at: new Date().toISOString(), stopReason: 'budget_reached' }];
  const j = (await w.store.getJob(id))!;
  j.syncedAt = 0;
  await w.store.putJob(j);
  await page.reload();
  await expect(page.locator('.badge')).toHaveText('OUT OF BUDGET');
  await expect(page.locator('.topup')).toContainText('Top up');
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/project-paused-${test.info().project.name}.png` });

  w.engine.snapshot = { status: 'idle', spentCents: 1400, outcome: { result: 'satisfied', explanation: 'ok', iteration: 1 } };
  w.engine.events = [{ id: 'e2', type: 'session.status_idle', at: new Date().toISOString(), stopReason: 'end_turn' }];
  w.engine.outputs = [
    {
      id: 'f1',
      filename: 'rea4u.json',
      createdAt: 't',
      text: JSON.stringify({
        status: 'complete',
        project: 'Agent Forge',
        summary: 'A rebranded agent harness with a web dashboard.',
        target: { url: 'https://github.com/affaan-m/ECC', license: 'MIT', approach: 'fork' },
        stack: ['node', 'postgres'],
        kind: 'server',
        needs: { server: true, database: 'postgres', websockets: false, cron: false, storage: false, env: ['DATABASE_URL'] },
        build: { install: 'npm ci', build: 'npm run build', start: 'npm start', port: 3000 },
        features: [{ name: 'Browse agents', status: 'done' }, { name: 'Run agents', status: 'partial' }],
        verified: { build: true, tests: '12 passed', smoke: true },
        deploy: { dockerfile: true, files: ['render.yaml'] },
      }),
    },
    { id: 'f2', filename: 'SPEC.md', createdAt: 't', text: '# Agent Forge\n\n## Features\n\n| Feature | Status |\n| --- | --- |\n| Browse | done |\n\n<script>alert(1)</script>' },
  ];
  const j2 = (await w.store.getJob(id))!;
  j2.syncedAt = 0;
  j2.status = 'running';
  await w.store.putJob(j2);
  await page.reload();
  await expect(page.locator('.badge')).toHaveText('DONE');
  await expect(page.locator('.manifest')).toContainText('1/2 features done');
  await expect(page.locator('.host--best')).toContainText('Render');
  await expect(page.locator('.host--best a.btn')).toHaveAttribute('href', /render\.com\/deploy\?repo=/);
  await expect(page.locator('.host--best')).toContainText('own a copy first');
  await expect(page.locator('.md table')).toContainText('Browse');
  await expect(page.locator('.md')).toContainText('<script>alert(1)</script>');
  expect(await page.locator('.md script').count()).toBe(0);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/project-done-${test.info().project.name}.png`, fullPage: true });
});
