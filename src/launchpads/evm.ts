// Shared shape for Robinhood Chain launchpads (Pons, StonkLauncher).
import type { EvmReceipt, EvmTx } from '../evm/chain';

export interface EvmLaunchInput {
  name: string;
  ticker: string;
  description: string;
  /** Public https URL of the logo (pinned to Arweave by us). */
  logo: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  /** ETH the creator buys in the launch transaction (0 = none). */
  devBuyEth: number;
  creator: string;
}

export interface PreparedEvmLaunch {
  tx: EvmTx;
  /** Token address predicted by simulating the exact call (CREATE2), when the launchpad allows it. */
  predicted?: string;
  /** Pulls the new token address out of the receipt. */
  tokenFrom(receipt: EvmReceipt): string | null;
  coinUrl(token: string): string;
}

export interface EvmLaunchpad {
  id: 'pons' | 'stonk';
  name: string;
  tagline: string;
  badge?: string;
  costHint: string;
  devBuy: boolean;
  /** ETH needed beyond the dev buy (launch fee + gas), for the balance check. */
  overheadEth: number;
  prepare(input: EvmLaunchInput): Promise<PreparedEvmLaunch>;
}
