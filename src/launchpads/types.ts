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
  /** Which builder produced the transaction (for diagnostics). */
  via?: string;
  /** Shown to the user before the signature prompt (e.g. a fallback builder's fee). */
  notice?: string;
  /**
   * Re-apply our own extra signatures to a wallet-signed transaction. Only possible when we hold
   * those keys (pump.fun's fresh mint), and lets the launch survive a wallet that edits the message.
   */
  resign?: (signed: Uint8Array) => Uint8Array;
  /**
   * When set, the wallet only signs and this function broadcasts (some launchpads want the
   * signed transaction posted to their API). Otherwise the wallet signs and sends.
   */
  submit?: (signed: Uint8Array) => Promise<string>;
}

export interface PrepareContext {
  fetchImpl?: typeof fetch;
  /** Wallet message signing, for launchpads whose API wants proof of wallet ownership. */
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

export interface Launchpad {
  id: string;
  name: string;
  tagline: string;
  /** Wallet prompts the user will see. */
  signatures: 1 | 2;
  /** Whether a creator buy can ride along in the launch transaction. */
  devBuy: boolean;
  /** Wallet capabilities needed beyond connect + sign (checked before any prompt). */
  requires?: ('signMessage' | 'signTransaction')[];
  /** Overrides for the progress step labels. */
  stepLabels?: Partial<Record<StepId, string>>;
  /** Short human hint about what the launch costs on top of the dev buy. */
  costHint: string;
  badge?: string;
  /** Rough lamports the creator needs beyond the dev buy (rent + fees), for the balance check. */
  overheadSol: number;
  minDevBuySol?: number;
  prepare(input: LaunchInput, onStep: (s: StepId) => void, ctx?: PrepareContext): Promise<PreparedLaunch>;
}
