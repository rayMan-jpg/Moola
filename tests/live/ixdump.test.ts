// Diagnostic: print top-level programs + first data byte for every builder (DUMP=1).
import { it } from 'vitest';
import { bonk } from '../../src/launchpads/bonk';
import { pump } from '../../src/launchpads/pump';
import { buildCreateTx } from '../../src/launchpads/pumpportal';
import { fundedPayer, testImage } from './helpers';
it.runIf(process.env.DUMP)('dump', async () => {
  const payer = await fundedPayer();
  const input = { name: 'Moola Sim', ticker: 'MSIM', description: 'x', image: testImage(), devBuySol: 0.05, creator: payer };
  const show = (label: string, tx: any) => {
    const keys = tx.message.staticAccountKeys.map((k: any) => k.toBase58());
    console.log(label, tx.message.compiledInstructions.map((ix: any) => `${keys[ix.programIdIndex].slice(0, 8)}:${ix.data[0]}:${ix.accountKeyIndexes.length}`).join(' | '));
  };
  show('pump-sdk', (await pump.prepare(input, () => {})).tx);
  show('pumpportal', (await buildCreateTx({ creator: payer, name: 'x', symbol: 'X', uri: 'https://turbo-gateway.com/x', devBuySol: 0.05, pool: 'pump' })).tx);
  show('bonk', (await bonk.prepare(input, () => {})).tx);
  show('bonk0', (await bonk.prepare({ ...input, devBuySol: 0 }, () => {})).tx);
});
