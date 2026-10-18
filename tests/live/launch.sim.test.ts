// End-to-end launch builds against live mainnet, minus the wallet: real Arweave upload, real
// transaction from each builder, then simulateTransaction with a funded payer (sigVerify=false).
import { describe, expect, it, beforeAll } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { pump } from '../../src/launchpads/pump';
import { bonk } from '../../src/launchpads/bonk';
import { buildCreateTx } from '../../src/launchpads/pumpportal';
import { buildPumpSdkTx } from '../../src/launchpads/pumpSdk';
import { guardTx, checkEffects, PROGRAMS } from '../../src/launchpads/guard';
import { pumpMaxSpend } from '../../src/launchpads/pump';
import { uploadMetadata } from '../../src/metadata';
import { DEFAULT_RPCS } from '../../src/rpc';
import type { LaunchInput } from '../../src/launchpads/types';
import { fundedPayer, testImage, sim } from './helpers';

let payer = '';
let uri = '';
const input = (devBuySol: number): LaunchInput => ({
  name: 'Rea4u Sim Test',
  ticker: 'MSIM',
  description: 'simulation only, never launched',
  image: testImage(),
  devBuySol,
  creator: payer,
});

beforeAll(async () => {
  payer = await fundedPayer();
  ({ uri } = await uploadMetadata(input(0), { createdOn: 'https://pump.fun' }));
});

describe('metadata', () => {
  it('is readable from the gateway right away', async () => {
    const meta = await (await fetch(uri)).json();
    expect(meta).toMatchObject({ name: 'Rea4u Sim Test', symbol: 'MSIM', createdOn: 'https://pump.fun' });
    const img = await fetch(meta.image);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toMatch(/image\/jpeg/);
  });
});

describe('pump.fun builders', () => {
  for (const devBuySol of [0, 0.05]) {
    it(`official SDK create_v2 (dev buy ${devBuySol})`, async () => {
      const { tx } = await buildPumpSdkTx({ rpcUrl: DEFAULT_RPCS[0], creator: payer, name: 'Rea4u Sim Test', symbol: 'MSIM', uri, devBuySol });
      expect(tx.serialize().length).toBeLessThanOrEqual(1232);
      const r = await sim(tx);
      expect(r.err, (r.logs ?? []).slice(-8).join('\n')).toBeNull();
    });
    it(`PumpPortal create (dev buy ${devBuySol})`, async () => {
      const { tx, mint } = await buildCreateTx({ creator: payer, name: 'Rea4u Sim Test', symbol: 'MSIM', uri, devBuySol, pool: 'pump' }, fetch, Keypair.generate());
      expect(() => guardTx(tx, { creator: payer, mint: mint.publicKey.toBase58(), allow: [PROGRAMS.pump, PROGRAMS.ata, PROGRAMS.pumpPortalProxy] })).not.toThrow();
      const r = await sim(tx, [payer]);
      expect(r.err, (r.logs ?? []).slice(-8).join('\n')).toBeNull();
      expect(checkEffects(r, tx, { creator: payer, maxSpendSol: pumpMaxSpend(devBuySol) })).toBeNull();
    });
  }

  it('adapter prepare() returns a simulated-OK tx and a pump.fun link', async () => {
    const steps: string[] = [];
    const p = await pump.prepare(input(0.02), (s) => steps.push(s));
    expect(steps).toEqual(['upload', 'build']);
    expect(p.coinUrl).toBe(`https://pump.fun/coin/${p.mint}`);
    expect(p.via).toBe('pump-sdk');
    expect((await sim(p.tx)).err).toBeNull();
  });

  it('adapter rejects an empty wallet before any popup', async () => {
    const broke = Keypair.generate().publicKey.toBase58();
    await expect(pump.prepare({ ...input(0.02), creator: broke }, () => {})).rejects.toThrow(/not enough SOL/);
  });
});

describe('bonk.fun builder', () => {
  for (const devBuySol of [0, 0.05]) {
    it(`createMint (dev buy ${devBuySol})`, async () => {
      const p = await bonk.prepare(input(devBuySol), () => {});
      expect(p.coinUrl).toBe(`https://bonk.fun/token/${p.mint}`);
      const r = await sim(p.tx);
      expect(r.err, (r.logs ?? []).slice(-8).join('\n')).toBeNull();
    });
  }
});
