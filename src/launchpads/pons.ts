// Pons v2 on Robinhood Chain. No create API: the token is launched by calling the v2 factory
// (or the LaunchAndBuy router, for an atomic creator buy) straight from the user's wallet, the
// same call ponsfamily.com makes. Metadata lives on-chain; the logo is an https URL.
// Addresses, ABI and limits verified live 2026-10-18 (eth_call + estimateGas).

import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, toHex, zeroAddress } from 'viem';
import { evmRpc, simulateEvm, type EvmReceipt } from '../evm/chain';
import type { EvmLaunchInput, EvmLaunchpad, PreparedEvmLaunch } from './evm';

export const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
export const PONS_ROUTER = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';
export const ponsCoinUrl = (token: string) => `https://ponsfamily.com/launchpad/${token.toLowerCase()}`;

export const PONS_ABI = parseAbi([
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)',
  'function launchAndBuy(TokenParams params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function launchFee() view returns (uint256)',
  'function canLaunch(address launcher) view returns (bool)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
]);

/** Pons' own UI rules (stricter than the contract), so the coin looks native on ponsfamily.com. */
export function normalizeForPons(i: { name: string; ticker: string; description: string }) {
  return {
    name: i.name.replace(/[^A-Za-z0-9 ]/g, '').replace(/ {2,}/g, ' ').trim().slice(0, 32),
    symbol: i.ticker.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10),
    description: i.description.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim().slice(0, 256),
  };
}

async function read<T>(functionName: 'launchFee' | 'previewLaunchEconomics' | 'canLaunch', args: readonly unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi: PONS_ABI, functionName, args } as never);
  const out = await evmRpc<`0x${string}`>('eth_call', [{ to: PONS_FACTORY, data }, 'latest']);
  return decodeFunctionResult({ abi: PONS_ABI, functionName, data: out } as never) as T;
}

export interface PonsBuildArgs extends EvmLaunchInput {
  launchFee: bigint;
  expectedEconomics: `0x${string}`;
  salt?: `0x${string}`;
}

export function buildPonsTx(a: PonsBuildArgs) {
  const n = normalizeForPons(a);
  if (n.name.length < 1 || n.symbol.length < 1) throw new Error('pons needs a name and ticker made of letters and numbers');
  if (a.logo && (!/^https:\/\//.test(a.logo) || new TextEncoder().encode(a.logo).length > 512)) throw new Error('bad logo url');
  const creator = getAddress(a.creator);
  const params = {
    name: n.name,
    symbol: n.symbol,
    logo: a.logo,
    description: n.description,
    socials: { twitter: a.twitter ?? '', telegram: a.telegram ?? '', discord: '', website: a.website ?? '', farcaster: '' },
    creatorFeeRecipient: creator,
    creatorTaxBps: 0,
    buybackEnabled: false,
    expectedEconomics: a.expectedEconomics,
    salt: a.salt ?? toHex(crypto.getRandomValues(new Uint8Array(32))),
  };
  const buy = BigInt(Math.round(a.devBuyEth * 1e6)) * 10n ** 12n;
  if (buy > 0n) {
    return {
      params,
      router: true,
      tx: {
        to: PONS_ROUTER as `0x${string}`,
        data: encodeFunctionData({ abi: PONS_ABI, functionName: 'launchAndBuy', args: [params, 0n, zeroAddress, buy, 0n, creator, []] }),
        value: a.launchFee + buy,
      },
    };
  }
  return {
    params,
    router: false,
    tx: {
      to: PONS_FACTORY as `0x${string}`,
      data: encodeFunctionData({ abi: PONS_ABI, functionName: 'launchToken', args: [params, 0n, zeroAddress, []] }),
      value: a.launchFee,
    },
  };
}

export function ponsTokenFromReceipt(r: EvmReceipt): string | null {
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== PONS_FACTORY.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: PONS_ABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (ev.eventName === 'TokenLaunched') return (ev.args as { token: string }).token.toLowerCase();
    } catch {
      /* other event */
    }
  }
  return null;
}

export const pons: EvmLaunchpad = {
  id: 'pons',
  name: 'Pons',
  tagline: 'Robinhood Chain #1 launchpad',
  badge: 'HOOD',
  costHint: '0.0005 ETH launch fee + ~$0.20 gas; v2 contracts unaudited',
  devBuy: true,
  launchPrompts: 1,
  overheadEth: 0.0007,
  async prepare(input: EvmLaunchInput): Promise<PreparedEvmLaunch> {
    const [launchFee, expectedEconomics, canLaunch] = await Promise.all([
      read<bigint>('launchFee'),
      read<`0x${string}`>('previewLaunchEconomics', [0n, zeroAddress]),
      read<boolean>('canLaunch', [getAddress(input.creator)]),
    ]);
    if (!canLaunch) throw Object.assign(new Error('Pons is whitelist-only right now. pick another launchpad'), { friendly: true });
    const built = buildPonsTx({ ...input, launchFee, expectedEconomics });
    // Simulate the exact call from the user: proves it will go through and gives the CREATE2 address.
    const out = await simulateEvm(input.creator, built.tx);
    const fn = built.router ? 'launchAndBuy' : 'launchToken';
    const res = decodeFunctionResult({ abi: PONS_ABI, functionName: fn, data: out }) as readonly [string, ...unknown[]];
    return { tx: built.tx, predicted: res[0].toLowerCase(), tokenFrom: ponsTokenFromReceipt, coinUrl: ponsCoinUrl };
  },
};
