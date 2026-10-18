import type { Launchpad, LaunchInput, PreparedLaunch, PrepareContext, StepId } from './types';
import { VersionedTransaction, type Keypair } from '@solana/web3.js';
import { uploadMetadata } from '../metadata';
import { buildCreateTx, assertTx } from './pumpportal';
import { rpcUrls } from '../rpc';
import { guardTx, preflight, PROGRAMS, GuardError } from './guard';

type Built = { tx: VersionedTransaction; mint: Keypair; via: string };

/** Re-sign the mint slot of a wallet-signed transaction (needed if the wallet edited the message). */
export function resignWith(mint: Keypair): (signed: Uint8Array) => Uint8Array {
  return (signed) => {
    const t = VersionedTransaction.deserialize(signed);
    t.sign([mint]);
    return t.serialize();
  };
}

/** Most SOL a pump.fun launch may cost: dev buy (+ fees) plus rent for mint, curve and token accounts. */
export const pumpMaxSpend = (devBuySol: number) => devBuySol * 1.05 + 0.015;

/** Shape check, then simulate; throws GuardError (tampering), funds errors, or a simulation failure. */
async function check(b: Built, creator: string, devBuySol: number): Promise<void> {
  const mint = b.mint.publicKey.toBase58();
  assertTx(b.tx, creator, mint);
  const allow: string[] = [PROGRAMS.pump, PROGRAMS.ata];
  if (b.via === 'pumpportal') allow.push(PROGRAMS.pumpPortalProxy);
  guardTx(b.tx, { creator, mint, allow });
  await preflight(b.tx, { creator, maxSpendSol: pumpMaxSpend(devBuySol) });
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
        let lastErr: unknown;
        for (const rpcUrl of rpcUrls()) {
          try {
            return { ...(await buildPumpSdkTx({ ...base, rpcUrl })), via: 'pump-sdk' };
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr;
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
      let err: Error | null = null;
      try {
        await check(built, input.creator, input.devBuySol);
      } catch (e) {
        err = e as Error;
      }
      if (!err) {
        const mint = built.mint.publicKey.toBase58();
        const notice = built.via === 'pumpportal' && input.devBuySol > 0 ? "pump.fun's own builder hiccuped, so this launch goes through PumpPortal, which adds a 0.5% fee on the dev buy." : undefined;
        return { mint, tx: built.tx, coinUrl: `https://pump.fun/coin/${mint}`, via: built.via, notice, resign: resignWith(built.mint) };
      }
      // Tampering is a stop sign, not a reason to try a less trusted builder; and no builder fixes an empty wallet.
      if (err instanceof GuardError || (err as { funds?: boolean }).funds) throw err;
      lastErr = err;
    }
    throw lastErr ?? new Error('could not build the pump.fun transaction');
  },
};
