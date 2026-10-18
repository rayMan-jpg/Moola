// End to end: the real UI, the real API worker code (run in-process, answering the page's API
// calls), mock wallets that sign nothing, and every transaction simulated on mainnet instead of
// broadcast. Proves the exact payment + launch transactions the UI builds would execute, and that
// the worker accepts the payment and records the token.
import { test, expect, type Page, type Route } from '@playwright/test';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { MOCK_EVM_SCRIPT, MOCK_WALLET_SCRIPT } from './mockWallet';
import { ed25519 } from '@noble/curves/ed25519.js';
import { layout, newKey, payer, programIds, signatureOf, signPayer, staticKeys, withPayer } from './txbytes';
import { encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { handle } from '../../worker/src/index';
import { MemoryStore } from '../../worker/src/store';
import { FakeEngine } from '../unit/worker/fakeEngine';
import type { Env } from '../../worker/src/env';
import type { Quote } from '../../shared/contract';

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
  /** Signers the simulation left owned by a token program: mints this tx initialized. */
  mints?: { mint: string; program: string }[];
}

const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

interface World {
  prompts: number;
  signedPerPrompt: number[];
  reject: boolean;
  /** Reject only the Nth wallet prompt (1-based); 0 = off. */
  rejectAt: number;
  /** EVM personal_sign prompts (claim signatures). */
  signs: number;
  sol: Sent[];
  evm: { hash: string; tx: Record<string, string>; token?: string; logs: { address: string; topics: string[]; data: string }[] }[];
  api: { method: string; path: string; body: any; status?: number }[];
  /** The API answers 503 to these POSTs without running the worker (engine unreachable). */
  hold: { jobs: boolean; topup: boolean };
  /** The EVM wallet drops the payment's calldata (some wallets strip data from plain sends). */
  stripPayData: boolean;
  /** The page's own RPC can't see sent EVM txs yet (only receipts). */
  hideTxFromPage: boolean;
  /** EVM txs whose receipt the page's RPC can't read yet (pending, or a flaky node). The worker sees them. */
  hiddenReceipts: Set<string>;
  /** EVM txs that were mined but reverted: every receipt says status 0x0. */
  reverted: Set<string>;
  /** A tx whose simulation reverts is mined as reverted instead of refused by the wallet. */
  mineReverts: boolean;
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
      } else {
        // A launch: its programs, unparsed, as mainnet returns instructions it can't decode.
        for (const prog of programIds(s.bytes)) instructions.push({ programId: bs58.encode(prog), accounts: [], data: '' });
      }
      // The token program's CPIs, parsed as mainnet does: the mints this tx initialized.
      const minted = (s.mints ?? []).map((m) => ({ programId: m.program, program: 'spl-token', parsed: { type: 'initializeMint2', info: { mint: m.mint } } }));
      return j({
        blockTime: Math.floor(Date.now() / 1000),
        meta: { err: null, logMessages: s.logs, innerInstructions: minted.length ? [{ index: 0, instructions: minted }] : [] },
        transaction: { message: { instructions, accountKeys: keys.map((k, i) => ({ pubkey: bs58.encode(k), signer: i < signers })) } },
      });
    }
    if (url.startsWith('https://rh.worker.test')) {
      const h = w.evm.find((x) => x.hash === body.params[0]);
      if (body.method === 'eth_getTransactionByHash') return j(h && { from: h.tx.from, to: h.tx.to, value: h.tx.value, input: h.tx.data, chainId: '0x1237', blockNumber: '0x10' });
      if (body.method === 'eth_getTransactionReceipt') return j(h && { status: w.reverted.has(h.hash) ? '0x0' : '0x1', blockNumber: '0x10', from: h.tx.from, to: h.tx.to, logs: h.logs });
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

/** Simulates a launch or payment, watching its signers: the ones a token program owns afterwards are mints it created. */
async function simulateSent(b64: string, alias: Key | undefined, watch: string[] = []) {
  const { keys, signers } = staticKeys(new Uint8Array(Buffer.from(b64, 'base64')));
  const extra = keys.slice(1, signers).map((k) => bs58.encode(k));
  const sim = await simulate(b64, alias, { accounts: { encoding: 'base64', addresses: [...watch, ...extra] } });
  const accounts = (sim.result?.value?.accounts ?? []) as ({ owner: string } | null)[];
  const mints = extra.flatMap((mint, i) => {
    const owner = accounts[watch.length + i]?.owner;
    return owner && TOKEN_PROGRAMS.includes(owner) ? [{ mint, program: owner }] : [];
  });
  return { sim, mints };
}

/** The site config, the API (the real worker code, in-process) and offline stand-ins for GitHub and Arweave. */
async function routeApi(page: Page, w: World) {
  const e = env();
  const wf = workerFetch(w);
  await page.route('**/config.json', (r) => r.fulfill({ json: { api: API, treasury: { solana: TREASURY_SOL, robinhood: TREASURY_EVM } } }));
  await page.route(`${API}/**`, async (route: Route) => {
    const req = route.request();
    const headers = req.headers();
    const body = req.postData();
    const path = new URL(req.url()).pathname;
    const entry: World['api'][number] = { method: req.method(), path, body: body ? JSON.parse(body) : undefined };
    w.api.push(entry);
    const held = req.method() === 'POST' && ((w.hold.jobs && path === '/api/jobs') || (w.hold.topup && path.endsWith('/topup')));
    if (held) {
      entry.status = 503;
      return route.fulfill({ status: 503, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: 'engine unreachable' }) });
    }
    const res = await handle(new Request(req.url(), { method: req.method(), headers, body: req.method() === 'GET' ? undefined : body }), e, { store: w.store, engine: w.engine, fetch: wf });
    entry.status = res.status;
    return route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: await res.text() });
  });
  // The page's own GitHub lookup (target info line): keep it offline.
  await page.route('https://api.github.com/**', (r) => r.fulfill({ json: { stargazers_count: 1, license: { spdx_id: 'MIT' }, language: 'JavaScript' } }));
  // Don't pin test images to Arweave: answer like Turbo does.
  await page.route('https://upload.ardrive.io/**', async (route) => {
    const item = route.request().postDataBuffer()!;
    return route.fulfill({ json: { id: createHash('sha256').update(item.subarray(2, 66)).digest('base64url'), winc: '0' } });
  });
}

/**
 * opts.evmKey: the EVM wallet is a throwaway key (so it can personal_sign for real). It holds no ETH,
 * so the funded EVM_USER stands in for it in every simulation and balance read.
 */
async function setup(page: Page, opts: { evm?: boolean; sol?: boolean; alias?: Key; evmKey?: `0x${string}` } = { sol: true }): Promise<World> {
  const alias = opts.alias;
  const address = alias ? bs58.encode(alias.publicKey) : PAYER;
  if (process.env.E2E_DEBUG) {
    page.on('console', (m) => console.log('CONSOLE', m.type(), m.text().slice(0, 300)));
    page.on('requestfailed', (r) => console.log('FAILED', r.method(), r.url().slice(0, 120), r.failure()?.errorText));
    page.on('response', (r) => r.status() >= 400 && console.log('HTTP', r.status(), r.url().slice(0, 120)));
  }
  const w: World = {
    prompts: 0,
    signedPerPrompt: [],
    reject: false,
    rejectAt: 0,
    signs: 0,
    sol: [],
    evm: [],
    api: [],
    hold: { jobs: false, topup: false },
    stripPayData: false,
    hideTxFromPage: false,
    hiddenReceipts: new Set(),
    reverted: new Set(),
    mineReverts: false,
    engine: new FakeEngine(),
    store: new MemoryStore(),
  };
  await routeApi(page, w);

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
      const { sim, mints } = await simulateSent(b64, alias);
      w.sol.push({ sig: bs58.encode(signatureOf(bytes)), bytes, err: sim.result ? sim.result.value.err : (sim.error ?? 'no result'), logs: sim.result?.value?.logs ?? [], mints });
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
          const { sim, mints } = await simulateSent(b64, alias, [TREASURY_SOL]);
          const v = sim.result?.value;
          const logs: string[] = [...(v?.logs ?? [])];
          const keys = staticKeys(bytes).keys.map((k) => bs58.encode(k));
          const ti = keys.indexOf(TREASURY_SOL);
          if (ti >= 0 && v?.postBalances) logs.push(`transfer:${v.postBalances[ti] - v.preBalances[ti]}`);
          else if (ti >= 0 && v?.accounts?.[0]) {
            const before = (await rpc(SOL_RPC, 'getBalance', [TREASURY_SOL])).result?.value ?? 0;
            logs.push(`transfer:${v.accounts[0].lamports - before}`);
          }
          w.sol.push({ sig, bytes, err: v ? v.err : (sim.error ?? 'no result'), logs, mints });
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
    const account = opts.evmKey ? privateKeyToAccount(opts.evmKey) : null;
    const evmAddress = account ? account.address.toLowerCase() : EVM_USER;
    // Everything the chain sees from the throwaway key runs as the funded EVM_USER instead.
    const funded = (x: string) => (account ? x.replace(new RegExp(evmAddress.slice(2), 'gi'), EVM_USER.slice(2)) : x);
    await page.exposeFunction('__mockEvmSign', async (messageHex: string, from: string) => {
      w.signs++;
      if (w.reject) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      if (!account || from.toLowerCase() !== evmAddress) throw new Error('mock evm wallet: no key for personal_sign');
      return account.signMessage({ message: { raw: messageHex as `0x${string}` } });
    });
    await page.exposeFunction('__mockEvmSend', async (sent: Record<string, string>) => {
      w.prompts++;
      if (w.reject || w.prompts === w.rejectAt) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      const tx = w.stripPayData && sent.to.toLowerCase() === TREASURY_EVM ? { ...sent, data: '0x' } : sent;
      // Replay everything this wallet "sent" before, in one simulated block, so follow-up txs
      // (StonkLauncher's approve + arm) see the token the earlier tx created.
      const calls = [...w.evm.filter((e) => !w.reverted.has(e.hash)).map((e) => e.tx), tx].map((t) => ({ from: funded(t.from), to: t.to, data: funded(t.data), value: t.value ?? '0x0' }));
      const sim = await rpc(RH_RPC, 'eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']);
      const last = sim.result?.[0]?.calls?.at(-1) as { status: string; returnData: string; error?: unknown } | undefined;
      if (process.env.E2E_DEBUG) console.log('EVM SIM', tx.data.slice(0, 10), JSON.stringify(last ?? sim).slice(0, 400));
      const reverts = !last || last.status !== '0x1';
      if (reverts && !(w.mineReverts && last)) throw new Error(`simulation reverted: ${JSON.stringify(last?.error ?? sim.error)}`);
      const hash = `0x${createHash('sha256').update(JSON.stringify(tx) + w.evm.length).digest('hex')}`;
      if (reverts) {
        w.reverted.add(hash);
        w.evm.push({ hash, tx, logs: [] });
        return hash;
      }
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
    await page.addInitScript(MOCK_EVM_SCRIPT, { address: evmAddress });
    await page.route(`${RH_RPC}/**`, async (route: Route) => {
      const b = route.request().postDataJSON() as { method: string; params: unknown[]; id: number };
      const sent = w.evm.find((x) => x.hash === (b.params?.[0] as string));
      if (b.method === 'eth_getTransactionReceipt' && sent) {
        const result = w.hiddenReceipts.has(sent.hash) ? null : { status: w.reverted.has(sent.hash) ? '0x0' : '0x1', blockNumber: '0x10', logs: sent.logs };
        return route.fulfill({ json: { jsonrpc: '2.0', id: b.id, result } });
      }
      if (b.method === 'eth_getTransactionByHash' && sent) {
        const result = w.hideTxFromPage ? null : { hash: sent.hash, from: sent.tx.from, to: sent.tx.to, value: sent.tx.value ?? '0x0', input: sent.tx.data, blockNumber: '0x10' };
        return route.fulfill({ json: { jsonrpc: '2.0', id: b.id, result } });
      }
      const real = await rpc(RH_RPC, b.method, JSON.parse(funded(JSON.stringify(b.params ?? []))));
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

const sel = (w: World) => w.evm.map((e) => e.tx.data.slice(0, 10));
const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const draftParam = (d: Record<string, unknown>) => Buffer.from(JSON.stringify(d)).toString('base64url');

test('a double tap on REA IT starts one order: one quote, one wallet prompt', async ({ page }) => {
  const w = await setup(page);
  w.reject = true; // stop at the prompt: this is about how many orders start, not how they end
  await fillOrder(page, { pad: /pump\.fun/, name: 'Agent Forge', ticker: 'FORGE' });
  // Two submits in the same task, faster than any human: the second must find the form locked.
  await page.evaluate(() => {
    const f = document.getElementById('order') as HTMLFormElement;
    f.requestSubmit();
    f.requestSubmit();
  });
  await expect(page.locator('#order-msg')).toContainText('rejected', { timeout: 90_000 });
  expect(w.api.filter((a) => a.path === '/api/quote')).toHaveLength(1);
  expect(w.prompts).toBe(1);
  await expect(page.locator('#rea-it')).toBeEnabled();
});

test('wallet hand-off link: the restored order shows its tier, launchpad, dev buy and hosting picks', async ({ page }) => {
  await setup(page);
  const d = { t: 'excalidraw/excalidraw', r: 'deep', n: 'Sketch Forge', k: 'SKETCH', p: 'bonk', b: 1, h: { budget: 'any', traffic: 'serious', customDomain: true }, x: 2 };
  await page.goto(`./?d=${draftParam(d)}`);
  await expect(page.locator('#engine-banner')).toBeHidden();
  await expect(page.locator('[data-tier="deep"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-tier="standard"]')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-pad="bonk"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-pad="pump"]')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('[data-buy="1"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-budget="any"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-traffic="serious"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#need-domain')).toBeChecked();
  await expect(page.locator('#name')).toHaveValue('Sketch Forge');
  await expect(page.locator('#ticker')).toHaveValue('SKETCH');
  await expect(page.locator('#summary')).toContainText('(Deep): $40');
  await expect(page.locator('#summary')).toContainText('Bonk.fun');
  await expect(page.locator('#summary')).toContainText('+ 1 SOL dev buy');
  expect(new URL(page.url()).searchParams.get('d')).toBeNull();
});

test('a crafted hand-off link falls back to safe values and keeps the dev-buy cap', async ({ page }) => {
  await setup(page);
  const d = { t: 'linear.app', r: '__proto__', n: 'Line Forge', k: 'LINE', p: 'pons', b: 85, h: { budget: 'toString', traffic: 'constructor' }, x: -3 };
  await page.goto(`./?d=${draftParam(d)}`);
  await expect(page.locator('#engine-banner')).toBeHidden(); // boot finished
  await expect(page.locator('[data-tier="standard"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-pad="pons"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#summary')).toContainText('(Standard): $15');
  await expect(page.locator('#summary')).toContainText('+ 5 ETH dev buy'); // Robinhood Chain cap, not 85
  await expect(page.locator('#buy-custom')).toHaveValue('5');
  await expect(page.locator('[data-budget="free"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-traffic="hobby"]')).toHaveAttribute('aria-pressed', 'true');
});

test('GitHub rate limiting shows no made-up repo details', async ({ page }) => {
  await setup(page);
  await page.route('https://api.github.com/**', (r) => r.fulfill({ status: 403, json: { message: 'API rate limit exceeded' } }));
  await page.goto('./');
  await page.fill('#target', 'excalidraw/excalidraw');
  await expect(page.locator('#target-info')).toHaveText('GitHub repo · excalidraw/excalidraw');
});

test('rejecting the launch after paying: project page says the payment went through, nothing marked failed', async ({ page }) => {
  const w = await setup(page, { evm: true });
  w.rejectAt = 2; // pay, then say no to the launch
  await fillOrder(page, { pad: /Pons/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  await expect(page.locator('#p-notice')).toContainText('payment went through');
  await expect(page.locator('#p-notice')).not.toContainText(/hit REA IT|nothing was paid/);
  expect(w.api.filter((a) => a.path.endsWith('/token'))).toHaveLength(0);
  const job = await w.store.getJob(page.url().split('/p/')[1]);
  expect(job).toMatchObject({ status: 'running', payer: EVM_USER });
  expect(job!.token.status).toBe('pending');
  await expect(page.locator('.token')).toContainText('not launched yet');
  await expect(page.locator('#p-launch')).toBeVisible();
});

test('StonkLauncher: approve skipped after the create, "Finish launch" sends only approve + arm', async ({ page }) => {
  const w = await setup(page, { evm: true });
  w.rejectAt = 3; // pay, create, then say no to the approve
  await fillOrder(page, { pad: /StonkLauncher/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  const id = page.url().split('/p/')[1];
  await expect(page.locator('#p-notice')).toContainText('Finish launch');
  await expect(page.locator('#p-notice')).toContainText('payment went through');
  await expect(page.locator('.token')).toContainText("isn't armed yet");
  expect(sel(w)).toEqual([expect.stringMatching(/^0x7265/), '0x6cb0ea4e']);
  expect(JSON.parse((await stored(page, `rea4u.launch.${id}`))!)).toMatchObject({ kind: 'stonk', createTx: w.evm[1].hash, token: w.evm[1].token });

  w.rejectAt = 0;
  await page.locator('#p-finish').click();
  await expect(page.locator('.token')).toContainText('$FORGE is live', { timeout: 90_000 });
  // no second createLaunch: the same token got approved and armed
  expect(sel(w)).toEqual([expect.stringMatching(/^0x7265/), '0x6cb0ea4e', '0x095ea7b3', '0x92040b44']);
  const job = await w.store.getJob(id);
  expect(job!.token).toMatchObject({ status: 'live', mint: w.evm[1].token });
  expect(job!.token.url).toMatch(/^https:\/\/stonkbrokers\.io\/safe-launch\/token\/weth2-forge-\d+$/);
  expect(await stored(page, `rea4u.launch.${id}`)).toBeNull();
});

for (const upFront of [false, true]) {
  test(`a wallet that strips the payment tag: ${upFront ? 'the page sees it and asks for the claim up front' : 'the engine answers 428 and the page retries with a claim'}`, async ({ page }) => {
    const w = await setup(page, { evm: true, evmKey: `0x${createHash('sha256').update(`rea4u e2e claim ${upFront}`).digest('hex')}` });
    w.stripPayData = true;
    w.hideTxFromPage = !upFront;
    await fillOrder(page, { pad: /Pons/, name: 'Agent Forge', ticker: 'FORGE' });
    await page.locator('#rea-it').click();
    await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
    expect(w.evm[0].tx.data).toBe('0x');
    expect(w.signs).toBe(1);
    const posts = w.api.filter((a) => a.path === '/api/jobs');
    if (upFront) {
      expect(posts[0].body.claimSig).toMatch(/^0x[0-9a-f]{130}$/);
    } else {
      expect(posts[0]).toMatchObject({ status: 428 });
      expect(posts[0].body.claimSig).toBeUndefined();
      expect(posts.at(-1)!.body.claimSig).toMatch(/^0x[0-9a-f]{130}$/);
    }
    expect(posts.at(-1)!.status).toBe(200);
    const job = await w.store.getJob(page.url().split('/p/')[1]);
    expect(job).toMatchObject({ status: 'running', payer: w.evm[0].tx.from.toLowerCase(), payTx: w.evm[0].hash });
    expect(job!.token.status).toBe('live');
    await expect(page.locator('.token')).toContainText('$FORGE is live');
  });
}

test('a paid order whose tab closed before the engine registered it is finished by the project page', async ({ page, context }) => {
  const w = await setup(page, { evm: true });
  w.hold.jobs = true;
  await fillOrder(page, { pad: /Pons/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect.poll(() => w.api.filter((a) => a.path === '/api/jobs').length, { timeout: 120_000 }).toBeGreaterThan(0);
  const id = w.api.find((a) => a.path === '/api/jobs')!.body.quote.id as string;
  // saved in this browser before the engine heard of it
  expect(await stored(page, `rea4u.pending.${id}`)).toContain(w.evm[0].hash);
  await page.close();

  w.hold.jobs = false;
  const page2 = await context.newPage();
  await routeApi(page2, w);
  await page2.goto(`./#/p/${id}`);
  await expect(page2.locator('#p-title')).toHaveText('Agent Forge', { timeout: 60_000 });
  const job = await w.store.getJob(id);
  expect(job).toMatchObject({ payer: EVM_USER, payTx: w.evm[0].hash });
  expect(w.evm).toHaveLength(1); // paid once
  expect(await stored(page2, `rea4u.pending.${id}`)).toBeNull();
  await expect(page2.locator('.token')).toContainText('not launched yet');
});

test('a paid top-up whose tab closed before the engine credited it is credited by the project page', async ({ page, context }) => {
  const w = await setup(page, { evm: true });
  w.rejectAt = 2; // skip the launch: this test is about the top-up
  await fillOrder(page, { pad: /Pons/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  const id = page.url().split('/p/')[1];

  w.engine.snapshot = { status: 'idle', spentCents: 1500 };
  w.engine.events = [{ id: 'e1', type: 'session.status_idle', at: new Date().toISOString(), stopReason: 'budget_reached' }];
  const j = (await w.store.getJob(id))!;
  j.syncedAt = 0;
  await w.store.putJob(j);
  await page.reload();
  await expect(page.locator('.badge')).toHaveText('OUT OF BUDGET');
  const budget = (await w.store.getJob(id))!.budgetCents;

  w.hold.topup = true;
  await page.locator('[data-topup="500"]').click();
  await expect.poll(() => w.api.filter((a) => a.path.endsWith('/topup')).length, { timeout: 90_000 }).toBeGreaterThan(0);
  const payTx = w.evm.at(-1)!.hash;
  const saved = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('rea4u.topup.')));
  expect(saved).toHaveLength(1);
  expect(await stored(page, saved[0])).toContain(payTx);
  await page.close();

  w.hold.topup = false;
  const page2 = await context.newPage();
  await routeApi(page2, w);
  await page2.goto(`./#/p/${id}`);
  await expect.poll(async () => (await w.store.getJob(id))!.budgetCents, { timeout: 60_000 }).toBeGreaterThan(budget);
  expect(w.engine.budgets.at(-1)!.cents).toBe((await w.store.getJob(id))!.budgetCents);
  expect(w.evm.filter((e) => e.tx.to.toLowerCase() === TREASURY_EVM)).toHaveLength(2); // order + one top-up, nothing paid twice
  await expect.poll(() => stored(page2, saved[0])).toBeNull();
});

/** The worker, called directly (not through the page): what the API answers for a request. */
const workerApi = (w: World) => (path: string, body: unknown) =>
  handle(new Request(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env(), { store: w.store, engine: w.engine, fetch: workerFetch(w) });

const connects = (page: Page) => page.evaluate(() => (window as unknown as { __connects?: number }).__connects ?? 0);

test("a name with '_' goes through end to end: the form, the payment and the engine agree", async ({ page }) => {
  const w = await setup(page, { evm: true });
  await fillOrder(page, { pad: /Pons/, name: 'agent_forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  const job = await w.store.getJob(page.url().split('/p/')[1]);
  expect(job).toMatchObject({ status: 'running', project: { name: 'agent_forge' } });
  expect(job!.token).toMatchObject({ name: 'agent_forge', ticker: 'FORGE', status: 'live' });
  await expect(page.locator('#p-title')).toHaveText('agent_forge');
  expect(w.evm.filter((e) => e.tx.to.toLowerCase() === TREASURY_EVM)).toHaveLength(1);
});

test('an order the engine would refuse never reaches the wallet: the form refuses exactly those names first', async ({ page }) => {
  const w = await setup(page, { evm: true });
  const api = workerApi(w);
  const { quote } = (await (await api('/api/quote', { target: 'affaan-m/ECC', tier: 'standard', chain: 'robinhood' })).json()) as { quote: Quote };
  // The engine checks the names before it looks at the payment, so a 400 here refuses the names.
  const engine = async (name: string, ticker: string) =>
    (await api('/api/jobs', { quote, payTx: `0x${'00'.repeat(32)}`, project: { name }, token: { name, ticker, pad: 'pons' }, needs: {} })).status;
  await fillOrder(page, { pad: /Pons/ });
  const refused: [string, string, 'name' | 'ticker'][] = [
    ["Agent's Forge", 'FORGE', 'name'],
    ['Ågent Forge', 'FORGE', 'name'],
    ['agent~forge', 'FORGE', 'name'],
    ['-agent forge', 'FORGE', 'name'],
    ['A', 'FORGE', 'name'],
    ['ECC Forge', 'FORGE', 'name'],
    ['Agent Forge', 'ECC', 'ticker'],
    ['Agent Forge', 'F', 'ticker'],
  ];
  for (const [name, ticker, field] of refused) {
    expect(await engine(name, ticker), `engine on ${name} / ${ticker}`).toBe(400);
    await page.fill('#name', name);
    await page.fill('#ticker', ticker);
    await page.locator('#rea-it').click();
    await expect(page.locator(`#${field}-err`), `form on ${name} / ${ticker}`).not.toBeEmpty();
  }
  // What both accept gets past the names: the engine moves on to the payment (202, not on-chain yet).
  expect(await engine('agent_forge', 'FORGE')).toBe(202);
  expect(w.api.filter((a) => a.path === '/api/quote')).toHaveLength(0);
  expect(w.prompts + w.signs).toBe(0);
  expect(await connects(page)).toBe(0);
});

test('leaving and re-opening the project page while it registers a saved order keeps it going', async ({ page, context }) => {
  const w = await setup(page, { evm: true });
  w.hold.jobs = true;
  await fillOrder(page, { pad: /Pons/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect.poll(() => w.api.filter((a) => a.path === '/api/jobs').length, { timeout: 120_000 }).toBeGreaterThan(0);
  const id = w.api.find((a) => a.path === '/api/jobs')!.body.quote.id as string;
  await page.close();
  const page2 = await context.newPage();
  await routeApi(page2, w);
  await page2.goto(`./#/p/${id}`);
  await expect(page2.locator('#project-view')).toContainText('Finishing setup');
  // Away and back while that registration is still in flight.
  await page2.evaluate(() => (location.hash = '#/'));
  await page2.waitForTimeout(300);
  await page2.evaluate((i) => (location.hash = `#/p/${i}`), id);
  await expect(page2.locator('#project-view')).toContainText('Finishing setup');
  w.hold.jobs = false;
  await expect(page2.locator('#p-title')).toHaveText('Agent Forge', { timeout: 60_000 });
  expect(w.evm).toHaveLength(1); // paid once
  expect(await stored(page2, `rea4u.pending.${id}`)).toBeNull();
});

test('StonkLauncher: a saved create tx that never made it on-chain is dropped, and the token can still launch', async ({ page }) => {
  const w = await setup(page, { evm: true });
  w.rejectAt = 2; // pay, then skip the launch
  await fillOrder(page, { pad: /StonkLauncher/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  const id = page.url().split('/p/')[1];
  // What a create the wallet dropped (or replaced with speed up / cancel) leaves behind: a hash no RPC knows.
  await page.evaluate((i) => localStorage.setItem(`rea4u.launch.${i}`, JSON.stringify({ kind: 'stonk', createTx: `0x${'ab'.repeat(32)}`, launchId: '', token: '' })), id);
  await page.reload();
  await expect(page.locator('.token')).toContainText("isn't armed yet");
  await expect(page.locator('#p-launch')).toHaveText('Launch a new one instead'); // a way out even before Finish tells why
  w.rejectAt = 0;
  await page.locator('#p-finish').click();
  await expect(page.locator('#p-msg')).toContainText('no token exists', { timeout: 90_000 });
  expect(await stored(page, `rea4u.launch.${id}`)).toBeNull();
  await expect(page.locator('#p-launch')).toHaveText('Launch $FORGE now');
  await page.locator('#p-launch').click();
  await expect(page.locator('.token')).toContainText('$FORGE is live', { timeout: 120_000 });
  expect(sel(w).slice(1)).toEqual(['0x6cb0ea4e', '0x095ea7b3', '0x92040b44']);
});

test('StonkLauncher: an earlier arm the page could not read yet is kept, and the launch is recorded with it', async ({ page }) => {
  const w = await setup(page, { evm: true });
  w.rejectAt = 4; // pay, create, approve, then say no to the arm
  await fillOrder(page, { pad: /StonkLauncher/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  const id = page.url().split('/p/')[1];
  await expect(page.locator('.token')).toContainText("isn't armed yet");
  const saved = JSON.parse((await stored(page, `rea4u.launch.${id}`))!) as { launchId: string };
  expect(saved.launchId).toMatch(/^\d+$/);

  // An arm that went through, but whose receipt the page's RPC can't read yet (pending, or a flaky node).
  w.rejectAt = 0;
  const data = encodeFunctionData({ abi: parseAbi(['function arm(uint256 id, uint256 supplyWei)']), functionName: 'arm', args: [BigInt(saved.launchId), 10n ** 27n] });
  const first = await page.evaluate(
    ([to, data, from]) => (window as unknown as { __mockEvmSend: (t: Record<string, string>) => Promise<string> }).__mockEvmSend({ from, to, data, value: '0x0' }),
    [STONK_PAD, data, EVM_USER],
  );
  w.hiddenReceipts.add(first);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [`rea4u.launch.${id}`, JSON.stringify({ ...saved, armTxs: [first] })]);
  await page.reload();

  // Finish can't see that arm, so it sends approve + arm again; the second arm reverts (already armed).
  w.mineReverts = true;
  await page.locator('#p-finish').click();
  await expect(page.locator('#p-msg')).toContainText("couldn't arm the launch", { timeout: 90_000 });
  const after = JSON.parse((await stored(page, `rea4u.launch.${id}`))!) as { armTxs: string[] };
  expect(after.armTxs).toHaveLength(2);
  expect(after.armTxs[0]).toBe(first); // never overwritten by the arm that came after it
  expect(w.reverted.has(after.armTxs[1])).toBe(true);

  // Once the first arm's receipt is readable, Finish records the launch with it: nothing new to sign.
  w.hiddenReceipts.clear();
  const prompts = w.prompts;
  await page.locator('#p-finish').click();
  await expect(page.locator('.token')).toContainText('$FORGE is live', { timeout: 90_000 });
  expect(w.prompts).toBe(prompts);
  expect(w.api.filter((a) => a.path.endsWith('/token')).at(-1)!.body.armTx).toBe(first);
  expect(await stored(page, `rea4u.launch.${id}`)).toBeNull();
});

test('a saved payment that failed on-chain stops showing as paid: the project page drops it and says nothing was charged', async ({ page, context }) => {
  const w = await setup(page, { evm: true });
  w.hold.jobs = true;
  await fillOrder(page, { pad: /Pons/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect.poll(() => w.api.filter((a) => a.path === '/api/jobs').length, { timeout: 120_000 }).toBeGreaterThan(0);
  const id = w.api.find((a) => a.path === '/api/jobs')!.body.quote.id as string;
  expect(await stored(page, 'rea4u.jobs')).toContain(id);
  await page.close();

  // The chain's final word on that payment: reverted. The engine answers 402 "failed on-chain".
  w.reverted.add(w.evm[0].hash);
  w.hold.jobs = false;
  const page2 = await context.newPage();
  await routeApi(page2, w);
  await page2.goto(`./#/p/${id}`);
  await expect(page2.locator('#project-view')).toContainText('failed on-chain, so nothing was charged', { timeout: 60_000 });
  await expect(page2.locator('#project-view')).not.toContainText('went through');
  expect(await stored(page2, `rea4u.pending.${id}`)).toBeNull();
  expect(await stored(page2, 'rea4u.jobs')).not.toContain(id);
  expect(w.api.filter((a) => a.path === '/api/jobs').at(-1)!.status).toBe(402);
});

test('a saved Solana payment whose blockhash expired with the signature unknown is dropped: nothing was charged', async ({ page }) => {
  const w = await setup(page);
  const { quote } = (await (await workerApi(w)('/api/quote', { target: 'affaan-m/ECC', tier: 'lite', chain: 'solana' })).json()) as { quote: Quote };
  // What a tab closed right after the broadcast leaves behind when the network dropped the payment.
  const pending = {
    req: { quote, payTx: bs58.encode(createHash('sha512').update('rea4u e2e dropped payment').digest()), project: { name: 'Agent Forge' }, token: { name: 'Agent Forge', ticker: 'FORGE', pad: 'pump' }, needs: { budget: 'free', traffic: 'hobby', customDomain: false } },
    payer: PAYER,
    chain: 'solana',
    blockhash: bs58.encode(createHash('sha256').update('rea4u e2e long dead blockhash').digest()),
    at: Date.now() - 10 * 60_000,
  };
  await page.goto('./');
  await page.evaluate(
    ([id, p]) => {
      localStorage.setItem(`rea4u.pending.${id}`, p);
      localStorage.setItem('rea4u.jobs', JSON.stringify([{ id, project: 'Agent Forge', target: 'affaan-m/ECC', at: Date.now() }]));
    },
    [quote.id, JSON.stringify(pending)],
  );
  await page.goto(`./#/p/${quote.id}`);
  await expect(page.locator('#project-view')).toContainText('never landed', { timeout: 90_000 });
  await expect(page.locator('#project-view')).toContainText('nothing was charged');
  expect(await stored(page, `rea4u.pending.${quote.id}`)).toBeNull();
  expect(await stored(page, 'rea4u.jobs')).not.toContain(quote.id);
  expect(w.api.filter((a) => a.path === '/api/jobs').every((a) => a.status === 202)).toBe(true);
});

test('a claim the wallet fails to sign (not a "no") still says the payment went through, at order time and on the project page', async ({ page }) => {
  const w = await setup(page, { evm: true }); // no key: personal_sign fails with a wallet error
  w.stripPayData = true;
  w.hideTxFromPage = true;
  await fillOrder(page, { pad: /Pons/, name: 'Agent Forge', ticker: 'FORGE' });
  await page.locator('#rea-it').click();
  await expect(page).toHaveURL(/#\/p\/q_[a-z2-7]{16}$/, { timeout: 120_000 });
  await expect(page.locator('#p-notice')).toContainText('payment went through');
  await expect(page.locator('#p-notice')).toContainText("couldn't sign the free claim message");
  await expect(page.locator('#p-claim')).toBeVisible({ timeout: 60_000 });
  await page.locator('#p-claim').click();
  await expect(page.locator('#p-msg')).toContainText('payment went through', { timeout: 30_000 });
  await expect(page.locator('#p-msg')).toContainText("couldn't sign the free claim message");
  expect(w.signs).toBe(2);
  expect(w.evm).toHaveLength(1); // paid once, never asked to pay again
});
