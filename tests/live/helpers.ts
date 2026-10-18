import { readFileSync } from 'node:fs';
import { simulateTx, rpc } from '../../src/rpc';

// Big plain system-owned wallets, used only as the fee payer in simulations (sigVerify=false).
const CANDIDATES = [process.env.SIM_PAYER, '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2', '2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm'].filter(Boolean) as string[];

export async function fundedPayer(minSol = 100): Promise<string> {
  for (const a of CANDIDATES) {
    const r = await rpc<{ value: { owner: string; lamports: number } | null }>('getAccountInfo', [a, { encoding: 'base64' }]).catch(() => null);
    if (r?.value && r.value.owner === '11111111111111111111111111111111' && r.value.lamports / 1e9 >= minSol) return a;
  }
  throw new Error('no funded payer; set SIM_PAYER');
}

export function testImage(): Blob {
  const bytes = readFileSync(new URL('./fixtures/coin.jpg', import.meta.url));
  return new Blob([bytes], { type: 'image/jpeg' });
}

export async function sim(tx: { serialize(): Uint8Array }, watch: string[] = []) {
  return simulateTx(tx.serialize(), watch);
}
