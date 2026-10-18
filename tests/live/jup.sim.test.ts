// Jupiter Studio: real auth signature from a throwaway key, real create-tx, then simulate the returned
// transaction with a funded fee payer swapped into slot 0 (sigVerify=false). /submit is never called.
import { describe, expect, it, beforeAll } from 'vitest';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { jup, createTxBody, assertStudioTx, STUDIO_API } from '../../src/launchpads/jup';
import { toBase64 } from '../../src/rpc';
import { fundedPayer, testImage, sim } from './helpers';

let payer = '';
const kp = Keypair.generate();
const signMessage = async (m: Uint8Array) => ed25519.sign(m, kp.secretKey.slice(0, 32));

beforeAll(async () => {
  payer = await fundedPayer();
});

describe('Jupiter Studio', () => {
  it('create-tx builds a pre-signed launch that simulates OK once funded', async () => {
    const timestamp = Date.now();
    const nonce = crypto.randomUUID();
    const message = `${timestamp}:${nonce}`;
    const signature = toBase64(await signMessage(new TextEncoder().encode(message)));
    const res = await fetch(`${STUDIO_API}/dbc-pool/create-tx`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createTxBody({ creator: kp.publicKey.toBase58(), name: 'Moola Sim Test', ticker: 'MSIM' }, 'image/jpeg', { message, signature, timestamp, nonce })),
    });
    const j = await res.json();
    expect(res.status, JSON.stringify(j)).toBe(200);
    const tx = VersionedTransaction.deserialize(Buffer.from(j.transaction, 'base64'));
    assertStudioTx(tx, kp.publicKey.toBase58(), j.mint);
    tx.message.staticAccountKeys[0] = new PublicKey(payer); // emulate a funded creator
    const r = await sim(tx);
    expect(r.err, (r.logs ?? []).slice(-8).join('\n')).toBeNull();
  });

  it('adapter goes auth -> build and stops an unfunded wallet before the tx prompt', async () => {
    const steps: string[] = [];
    await expect(
      jup.prepare({ name: 'Moola Sim Test', ticker: 'MSIM2', description: 'sim only', image: testImage(), devBuySol: 0, creator: kp.publicKey.toBase58() }, (s) => steps.push(s), { signMessage }),
    ).rejects.toThrow(/not enough SOL/);
    expect(steps).toEqual(['upload', 'build']);
  });

  it('rejects reserved tickers without touching the wallet', async () => {
    let asked = false;
    await expect(
      jup.prepare({ name: 'x', ticker: 'USDC', description: '', image: testImage(), devBuySol: 0, creator: payer }, () => {}, { signMessage: async (m) => ((asked = true), m) }),
    ).rejects.toThrow(/reserved/);
    expect(asked).toBe(false);
  });
});
