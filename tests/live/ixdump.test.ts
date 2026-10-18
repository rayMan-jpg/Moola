// Diagnostic: print top-level programs + first data byte for every builder (DUMP=1).
import { it } from 'vitest';
import { bonk } from '../../src/launchpads/bonk';
import { pump } from '../../src/launchpads/pump';
import { buildCreateTx } from '../../src/launchpads/pumpportal';
import { STUDIO_API, createTxBody } from '../../src/launchpads/jup';
import { toBase64 } from '../../src/rpc';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { fundedPayer, testImage } from './helpers';
it.runIf(process.env.DUMP)('dump', async () => {
  const payer = await fundedPayer();
  const input = { name: 'Rea4u Sim', ticker: 'MSIM', description: 'x', image: testImage(), devBuySol: 0.05, creator: payer };
  const show = (label: string, tx: any) => {
    const keys = tx.message.staticAccountKeys.map((k: any) => k.toBase58());
    console.log(label, tx.message.compiledInstructions.map((ix: any) => `${keys[ix.programIdIndex].slice(0, 8)}:${Buffer.from(ix.data.slice(0, 8)).toString('hex')}:${ix.accountKeyIndexes.length}`).join(' | '));
  };
  show('pump-sdk', (await pump.prepare(input, () => {})).tx);
  show('pumpportal', (await buildCreateTx({ creator: payer, name: 'x', symbol: 'X', uri: 'https://turbo-gateway.com/x', devBuySol: 0.05, pool: 'pump' })).tx);
  show('bonk', (await bonk.prepare(input, () => {})).tx);
  show('bonk0', (await bonk.prepare({ ...input, devBuySol: 0 }, () => {})).tx);
  const kp = Keypair.generate();
  const ts = Date.now(); const nonce = crypto.randomUUID(); const message = `${ts}:${nonce}`;
  const signature = toBase64(ed25519.sign(new TextEncoder().encode(message), kp.secretKey.slice(0, 32)));
  const j = await (await fetch(`${STUDIO_API}/dbc-pool/create-tx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createTxBody({ creator: kp.publicKey.toBase58(), name: 'x', ticker: 'XX' }, 'image/jpeg', { message, signature, timestamp: ts, nonce })) })).json();
  show('jup', VersionedTransaction.deserialize(Buffer.from(j.transaction, 'base64')));
});
