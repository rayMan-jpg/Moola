// Live Robinhood Chain simulation of the µToken launch rea4u sends (one tx). Nothing is sent.
import { decodeFunctionResult, encodeFunctionData, getAddress, toHex } from 'viem';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { evmRpc } from '../../src/evm/chain';
import { UTOKEN_ABI, UTOKEN_FACTORY, UTOKEN_PLAIN, utoken, utokenParams } from '../../src/launchpads/utoken';
import { RICH_EOAS } from './evmHelpers';

const input = {
  name: 'Agent Forge',
  ticker: 'FORGE',
  description: 'Agent Forge ($FORGE) was built by rea4u.',
  logo: 'https://turbo-gateway.com/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  website: 'https://rayman-jpg.github.io/Moola/#/p/q_aaaaaaaaaaaaaaaa',
  devBuyEth: 0,
  creator: RICH_EOAS[0],
};

describe('µToken launch (Robinhood Chain mainnet simulation)', () => {
  it('prepare() simulates from the user and predicts the token', async () => {
    const p = await utoken.prepare(input);
    expect(p.tx.to.toLowerCase()).toBe(UTOKEN_FACTORY.toLowerCase());
    expect(p.predicted).toMatch(/^0x[0-9a-f]{40}$/);
    expect(p.coinUrl(p.predicted!)).toBe(`https://utoken.gg/token/${p.predicted}`);
  }, 60_000);

  it('works from a brand-new address (permissionless) and emits LaunchStarted from the factory', async () => {
    const fresh = getAddress(toHex(randomBytes(20)));
    const data = encodeFunctionData({ abi: UTOKEN_ABI, functionName: 'prepareAndLaunch', args: [UTOKEN_PLAIN, utokenParams({ name: 'Agent Forge', symbol: 'FORGE', description: 'x', logo: input.logo }), '0x', fresh, 0n] });
    const sim = await evmRpc<{ calls: { status: string; returnData: `0x${string}`; logs: { address: string; topics: string[] }[] }[] }[]>('eth_simulateV1', [
      { blockStateCalls: [{ stateOverrides: { [fresh]: { balance: '0xde0b6b3a7640000' } }, calls: [{ from: fresh, to: UTOKEN_FACTORY, data, value: '0x0' }] }] },
      'latest',
    ]);
    const c = sim[0].calls[0];
    expect(c.status).toBe('0x1');
    const [, token] = decodeFunctionResult({ abi: UTOKEN_ABI, functionName: 'prepareAndLaunch', data: c.returnData }) as readonly [bigint, string, string];
    expect(c.logs.some((l) => l.address.toLowerCase() === UTOKEN_FACTORY.toLowerCase())).toBe(true);
    // the new token emits its own logs (what the worker checks when it records the launch)
    expect(c.logs.some((l) => l.address.toLowerCase() === token.toLowerCase())).toBe(true);
  }, 60_000);
});
