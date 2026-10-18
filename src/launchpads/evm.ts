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
  /**
   * Transactions that must follow the first one (e.g. approve + arm), built from its receipt.
   * Each is a separate wallet prompt.
   */
  followUps?(receipt: EvmReceipt): { label: string; tx: EvmTx }[];
  /** Coin page; some launchpads key it by data from the creation receipt. */
  coinUrl(token: string, receipt?: EvmReceipt): string;
}

export interface EvmLaunchpad {
  id: 'pons' | 'stonk' | 'utoken';
  name: string;
  tagline: string;
  badge?: string;
  costHint: string;
  devBuy: boolean;
  /** Wallet prompts the launch itself takes. */
  launchPrompts: number;
  /** ETH needed beyond the dev buy (launch fee + gas), for the balance check. */
  overheadEth: number;
  prepare(input: EvmLaunchInput): Promise<PreparedEvmLaunch>;
}
