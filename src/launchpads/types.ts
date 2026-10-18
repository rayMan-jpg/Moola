import type { VersionedTransaction } from '@solana/web3.js';

export interface LaunchInput {
  name: string;
  ticker: string;
  description: string;
  image: Blob;
  twitter?: string;
  telegram?: string;
  website?: string;
  /** SOL the creator buys in the same transaction (0 = none). */
  devBuySol: number;
  /** Creator wallet (fee payer, signer). */
  creator: string;
}

export type StepId = 'upload' | 'build' | 'sign' | 'confirm';

export interface PreparedLaunch {
  mint: string;
  /** Fully built transaction, already signed by any extra keypairs (e.g. a fresh mint). */
  tx: VersionedTransaction;
  coinUrl: string;
  /**
   * When set, the wallet only signs and this function broadcasts (some launchpads want the
   * signed transaction posted to their API). Otherwise the wallet signs and sends.
   */
  submit?: (signed: Uint8Array) => Promise<string>;
}

export interface Launchpad {
  id: string;
  name: string;
  tagline: string;
  /** Short human hint about what the launch costs on top of the dev buy. */
  costHint: string;
  badge?: string;
  /** Rough lamports the creator needs beyond the dev buy (rent + fees), for the balance check. */
  overheadSol: number;
  minDevBuySol?: number;
  prepare(input: LaunchInput, onStep: (s: StepId) => void, fetchImpl?: typeof fetch): Promise<PreparedLaunch>;
}
