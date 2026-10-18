// Live Robinhood Chain dry run of the exact StonkLauncher calls rea4u sends: createLaunch, then
// approve + arm, chained in one simulated block (eth_simulateV1). Nothing is sent.
import { describe, expect, it } from 'vitest';
import { evmRpc } from '../../src/evm/chain';
import { encodeFunctionData } from 'viem';
import { stonk, STONK_ABI, STONK_PAD, simulateStonk, stonkCoinUrl, stonkFollowUps } from '../../src/launchpads/stonk';
import { RICH_EOAS } from './evmHelpers';

const input = {
  name: 'Agent Forge',
  ticker: 'FORGE',
  description: 'rea4u build',
  logo: 'https://turbo-gateway.com/x',
  website: 'https://rayman-jpg.github.io/Moola/#/p/q_aaaaaaaaaaaaaaaa',
  devBuyEth: 0,
  creator: RICH_EOAS[0],
};

describe('StonkLauncher (Robinhood Chain mainnet simulation)', () => {
  it('launch fee is still free and the pad is the live weth2 lane', async () => {
    const fee = BigInt(await evmRpc<string>('eth_call', [{ to: STONK_PAD, data: encodeFunctionData({ abi: STONK_ABI, functionName: 'launchFeeWei' }) }, 'latest']));
    expect(fee).toBeLessThan(10n ** 16n);
  });

  it('prepare() dry-runs create -> approve -> arm from the user', async () => {
    const p = await stonk.prepare(input);
    expect(p.tx.to.toLowerCase()).toBe(STONK_PAD.toLowerCase());
    expect(p.tx.value).toBe(0n);
    expect(p.predicted).toMatch(/^0x[0-9a-f]{40}$/);
  }, 60_000);

  it('the chained simulation reports every step succeeding', async () => {
    const p = await stonk.prepare(input);
    const { id, token } = await simulateStonk(input.creator, p.tx);
    expect(id).toBeGreaterThan(0n);
    expect(token).toBe(p.predicted);
    const calls = [p.tx, ...stonkFollowUps(id, token).map((f) => f.tx)].map((t) => ({ from: input.creator, to: t.to, data: t.data, value: `0x${t.value.toString(16)}` }));
    const sim = await evmRpc<{ calls: { status: string; logs: { address: string }[] }[] }[]>('eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']);
    expect(sim[0].calls.map((c) => c.status)).toEqual(['0x1', '0x1', '0x1']);
    // the token emits its mint Transfer: what the worker checks when recording the token
    expect(sim[0].calls[0].logs.some((l) => l.address.toLowerCase() === token)).toBe(true);
    expect(stonkCoinUrl('FORGE', id)).toBe(`https://stonkbrokers.io/safe-launch/token/weth2-forge-${id}`);
  }, 60_000);

  it('arm without approve fails (the dry run is real)', async () => {
    const p = await stonk.prepare(input);
    const { id, token } = await simulateStonk(input.creator, p.tx);
    const [, arm] = stonkFollowUps(id, token);
    const calls = [p.tx, arm.tx].map((t) => ({ from: input.creator, to: t.to, data: t.data, value: `0x${t.value.toString(16)}` }));
    const sim = await evmRpc<{ calls: { status: string }[] }[]>('eth_simulateV1', [{ blockStateCalls: [{ calls }], validation: false }, 'latest']);
    expect(sim[0].calls[1].status).toBe('0x0');
  }, 60_000);
});
