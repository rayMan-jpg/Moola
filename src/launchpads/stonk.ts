// StonkLauncher ("Smart Launch" V2 by StonkBrokers, stonkbrokers.io/launcher) on Robinhood Chain.
// Creation is free (launchFeeWei() = 0 today, read live): createLaunch mints 1B tokens to the creator,
// then approve(pad, supply) + arm(id, supply) load them into the curve. Same three calls the site
// makes, all from the user's wallet. Degen mode: flat 1% tax from the first block, no snipe tax.
// Addresses, ABI and bounds verified live 2026-10-18 (eth_call + eth_simulateV1).

import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, zeroAddress, zeroHash } from 'viem';
import { evmRpc, type EvmReceipt, type EvmTx } from '../evm/chain';
import type { EvmLaunchInput, EvmLaunchpad, PreparedEvmLaunch } from './evm';

/** ETH lane (WETH quote). */
export const STONK_PAD = '0xFCd61B25BbF3AbD6cf0070D6328E351cc30EEC9f';
export const STONK_LANE = 'weth2';
export const STONK_SUPPLY = 1_000_000_000n * 10n ** 18n;

export const STONK_ABI = parseAbi([
  'struct CreateParams { address token; string name; string symbol; uint256 supply; bytes32 vanitySalt; uint64 startMcapUsd8; uint64 gradMcapUsd8; uint16 startTaxBps; uint16 taxDecayPerMinuteBps; bool sellsEnabled; uint32 bufferSecs; uint8 unsoldMode; bool eoaOnly; bool openEnded; uint16 postTaxBps; uint8 bondVenue; uint32 maxBuyPpm; }',
  'function createLaunch(CreateParams p) payable returns (uint256 id, address token)',
  'function arm(uint256 id, uint256 supplyWei)',
  'function launchFeeWei() view returns (uint256)',
  'event LaunchCreated(uint256 indexed id, address indexed token, address indexed creator, bool externalToken)',
]);
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

/** The site's "degen" preset: $1k start, $50k graduation, flat 1% tax, everything loaded. */
export function stonkCreateParams(name: string, symbol: string) {
  return {
    token: zeroAddress,
    name,
    symbol,
    supply: STONK_SUPPLY,
    vanitySalt: zeroHash,
    startMcapUsd8: 1000n * 10n ** 8n,
    gradMcapUsd8: 50_000n * 10n ** 8n,
    startTaxBps: 0,
    taxDecayPerMinuteBps: 0,
    sellsEnabled: true,
    bufferSecs: 0,
    unsoldMode: 0,
    eoaOnly: false,
    openEnded: true,
    postTaxBps: 100,
    bondVenue: 0,
    maxBuyPpm: 0,
  } as const;
}

export function stonkCoinUrl(symbol: string, id: bigint | number): string {
  const slug = symbol.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24) || 'token';
  return `https://stonkbrokers.io/safe-launch/token/${STONK_LANE}-${slug}-${id}`;
}

export function launchCreated(r: EvmReceipt): { id: bigint; token: string } | null {
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== STONK_PAD.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: STONK_ABI, data: log.data, topics: log.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (ev.eventName === 'LaunchCreated') {
        const a = ev.args as { id: bigint; token: string };
        return { id: a.id, token: a.token.toLowerCase() };
      }
    } catch {
      /* other event */
    }
  }
  return null;
}

export function stonkFollowUps(id: bigint, token: string): { label: string; tx: EvmTx }[] {
  return [
    { label: 'approve the supply', tx: { to: getAddress(token) as `0x${string}`, data: encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [STONK_PAD, STONK_SUPPLY] }), value: 0n } },
    { label: 'arm the launch', tx: { to: STONK_PAD, data: encodeFunctionData({ abi: STONK_ABI, functionName: 'arm', args: [id, STONK_SUPPLY] }), value: 0n } },
  ];
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

/** Dry-runs create -> approve -> arm in one simulated block. Throws the revert if any step fails. */
export async function simulateStonk(from: string, create: EvmTx): Promise<{ id: bigint; token: string }> {
  const out = await evmRpc<`0x${string}`>('eth_call', [{ from, to: create.to, data: create.data, value: hex(create.value) }, 'latest']);
  const [id, token] = decodeFunctionResult({ abi: STONK_ABI, functionName: 'createLaunch', data: out }) as readonly [bigint, string];
  const calls = [create, ...stonkFollowUps(id, token).map((f) => f.tx)].map((t) => ({ from, to: t.to, data: t.data, value: hex(t.value) }));
  const sim = await evmRpc<{ calls: { status: string; error?: { message?: string } }[] }[]>('eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']).catch(
    () => null, // RPC without simulateV1: the eth_call above already proved the create
  );
  const failed = sim?.[0]?.calls.findIndex((c) => c.status !== '0x1') ?? -1;
  if (failed >= 0) throw new Error(`StonkLauncher ${['create', 'approve', 'arm'][failed]} would fail: ${sim![0].calls[failed].error?.message ?? 'reverted'}`);
  return { id, token: token.toLowerCase() };
}

export const stonk: EvmLaunchpad = {
  id: 'stonk',
  name: 'StonkLauncher',
  tagline: 'StonkBrokers Smart Launch, flat 1% tax',
  costHint: 'free launch, ~$0.05 gas over 3 txs',
  devBuy: false,
  launchPrompts: 3,
  overheadEth: 0.0002,
  async prepare(input: EvmLaunchInput): Promise<PreparedEvmLaunch> {
    const name = input.name.replace(/\s+/g, ' ').trim().slice(0, 32);
    const symbol = input.ticker.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
    const fee = BigInt(await evmRpc<string>('eth_call', [{ to: STONK_PAD, data: encodeFunctionData({ abi: STONK_ABI, functionName: 'launchFeeWei' }) }, 'latest']));
    if (fee > 10n ** 16n) throw Object.assign(new Error('StonkLauncher launches are closed right now (fee switched off-scale). pick another launchpad.'), { friendly: true });
    const tx: EvmTx = { to: STONK_PAD, data: encodeFunctionData({ abi: STONK_ABI, functionName: 'createLaunch', args: [stonkCreateParams(name, symbol)] }), value: fee };
    const sim = await simulateStonk(input.creator, tx);
    return {
      tx,
      predicted: sim.token,
      tokenFrom: (r) => launchCreated(r)?.token ?? null,
      followUps: (r) => {
        const c = launchCreated(r);
        if (!c) throw new Error('StonkLauncher: launch id missing from the receipt');
        return stonkFollowUps(c.id, c.token);
      },
      coinUrl: (token, r) => {
        const c = r ? launchCreated(r) : null;
        return c ? stonkCoinUrl(symbol, c.id) : `https://robinhoodchain.blockscout.com/token/${token}`;
      },
    };
  },
};
