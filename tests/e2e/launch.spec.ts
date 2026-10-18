import { test, expect, type Page, type Route } from '@playwright/test';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { newKey, payer, withPayer, signPayer } from './txbytes';

type Key = ReturnType<typeof newKey>;
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
import { MOCK_WALLET_SCRIPT } from './mockWallet';

// A big system-owned mainnet wallet: used as the mock wallet's address so simulations have funds.
// We never have its key; nothing is ever broadcast.
const PAYER = process.env.SIM_PAYER ?? '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const RPC = 'https://solana-rpc.publicnode.com';
const LIVE_UPLOAD = process.env.E2E_LIVE_UPLOAD === '1';

interface Ctx {
  sims: { err: unknown; logs: string[] }[];
  sent: number;
  reject: boolean;
}

async function nodeRpc(method: string, params: unknown[]) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return r.json();
}

/** Simulate base64 tx bytes; if the fee payer is the unfunded test key, swap in the funded payer first. */
async function simulateB64(b64: string, alias?: Key) {
  let bytes: Uint8Array = Buffer.from(b64, 'base64');
  if (alias && same(payer(bytes), alias.publicKey)) bytes = withPayer(bytes, bs58.decode(PAYER));
  return nodeRpc('simulateTransaction', [Buffer.from(bytes).toString('base64'), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' }]);
}

/**
 * Default: the mock wallet *is* a funded mainnet address (no key; signs nothing).
 * With `alias`: the wallet holds a real throwaway key and signs for real; simulations treat it as funded.
 */
async function setup(page: Page, alias?: Key): Promise<Ctx> {
  const ctx: Ctx = { sims: [], sent: 0, reject: false };
  await page.exposeFunction('__mockSign', async (tx: number[]) => {
    if (ctx.reject) throw new Error('User rejected the request.');
    if (!alias) return tx; // the "wallet" signs nothing: simulation runs with sigVerify=false
    return Array.from(signPayer(Uint8Array.from(tx), alias.secretKey));
  });
  await page.exposeFunction('__mockSignMessage', async (m: number[]) => {
    if (ctx.reject) throw new Error('User rejected the request.');
    if (!alias) return Array.from(new Uint8Array(64));
    return Array.from(ed25519.sign(Uint8Array.from(m), alias.secretKey));
  });
  await page.exposeFunction('__mockSend', async () => {
    throw new Error('signAndSend should not be used when signTransaction exists');
  });
  const address = alias ? bs58.encode(alias.publicKey) : PAYER;
  await page.addInitScript(MOCK_WALLET_SCRIPT, { address, publicKey: Array.from(bs58.decode(address)) });

  // Swap broadcasting for a mainnet simulation of the exact bytes the wallet returned.
  await page.route(`${RPC}/**`, async (route: Route) => {
    const body = route.request().postDataJSON() as { method: string; params: unknown[]; id: number };
    if (body?.method === 'sendTransaction') {
      ctx.sent++;
      const [b64] = body.params as [string];
      const sim = await simulateB64(b64, alias);
      ctx.sims.push({ err: sim.result ? sim.result.value.err : (sim.error ?? 'no result'), logs: sim.result?.value?.logs ?? [] });
      if (process.env.E2E_DEBUG) console.log('SIM', JSON.stringify(sim).slice(0, 1500));
      const sig = bs58.encode(Buffer.from(b64, 'base64').subarray(1, 65));
      return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: sig } });
    }
    if (body?.method === 'getSignatureStatuses') {
      const ok = ctx.sims.at(-1)?.err === null;
      return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: [ok ? { confirmationStatus: 'confirmed', err: null } : { confirmationStatus: 'processed', err: { sim: 'failed' } }] } } });
    }
    if (alias && body?.method === 'simulateTransaction') {
      const real = await simulateB64((body.params as [string])[0], alias);
      return route.fulfill({ json: { ...real, id: body.id } });
    }
    if (alias && body?.method === 'getBalance' && (body.params as string[])[0] === address) {
      return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: 10e9 } } });
    }
    const real = await nodeRpc(body.method, body.params);
    return route.fulfill({ json: { ...real, id: body.id } });
  });

  // Jupiter broadcasts whatever is posted to /submit, so the test simulates it instead.
  await page.route('https://api.jup.ag/studio/v1/dbc-pool/submit', async (route) => {
    ctx.sent++;
    const form = route.request().postData() ?? '';
    const b64 = form.match(/name="transaction"\r\n\r\n([A-Za-z0-9+/=]+)/)?.[1] ?? '';
    const hasLogo = /name="headerImage"; filename="logo\.(jpeg|png|webp)"/.test(form);
    const sim = await simulateB64(b64, alias);
    ctx.sims.push({ err: hasLogo ? (sim.result ? sim.result.value.err : (sim.error ?? 'no result')) : 'missing headerImage', logs: sim.result?.value?.logs ?? [] });
    return route.fulfill({ json: { success: true, data: { mint: 'from-create-tx' } } });
  });

  if (!LIVE_UPLOAD) {
    // Keep test runs from pinning junk to Arweave: answer like Turbo, serve back like the gateway.
    await page.route('https://upload.ardrive.io/**', async (route) => {
      const item = route.request().postDataBuffer()!;
      const id = createHash('sha256').update(item.subarray(2, 66)).digest('base64url'); // ANS-104 id = sha256(signature)
      return route.fulfill({ json: { id, winc: '0' } });
    });
  }
  return ctx;
}

async function memeAgent(page: Page, query: string) {
  await page.goto('./');
  await expect(page.locator('#grid .card').first()).toBeVisible();
  await page.fill('#search', query);
  const card = page.locator('#grid .card', { hasText: query }).first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Meme it' }).click();
}

for (const pad of ['pump.fun', 'Bonk.fun']) {
  test(`one-click launch on ${pad}: upload, build, sign once, simulated OK`, async ({ page }) => {
    const ctx = await setup(page);
    await memeAgent(page, 'tdd-guide');
    await expect(page.locator('#ticker')).toHaveValue('TDD');
    await expect(page.locator('#name')).toHaveValue(/TDD/);
    await page.getByRole('radio', { name: new RegExp(pad.replace('.', '\\.')) }).click();
    await page.locator('#buy-chips').getByRole('button', { name: '0.1' }).click();
    await expect(page.locator('#summary')).toContainText(pad);

    await page.locator('#send-it').click();
    await expect(page.locator('#result h3')).toHaveText('$TDD IS LIVE', { timeout: 90_000 });
    expect(ctx.sent).toBeGreaterThanOrEqual(1);
    expect(ctx.sims[0].err, ctx.sims[0].logs.slice(-6).join('\n')).toBeNull();
    const mint = (await page.locator('#result .ca span').textContent())!.trim();
    const coinLink = page.getByRole('link', { name: `Open on ${pad}` });
    await expect(coinLink).toHaveAttribute('href', pad === 'pump.fun' ? `https://pump.fun/coin/${mint}` : `https://bonk.fun/token/${mint}`);
    await expect(page.locator('#result')).toHaveAttribute('data-via', pad === 'pump.fun' ? 'pump-sdk' : 'bonk-api');
    await expect(page.locator('#wallet-btn')).toHaveText(`${PAYER.slice(0, 4)}…${PAYER.slice(-4)}`);
  });
}

test('Jupiter Studio: auth prompt + tx prompt, submitted tx simulates OK', async ({ page }) => {
  const ctx = await setup(page, newKey());
  await memeAgent(page, 'planner');
  await page.getByRole('radio', { name: /Jupiter Studio/ }).click();
  await expect(page.locator('#buy-chips .chip').first()).toBeDisabled();
  await expect(page.locator('#summary')).toContainText('2 wallet prompts');
  await page.locator('#send-it').click();
  await expect(page.locator('#result h3')).toHaveText('$PLANNER IS LIVE', { timeout: 90_000 });
  expect(ctx.sent).toBe(1);
  expect(ctx.sims[0].err, ctx.sims[0].logs.slice(-6).join('\n')).toBeNull();
  const mint = (await page.locator('#result .ca span').textContent())!.trim();
  expect(mint).toMatch(/jup[sx]$/);
  await expect(page.getByRole('link', { name: 'Open on Jupiter Studio' })).toHaveAttribute('href', `https://jup.ag/tokens/${mint}`);
  await expect(page.locator('#result')).toHaveAttribute('data-via', 'jup-studio');
});

test('rejecting in the wallet leaves no coin and a friendly message', async ({ page }) => {
  const ctx = await setup(page);
  ctx.reject = true;
  await memeAgent(page, 'security-reviewer');
  await page.locator('#send-it').click();
  await expect(page.locator('#launch-msg')).toContainText('you rejected it in the wallet', { timeout: 60_000 });
  expect(ctx.sent).toBe(0);
  await expect(page.locator('#send-it')).toBeEnabled();
});

test('form validation blocks a bad ticker before anything happens', async ({ page }) => {
  const ctx = await setup(page);
  await page.goto('./');
  await page.fill('#name', ''); // before the catalog lands: must not be overwritten by the default coin
  await expect(page.locator('#grid .card').first()).toBeVisible();
  await expect(page.locator('#name')).toHaveValue('');
  await page.locator('#send-it').click();
  await expect(page.locator('#name-err')).toContainText('needs a name');
  expect(ctx.sent).toBe(0);
});

test('deep link pre-fills the coin for an agent', async ({ page }) => {
  await setup(page);
  await page.goto('./#/agent/planner');
  await expect(page.locator('#ticker')).toHaveValue('PLANNER');
});
