import type { Launchpad, LaunchInput, PreparedLaunch, PrepareContext, StepId } from './types';
import type { Keypair, VersionedTransaction } from '@solana/web3.js';
import { uploadMetadata } from '../metadata';
import { buildCreateTx, assertTx } from './pumpportal';
import { rpcUrls, simulateTx, simError } from '../rpc';

type Built = { tx: VersionedTransaction; mint: Keypair; via: string };

/** Simulate before the wallet popup; returns null if OK, the error otherwise. */
async function check(b: Built, creator: string): Promise<Error | null> {
  assertTx(b.tx, creator, b.mint.publicKey.toBase58());
  try {
    return simError(await simulateTx(b.tx.serialize()));
  } catch {
    return null; // RPC hiccup: the wallet's own simulation still guards the user
  }
}

export const pump: Launchpad = {
  id: 'pump',
  name: 'pump.fun',
  tagline: 'the OG casino',
  badge: 'MOST APED',
  costHint: '~0.006 SOL rent + network fee, no launch fee',
  signatures: 1,
  devBuy: true,
  overheadSol: 0.01,
  async prepare(input: LaunchInput, onStep: (s: StepId) => void, ctx: PrepareContext = {}): Promise<PreparedLaunch> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    onStep('upload');
    const { uri } = await uploadMetadata(input, { createdOn: 'https://pump.fun' }, fetchImpl);

    onStep('build');
    const base = { creator: input.creator, name: input.name, symbol: input.ticker, uri, devBuySol: input.devBuySol };
    const attempts: (() => Promise<Built>)[] = [
      // 1) official SDK, built locally (no third party besides the RPC)
      async () => {
        const { buildPumpSdkTx } = await import('./pumpSdk');
        return { ...(await buildPumpSdkTx({ ...base, rpcUrl: rpcUrls()[0] })), via: 'pump-sdk' };
      },
      // 2) PumpPortal's builder (0.5% fee on the dev buy only)
      async () => ({ ...(await buildCreateTx({ ...base, pool: 'pump' }, fetchImpl)), via: 'pumpportal' }),
    ];
    let lastErr: Error | null = null;
    for (const attempt of attempts) {
      let built: Built;
      try {
        built = await attempt();
      } catch (e) {
        lastErr = e as Error;
        continue;
      }
      const err = await check(built, input.creator);
      if (!err) {
        const mint = built.mint.publicKey.toBase58();
        return { mint, tx: built.tx, coinUrl: `https://pump.fun/coin/${mint}`, via: built.via };
      }
      if ((err as { funds?: boolean }).funds) throw err; // no builder can fix an empty wallet
      lastErr = err;
    }
    throw lastErr ?? new Error('could not build the pump.fun transaction');
  },
};
