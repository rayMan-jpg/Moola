// µToken (utoken.gg) on Robinhood Chain: the launchpad behind stonk.broker (uSTONK launched here).
// One transaction: prepareAndLaunch on the gen-149 TokenLaunchFactory with the "plain token"
// provider, the same call utoken.gg makes. Metadata (description, icon, links) lives on-chain.
// ABI from the utoken.gg production bundle; simulated from fresh addresses 2026-10-18.

import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress } from 'viem';
import { evmRpc, simulateEvm, type EvmReceipt, type EvmTx } from '../evm/chain';
import type { EvmLaunchInput, EvmLaunchpad, PreparedEvmLaunch } from './evm';

export const UTOKEN_FACTORY = '0xD03FB35ee057dF5933a8a95B362CC3e11a56D4Cf';
const SYSTEM_CONFIG = '0x30A9e1b013504EF3315296999b72B347DB8b2864';
/** Provider id of the plain ERC-20 token template. */
export const UTOKEN_PLAIN = '0x3f221d5f45081394e706b362a02282b13939ee941060a13962ddeb5999a1277b';
export const utokenCoinUrl = (token: string) => `https://utoken.gg/token/${token.toLowerCase()}`;

export const UTOKEN_ABI = parseAbi([
  'struct TokenMetadata { string description; string iconUri; string websiteUri; string telegramUri; string twitterUri; }',
  'struct MaxBuyParams { uint256 startBps; uint256 growthBpsPerSec; }',
  'struct MaxWalletParams { uint256 startBps; uint256 growthBpsPerSec; }',
  'struct CreatorFeeAllocation { uint16 devBps; uint16 burnBps; }',
  'struct CommonTokenParams { string name; string symbol; uint8 decimals; uint256 totalSupply; TokenMetadata metadata; MaxBuyParams maxBuy; MaxWalletParams maxWallet; address quoteToken; uint256 bondingQuoteTarget; uint32 graduationDurationSeconds; uint256 creatorAllocBps; CreatorFeeAllocation creatorFeeAllocation; uint16 holderDistributorBps; bool fixedSupply; }',
  'function prepareAndLaunch(bytes32 providerId, CommonTokenParams params, bytes providerParams, address feeRecipient, uint256 minutesUntilStart) payable returns (uint256 launchId, address token, address graduationPool)',
  'function launchFeeWei() view returns (uint256)',
  'event LaunchStarted(uint256 indexed launchId, address indexed token, address indexed owner, address graduationPool, uint256 tradingStartsAt)',
]);

/** utoken.gg's defaults for a plain token: 1B supply, ETH curve to 4 ETH, gentle anti-whale ramp. */
export function utokenParams(i: { name: string; symbol: string; description: string; logo: string; website?: string; telegram?: string; twitter?: string }) {
  return {
    name: i.name,
    symbol: i.symbol,
    decimals: 18,
    totalSupply: 10n ** 27n,
    metadata: { description: i.description, iconUri: i.logo, websiteUri: i.website ?? '', telegramUri: i.telegram ?? '', twitterUri: i.twitter ?? '' },
    maxBuy: { startBps: 250n, growthBpsPerSec: 3n },
    maxWallet: { startBps: 250n, growthBpsPerSec: 3n },
    quoteToken: zeroAddress,
    bondingQuoteTarget: 4n * 10n ** 18n,
    graduationDurationSeconds: 0,
    creatorAllocBps: 0n,
    creatorFeeAllocation: { devBps: 0, burnBps: 0 },
    holderDistributorBps: 0,
    fixedSupply: true,
  } as const;
}

export function utokenFromReceipt(r: EvmReceipt): string | null {
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== UTOKEN_FACTORY.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: UTOKEN_ABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (ev.eventName === 'LaunchStarted') return (ev.args as { token: string }).token.toLowerCase();
    } catch {
      /* other event */
    }
  }
  return null;
}

export const utoken: EvmLaunchpad = {
  id: 'utoken',
  name: 'µToken',
  tagline: 'utoken.gg, home of stonk.broker',
  costHint: 'free launch, ~$0.40 gas',
  devBuy: false,
  launchPrompts: 1,
  overheadEth: 0.0004,
  async prepare(input: EvmLaunchInput): Promise<PreparedEvmLaunch> {
    const fee = BigInt(await evmRpc<string>('eth_call', [{ to: SYSTEM_CONFIG, data: encodeFunctionData({ abi: UTOKEN_ABI, functionName: 'launchFeeWei' }) }, 'latest']));
    if (fee > 10n ** 16n) throw Object.assign(new Error('µToken launches are closed right now. pick another launchpad.'), { friendly: true });
    const params = utokenParams({
      name: input.name.replace(/\s+/g, ' ').trim().slice(0, 32),
      symbol: input.ticker.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10),
      description: input.description.slice(0, 500),
      logo: input.logo,
      website: input.website,
      telegram: input.telegram,
      twitter: input.twitter,
    });
    const tx: EvmTx = {
      to: UTOKEN_FACTORY,
      data: encodeFunctionData({ abi: UTOKEN_ABI, functionName: 'prepareAndLaunch', args: [UTOKEN_PLAIN, params, '0x', getAddress(input.creator), 0n] }),
      value: fee,
    };
    const out = await simulateEvm(input.creator, tx);
    const [, token] = decodeFunctionResult({ abi: UTOKEN_ABI, functionName: 'prepareAndLaunch', data: out }) as readonly [bigint, string, string];
    return { tx, predicted: token.toLowerCase(), tokenFrom: utokenFromReceipt, coinUrl: utokenCoinUrl };
  },
};
