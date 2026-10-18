// Live Robinhood Chain simulation of the exact Pons launch calls rea4u builds. Nothing is sent:
// eth_call / eth_estimateGas run with a state override that funds a throwaway address.
import { decodeFunctionResult, getAddress, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { evmRpc } from '../../src/evm/chain';
import { buildPonsTx, PONS_ABI, PONS_FACTORY, pons } from '../../src/launchpads/pons';
import { makeQuoteFixture } from './evmHelpers';

const USER = '0x00000000000000000000000000000000000bEEF5';
const funded = { [USER]: { balance: '0x56bc75e2d63100000' } }; // 100 ETH

async function call(tx: { to: string; data: string; value: bigint }) {
  return evmRpc<`0x${string}`>('eth_call', [{ from: USER, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` }, 'latest', funded]);
}

const input = {
  name: 'Agent Forge',
  ticker: 'FORGE',
  description: 'rea4u build. clone + spec: https://example.com/should-be-stripped',
  logo: 'https://turbo-gateway.com/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  website: 'https://rayman-jpg.github.io/Moola/#/p/q_aaaaaaaaaaaaaaaa',
  devBuyEth: 0,
  creator: USER,
};

describe('pons launch (Robinhood Chain mainnet simulation)', () => {
  it('reads live factory state', async () => {
    const fee = decodeFunctionResult({
      abi: PONS_ABI,
      functionName: 'launchFee',
      data: await evmRpc('eth_call', [{ to: PONS_FACTORY, data: '0xcf3cf573' }, 'latest']),
    });
    expect(fee).toBeGreaterThan(0n);
  }, 30_000);

  it('launchToken simulates and returns the CREATE2 token', async () => {
    const [launchFee, expectedEconomics] = await Promise.all([
      evmRpc<string>('eth_call', [{ to: PONS_FACTORY, data: '0xcf3cf573' }, 'latest']).then(BigInt),
      evmRpc<`0x${string}`>('eth_call', [{ to: PONS_FACTORY, data: `0xf718b78c${'0'.repeat(128)}` }, 'latest']),
    ]);
    const built = buildPonsTx({ ...input, launchFee, expectedEconomics });
    expect(built.params.description).not.toMatch(/https/);
    expect(built.params.creatorFeeRecipient).toBe(getAddress(USER));
    const out = await call(built.tx);
    const [token, curve] = decodeFunctionResult({ abi: PONS_ABI, functionName: 'launchToken', data: out }) as readonly [string, string];
    expect(token).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(curve).not.toBe(zeroAddress);
    const gas = BigInt(await evmRpc<string>('eth_estimateGas', [{ from: USER, to: built.tx.to, data: built.tx.data, value: `0x${built.tx.value.toString(16)}` }, 'latest', funded]));
    expect(gas).toBeGreaterThan(1_000_000n);
    expect(gas).toBeLessThan(6_000_000n);
  }, 60_000);

  it('launchAndBuy (dev buy) simulates through the router', async () => {
    const launchFee = BigInt(await evmRpc<string>('eth_call', [{ to: PONS_FACTORY, data: '0xcf3cf573' }, 'latest']));
    const built = buildPonsTx({ ...input, devBuyEth: 0.001, launchFee, expectedEconomics: `0x${'0'.repeat(64)}` });
    expect(built.router).toBe(true);
    expect(built.tx.value).toBe(launchFee + 10n ** 15n);
    const out = await call(built.tx);
    const [, , tokensOut] = decodeFunctionResult({ abi: PONS_ABI, functionName: 'launchAndBuy', data: out }) as readonly [string, string, bigint];
    expect(tokensOut).toBeGreaterThan(0n);
  }, 60_000);

  it('a wrong fee is rejected by the contract (the simulation is real)', async () => {
    const built = buildPonsTx({ ...input, launchFee: 1n, expectedEconomics: `0x${'0'.repeat(64)}` });
    await expect(call(built.tx)).rejects.toThrow();
  }, 60_000);

  it('prepare() runs the full pre-sign path for a funded user', async () => {
    // a real, funded EOA (has no code) so prepare()'s own simulation passes without overrides
    const rich = makeQuoteFixture().richEoa;
    const p = await pons.prepare({ ...input, creator: rich });
    expect(p.predicted).toMatch(/^0x[0-9a-f]{40}$/);
    expect(p.coinUrl(p.predicted!)).toBe(`https://ponsfamily.com/launchpad/${p.predicted}`);
    expect(p.tx.to.toLowerCase()).toBe(PONS_FACTORY.toLowerCase());
  }, 60_000);
});
