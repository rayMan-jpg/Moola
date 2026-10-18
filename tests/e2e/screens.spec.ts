// Not a correctness test: captures the main states for visual review (SHOTS=1 to enable).
import { test, expect } from '@playwright/test';
import bs58 from 'bs58';
import { MOCK_WALLET_SCRIPT } from './mockWallet';

const OUT = process.env.SHOTS_DIR ?? 'test-results/shots';
const PAYER = process.env.SIM_PAYER ?? '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
test.skip(!process.env.SHOTS, 'set SHOTS=1 to capture screenshots');

test('capture states', async ({ page }, info) => {
  const p = info.project.name;
  await page.goto('./');
  await expect(page.locator('#grid .card').first()).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${p}-1-landing.png` });
  await page.locator('#launch').screenshot({ path: `${OUT}/${p}-2-launcher.png` });
  await page.locator('#catalog').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/${p}-3-catalog.png` });
  await page.locator('#send-it').click();
  await expect(page.locator('#modal')).toBeVisible();
  await page.screenshot({ path: `${OUT}/${p}-4-no-wallet.png` });
  await page.keyboard.press('Escape');

  // with two wallets: picker
  await page.addInitScript(MOCK_WALLET_SCRIPT, { address: PAYER, publicKey: Array.from(bs58.decode(PAYER)) });
  await page.addInitScript(() => {
    const w = { version: '1.0.0', name: 'Second Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiNmZjJlOTciLz48L3N2Zz4=', chains: ['solana:mainnet'], accounts: [], features: { 'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [] }) }, 'standard:events': { version: '1.0.0', on: () => () => {} }, 'solana:signTransaction': { version: '1.0.0', supportedTransactionVersions: [0], signTransaction: async () => [] } } };
    window.addEventListener('wallet-standard:app-ready', (e) => (e as CustomEvent).detail.register(w));
  });
  await page.reload();
  await expect(page.locator('#grid .card').first()).toBeVisible();
  await page.locator('#send-it').click();
  await expect(page.locator('.wallet-btn').first()).toBeVisible();
  await page.screenshot({ path: `${OUT}/${p}-5-picker.png` });
});
