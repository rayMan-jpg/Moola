// Bonk.fun (Raydium LaunchLab, "Memes" platform). Uses bonk.fun's own transaction builder, which
// returns a v0 transaction already signed by a fresh "...bonk" vanity mint; the wallet adds the payer
// signature. The message must not be modified afterwards, and should be signed within ~60s.
import { VersionedTransaction } from '@solana/web3.js';
import type { Launchpad, LaunchInput, PreparedLaunch, PrepareContext, StepId } from './types';
import { uploadMetadata } from '../metadata';
import { assertTx } from './pumpportal';
import { simulateTx, simError } from '../rpc';

export const BONK_CREATE_URL = 'https://launch.letsbonk.fun/launchpad/createMint';
export const LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const BONK_PLATFORM = 'FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1';
const SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals

export function createMintBody(input: { creator: string; name: string; ticker: string; devBuySol: number }, uri: string) {
  const buyLamports = Math.floor(input.devBuySol * 1e9);
  return {
    owner: input.creator,
    useBonkMintAddress: false,
    programId: LAUNCHLAB_PROGRAM,
    decimals: 6,
    name: input.name,
    symbol: input.ticker,
    uri,
    migrateType: 'cpmm',
    platformId: BONK_PLATFORM,
    slippage: 50,
    buyAmount: buyLamports > 0 ? String(buyLamports) : 1,
    createOnly: !(buyLamports > 0),
    supply: SUPPLY.toString(),
    totalSellA: ((SUPPLY * 7931n) / 10000n).toString(),
  };
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export const bonk: Launchpad = {
  id: 'bonk',
  name: 'Bonk.fun',
  tagline: 'dog szn on Raydium',
  costHint: '~0.021 SOL rent + Metaplex fee',
  signatures: 1,
  devBuy: true,
  overheadSol: 0.025,
  async prepare(input: LaunchInput, onStep: (s: StepId) => void, ctx: PrepareContext = {}): Promise<PreparedLaunch> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    onStep('upload');
    const { uri } = await uploadMetadata(input, { createdOn: 'https://bonk.fun' }, fetchImpl);

    onStep('build');
    const res = await fetchImpl(BONK_CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createMintBody(input, uri)),
    });
    const text = await res.text();
    let j: { mint?: string; transaction?: string; message?: string };
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`bonk.fun builder returned ${res.status}: ${text.slice(0, 160)}`);
    }
    if (!res.ok || !j.transaction || !j.mint) throw new Error(`bonk.fun builder said no (${res.status}): ${(j.message ?? text).slice(0, 160)}`);
    const tx = VersionedTransaction.deserialize(fromBase64(j.transaction));
    assertTx(tx, input.creator, j.mint);
    const mintIdx = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === j.mint);
    if (!tx.signatures[mintIdx]?.some((b) => b !== 0)) throw new Error('bonk.fun builder did not sign the mint. Aborting.');
    const sim = await simulateTx(tx.serialize()).catch(() => null); // RPC hiccup: the wallet still simulates
    const err = sim && simError(sim);
    if (err) throw err;
    return { mint: j.mint, tx, coinUrl: `https://bonk.fun/token/${j.mint}`, via: 'bonk-api' };
  },
};
