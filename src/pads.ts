// Every launchpad rea4u can put the project's token on, across both chains.
import type { ChainId, PadId } from '../shared/contract';
import type { EvmLaunchpad } from './launchpads/evm';
import { LAUNCHPADS } from './launchpads';
import { pons } from './launchpads/pons';
import { stonk } from './launchpads/stonk';
import { utoken } from './launchpads/utoken';
import type { Launchpad } from './launchpads/types';

export interface PadInfo {
  id: PadId;
  chain: ChainId;
  name: string;
  tagline: string;
  badge?: string;
  costHint: string;
  devBuy: boolean;
  /** Wallet prompts for the whole order (payment + launch). */
  prompts: number;
  sol?: Launchpad;
  evm?: EvmLaunchpad;
  /** Shown but not selectable yet. */
  soon?: string;
}

const sol = (p: Launchpad): PadInfo => ({
  id: p.id as PadId,
  chain: 'solana',
  name: p.name,
  tagline: p.tagline,
  badge: p.badge,
  costHint: p.costHint.replace(/, 2 wallet prompts$/, ''),
  devBuy: p.devBuy,
  // payment + launch are signed together in one prompt; Jupiter adds its sign-in message
  prompts: p.requires?.includes('signMessage') ? 2 : 1,
  sol: p,
});

const evm = (p: EvmLaunchpad): PadInfo => ({
  id: p.id,
  chain: 'robinhood',
  name: p.name,
  tagline: p.tagline,
  badge: p.badge,
  costHint: p.costHint,
  devBuy: p.devBuy,
  // the payment, then the launch's own transactions
  prompts: 1 + p.launchPrompts,
  evm: p,
});

export const PADS: PadInfo[] = [...LAUNCHPADS.map(sol), evm(pons), evm(stonk), evm(utoken)];

export function padInfo(id: string): PadInfo {
  return PADS.find((p) => p.id === id && !p.soon) ?? PADS[0];
}

export const CHAIN_LABEL: Record<ChainId, string> = { solana: 'Solana', robinhood: 'Robinhood Chain' };
