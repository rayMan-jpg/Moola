// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { createJob, getJob, recordToken } from '../../../worker/src/jobs';
import { stonkArmed, tokenLaunchedBy } from '../../../worker/src/launch';
import { clearPriceCache } from '../../../worker/src/price';
import type { JobRecord } from '../../../worker/src/store';
import real from './fixtures/launch-txs.json';
import { mockFetch, PAYER_EVM, PAYER_SOL, SOL_SIG, solLaunchTx, testEnv, TREASURY_SOL } from './helpers';
import { req, world, type World } from './world';

beforeEach(() => clearPriceCache());

const MINT = 'Mint1111111111111111111111111111111111111pump'.slice(0, 44);
const LAUNCH = '8'.repeat(88);
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_PORTAL = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe';
const BONK = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
const DBC = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
const JUP_STUDIO = 'GL6kwZxTaXUXMGAvmmNZSXxANnwtPmKCHprHBM82zYXp';
const WSOL = 'So11111111111111111111111111111111111111112';

const PONS_FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const PONS_ROUTER = '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948';
const STONK_PAD = '0xFCd61B25BbF3AbD6cf0070D6328E351cc30EEC9f';
const UTOKEN_FACTORY = '0xD03FB35ee057dF5933a8a95B362CC3e11a56D4Cf';
const TOKEN_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const LAUNCH_CREATED = '0xa4d3b2dc54656491295ce21a0b888cd8df38e69113e44371344da5088e480a43';
const LAUNCH_ARMED = '0x617dff9af409b81e92edd8d62fb192f25509657b96d203585e3e6b605d4dea26';
const LAUNCH_STARTED = '0x210de8124047a4b63fa93c4eaf6241ea3c9ba5bddd0b064faa8a1c4f7e0de9db';
const TOKEN = '0x' + 'cd'.repeat(20);
const LAUNCH_HASH = '0x' + 'ef'.repeat(32);
const ARM_HASH = '0x' + '12'.repeat(32);

const topic = (addr: string) => '0x' + addr.toLowerCase().slice(2).padStart(64, '0');
const word = (n: number) => '0x' + n.toString(16).padStart(64, '0');

async function solJob(): Promise<World> {
  const w = await world();
  await createJob(req(w), w.d);
  return w;
}

describe('recordToken on Solana', () => {
  const good = () => solLaunchTx({ signers: [PAYER_SOL, MINT], programs: [PUMP], mints: [MINT] });

  it('refuses the job’s own payment tx, with the treasury (or anything in it) as the "mint"', async () => {
    const w = await solJob();
    await expect(recordToken(w.quote.id, { mint: TREASURY_SOL, tx: SOL_SIG }, w.d)).rejects.toThrow(/confirm/);
    expect((await getJob(w.quote.id, w.d)).token.status).toBe('pending');
  });

  it('needs the mint to sign, the payer to sign and the pad’s program to run, without error', async () => {
    const w = await solJob();
    const tryWith = (tx: unknown, mint = MINT) => {
      w.sol[LAUNCH] = tx;
      return recordToken(w.quote.id, { mint, tx: LAUNCH }, w.d);
    };
    const mints = [MINT];
    // a pump.fun buy by the payer: payer-signed, pump program, but no new mint signing
    await expect(tryWith(solLaunchTx({ signers: [PAYER_SOL], others: [MINT], programs: [PUMP], post: [MINT] }))).rejects.toThrow(/confirm/);
    await expect(tryWith(solLaunchTx({ signers: [PAYER_SOL], programs: [PUMP], mints: [PAYER_SOL] }), PAYER_SOL)).rejects.toThrow(/confirm/);
    await expect(tryWith(solLaunchTx({ signers: ['Other1111111111111111111111111111111111111', MINT], programs: [PUMP], mints }))).rejects.toThrow(/confirm/);
    await expect(tryWith(solLaunchTx({ signers: [PAYER_SOL, MINT], programs: [], mints }))).rejects.toThrow(/confirm/);
    await expect(tryWith(solLaunchTx({ signers: [PAYER_SOL, MINT], programs: [BONK], mints }))).rejects.toThrow(/confirm/); // another pad
    await expect(tryWith(solLaunchTx({ signers: [PAYER_SOL, MINT], programs: [PUMP], mints, err: { InstructionError: [1, 'x'] } }))).rejects.toThrow(/confirm/);
    // an older launch by the same wallet doesn't belong to this order
    await expect(tryWith(solLaunchTx({ signers: [PAYER_SOL, MINT], programs: [PUMP], mints, blockTime: Math.floor(w.quote.issuedAt / 1000) - 3600 }))).rejects.toThrow(/confirm/);
    expect((await getJob(w.quote.id, w.d)).token.status).toBe('pending');

    // PumpPortal routes the create through its proxy: pump runs as a CPI
    const v = await tryWith(solLaunchTx({ signers: [PAYER_SOL, MINT], programs: [PUMP_PORTAL], inner: [PUMP], mints }));
    expect(v.token).toMatchObject({ status: 'live', mint: MINT, tx: LAUNCH, url: `https://pump.fun/coin/${MINT}` });
    // first verified record is final
    const MINT2 = 'Mint2222222222222222222222222222222222222222';
    w.sol['9'.repeat(88)] = solLaunchTx({ signers: [PAYER_SOL, MINT2], programs: [PUMP], mints: [MINT2] });
    expect((await recordToken(w.quote.id, { mint: MINT2, tx: '9'.repeat(88) }, w.d)).token.mint).toBe(MINT);
  });

  it('needs the tx to create the mint: the curve config or Jupiter’s co-signer of a Studio create is not it', async () => {
    const w = await world({ pad: 'jup' });
    await createJob(req(w), w.d);
    const CONFIG = 'Cfg1111111111111111111111111111111111111111';
    const COSIGNER = 'Cosign11111111111111111111111111111111111111'.slice(0, 44);
    // Jupiter Studio pre-signs for the vanity mint, the curve config and its co-signer; the pool's
    // quote vault is a new WSOL account
    const studio = (o: Partial<Parameters<typeof solLaunchTx>[0]> = {}) =>
      solLaunchTx({ signers: [PAYER_SOL, CONFIG, MINT, COSIGNER], programs: [DBC, DBC, JUP_STUDIO, DBC], mints: [MINT], post: [WSOL], ...o });
    const tryWith = (tx: unknown, mint: string) => {
      w.sol[LAUNCH] = tx;
      return recordToken(w.quote.id, { mint, tx: LAUNCH }, w.d);
    };
    for (const notMint of [CONFIG, COSIGNER, WSOL]) await expect(tryWith(studio(), notMint)).rejects.toThrow(/confirm/);
    // a mint that already held balances before the tx was not created by it
    await expect(tryWith(studio({ mints: [], pre: [CONFIG], post: [CONFIG] }), CONFIG)).rejects.toThrow(/confirm/);
    expect((await getJob(w.quote.id, w.d)).token.status).toBe('pending');
    // either sign of creation is enough: a balance that only exists after the tx...
    await expect(tryWith(studio({ mints: [], post: [MINT] }), MINT)).resolves.toMatchObject({ token: { status: 'live', mint: MINT } });
  });

  it('...or the token program initializing that mint in the tx', async () => {
    const w = await solJob();
    const tx = solLaunchTx({ signers: [PAYER_SOL, MINT], programs: [PUMP], mints: [MINT] });
    tx.meta.postTokenBalances = [];
    w.sol[LAUNCH] = tx;
    expect((await recordToken(w.quote.id, { mint: MINT, tx: LAUNCH }, w.d)).token.status).toBe('live');
  });

  it('ignores {failed: true}: nobody can mark a token failed', async () => {
    const w = await solJob();
    expect((await recordToken(w.quote.id, { failed: true }, w.d)).token.status).toBe('pending');
    expect((await w.store.getJob(w.quote.id))!.token.status).toBe('pending');
    w.sol[LAUNCH] = good();
    await recordToken(w.quote.id, { mint: MINT, tx: LAUNCH }, w.d);
    expect((await recordToken(w.quote.id, { failed: true }, w.d)).token.status).toBe('live');
  });

  it('writes under the lease on a fresh read, so neither it nor a concurrent poll loses the other’s update', async () => {
    const w = await solJob();
    w.sol[LAUNCH] = good();
    // a status poll is mid-sync (holding the lease) when the token record arrives
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const retrieve = w.engine.retrieveSession.bind(w.engine);
    w.engine.retrieveSession = async () => {
      await gate;
      return retrieve();
    };
    w.engine.snapshot = { status: 'running', spentCents: 777 };
    w.now.t += 10_000;
    const poll = getJob(w.quote.id, w.d);
    w.d.sleep = async () => {
      open();
      await new Promise((r) => setTimeout(r, 5));
    };
    const rec = await recordToken(w.quote.id, { mint: MINT, tx: LAUNCH }, w.d);
    await poll;
    expect(rec.token.status).toBe('live');
    const stored = (await w.store.getJob(w.quote.id))!;
    expect(stored.token.status).toBe('live');
    expect(stored.spentCents).toBe(777);
  });

  it('answers 503 when the job stays busy, and records nothing', async () => {
    const w = await solJob();
    w.sol[LAUNCH] = good();
    const holder = await w.store.lease(w.quote.id, 60_000);
    await expect(recordToken(w.quote.id, { mint: MINT, tx: LAUNCH }, w.d)).rejects.toMatchObject({ status: 503 });
    expect((await w.store.getJob(w.quote.id))!.token.status).toBe('pending');
    await w.store.unlease(w.quote.id, holder!);
    expect((await recordToken(w.quote.id, { mint: MINT, tx: LAUNCH }, w.d)).token.status).toBe('live');
  });
});

describe('recordToken on Robinhood Chain', () => {
  async function evmJob(pad: 'pons' | 'stonk' | 'utoken'): Promise<World> {
    const w = await world({ chain: 'robinhood', pad });
    await createJob(req(w), w.d);
    return w;
  }
  const receipt = (o: { to?: string; from?: string; status?: string; logs: { address: string; topics: string[] }[] }) => ({
    receipt: { status: o.status ?? '0x1', from: o.from ?? PAYER_EVM, to: o.to ?? PONS_FACTORY, blockNumber: '0x20', logs: o.logs.map((l) => ({ ...l, data: '0x' })) },
  });
  const ponsLog = (token = TOKEN, address = PONS_FACTORY, t0 = TOKEN_LAUNCHED) => ({ address, topics: [t0, topic(token), topic('0x' + '01'.repeat(20)), topic(PAYER_EVM)] });

  it('needs a successful payer tx to the pad, and the pad’s creation event naming the token', async () => {
    const w = await evmJob('pons');
    const tryWith = (r: ReturnType<typeof receipt>) => {
      w.evm[LAUNCH_HASH] = r;
      return recordToken(w.quote.id, { mint: TOKEN, tx: LAUNCH_HASH }, w.d);
    };
    // any contract that logged in a payer tx used to pass
    await expect(tryWith(receipt({ to: TOKEN, logs: [{ address: TOKEN, topics: [TOKEN_LAUNCHED, topic(TOKEN)] }] }))).rejects.toThrow(/confirm/);
    await expect(tryWith(receipt({ logs: [ponsLog(TOKEN, TOKEN)] }))).rejects.toThrow(/confirm/); // event from the wrong contract
    await expect(tryWith(receipt({ logs: [ponsLog('0x' + 'aa'.repeat(20))] }))).rejects.toThrow(/confirm/); // another token
    await expect(tryWith(receipt({ logs: [ponsLog(TOKEN, PONS_FACTORY, LAUNCH_CREATED)] }))).rejects.toThrow(/confirm/); // another event
    await expect(tryWith(receipt({ from: '0x' + '33'.repeat(20), logs: [ponsLog()] }))).rejects.toThrow(/confirm/);
    await expect(tryWith(receipt({ status: '0x0', logs: [ponsLog()] }))).rejects.toThrow(/confirm/);
    await expect(tryWith(receipt({ to: STONK_PAD, logs: [ponsLog()] }))).rejects.toThrow(/confirm/);
    // launchAndBuy goes through the router; the factory still emits the event
    const v = await tryWith(receipt({ to: PONS_ROUTER, logs: [ponsLog()] }));
    expect(v.token).toMatchObject({ status: 'live', mint: TOKEN, url: `https://ponsfamily.com/launchpad/${TOKEN}` });
  });

  it('accepts a µToken launch by its LaunchStarted event', async () => {
    const w = await evmJob('utoken');
    w.evm[LAUNCH_HASH] = receipt({ to: UTOKEN_FACTORY, logs: [{ address: UTOKEN_FACTORY, topics: [LAUNCH_STARTED, word(7), topic(TOKEN), topic(PAYER_EVM)] }] });
    expect((await recordToken(w.quote.id, { mint: TOKEN, tx: LAUNCH_HASH }, w.d)).token).toMatchObject({ status: 'live', url: `https://utoken.gg/token/${TOKEN}` });
  });

  it('wants both the StonkLauncher creation event and a confirmed arm of that same launch', async () => {
    const w = await evmJob('stonk');
    w.evm[LAUNCH_HASH] = receipt({ to: STONK_PAD, logs: [{ address: STONK_PAD, topics: [LAUNCH_CREATED, word(42), topic(TOKEN), topic(PAYER_EVM)] }] });
    await expect(recordToken(w.quote.id, { mint: TOKEN, tx: LAUNCH_HASH, armTx: ARM_HASH }, w.d)).rejects.toThrow(/armed/);
    const tryArm = (r: ReturnType<typeof receipt>, armTx = ARM_HASH) => {
      w.evm[ARM_HASH] = r;
      return recordToken(w.quote.id, { mint: TOKEN, tx: LAUNCH_HASH, armTx }, w.d);
    };
    // LaunchArmed(uint256 indexed id, uint256 supply, ...): the launch id is topic 1, the data starts with the supply
    const armed = (id = word(42), o: { address?: string; t0?: string; data?: string } = {}) => ({
      address: o.address ?? STONK_PAD,
      topics: [o.t0 ?? LAUNCH_ARMED, id],
      data: o.data ?? '0x' + (10n ** 27n).toString(16).padStart(64, '0') + '0'.repeat(192),
    });
    const armReceipt = (log = armed(), o: { from?: string; status?: string; to?: string } = {}) => ({
      receipt: { status: o.status ?? '0x1', from: o.from ?? PAYER_EVM, to: o.to ?? STONK_PAD, blockNumber: '0x21', logs: [log] },
    });
    // the creation tx itself, posted as its own arm, used to mark the token live before it was armed
    await expect(tryArm(armReceipt(), LAUNCH_HASH)).rejects.toThrow(/armed/);
    await expect(tryArm(armReceipt(), LAUNCH_HASH.toUpperCase().replace('0X', '0x'))).rejects.toThrow(/armed/);
    await expect(tryArm(armReceipt(armed(word(41))))).rejects.toThrow(/armed/); // arms another launch
    await expect(tryArm(armReceipt(armed(word(7), { data: word(42) + '0'.repeat(192) })))).rejects.toThrow(/armed/); // id only in the data
    await expect(tryArm(armReceipt(armed(word(42), { t0: '0x' + '99'.repeat(32) })))).rejects.toThrow(/armed/); // some other pad event
    await expect(tryArm(armReceipt(armed(word(42), { address: TOKEN })))).rejects.toThrow(/armed/); // not from the pad
    await expect(tryArm(armReceipt(armed(), { from: '0x' + '33'.repeat(20) }))).rejects.toThrow(/armed/);
    await expect(tryArm(armReceipt(armed(), { status: '0x0' }))).rejects.toThrow(/armed/);
    await expect(tryArm(armReceipt(armed(), { to: TOKEN }))).rejects.toThrow(/armed/);
    expect((await getJob(w.quote.id, w.d)).token.status).toBe('pending');
    w.evm[ARM_HASH] = armReceipt();
    const url = 'https://stonkbrokers.io/safe-launch/token/weth2-forge-42';
    expect((await recordToken(w.quote.id, { mint: TOKEN, tx: LAUNCH_HASH, armTx: ARM_HASH, url }, w.d)).token).toMatchObject({ status: 'live', url });
    // a creation event for the token in topic 1 (the launch id slot) would not have counted
    const w2 = await evmJob('stonk');
    w2.evm[LAUNCH_HASH] = receipt({ to: STONK_PAD, logs: [{ address: STONK_PAD, topics: [LAUNCH_CREATED, topic(TOKEN), word(1), topic(PAYER_EVM)] }] });
    w2.evm[ARM_HASH] = w.evm[ARM_HASH];
    await expect(recordToken(w2.quote.id, { mint: TOKEN, tx: LAUNCH_HASH, armTx: ARM_HASH }, w2.d)).rejects.toThrow(/confirm/);
  });
});

describe('launch proofs on real mainnet txs (tests/unit/worker/fixtures/launch-txs.json)', () => {
  type Rpc = Record<string, unknown>;
  const rpcFetch = (answers: Rpc) =>
    mockFetch([
      ['rpc:getTransaction', /sol\.test/, ({ body }) => answers[String((body as { params: unknown[] }).params[0])] ?? null],
      ['rpc:eth_getTransactionReceipt', /rh\.test/, ({ body }) => answers[String((body as { params: unknown[] }).params[0])] ?? null],
      ['rpc:eth_getBlockByNumber', /rh\.test/, () => ({ timestamp: '0x6a000000' })],
    ]).fetch;
  const jobOf = (pad: JobRecord['token']['pad'], payer: string, chain: 'solana' | 'robinhood' = 'solana') =>
    ({ payer, quote: { chain, issuedAt: 0 }, token: { pad } }) as unknown as JobRecord;
  const signers = (tx: { transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } } }) =>
    tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);

  it('pump.fun create_v2 (Token-2022): only the new mint passes', async () => {
    const tx = real.pump;
    const [payer, mint] = signers(tx);
    const f = rpcFetch({ [tx.signature]: tx });
    expect(await tokenLaunchedBy(testEnv(), f, jobOf('pump', payer), mint, tx.signature)).toBe(true);
    expect(await tokenLaunchedBy(testEnv(), f, jobOf('jup', payer), mint, tx.signature)).toBe(false); // another pad's program
    // a token account opened in the same tx for an existing mint is not a creation (and not a signer)
    const other = tx.meta.postTokenBalances.map((b) => b.mint).find((m) => m !== mint)!;
    expect(await tokenLaunchedBy(testEnv(), f, jobOf('pump', payer), other, tx.signature)).toBe(false);
  });

  it('Jupiter Studio create: four signers, but the curve config and the co-signer are not the mint', async () => {
    const tx = real.jup;
    const keys = signers(tx);
    expect(keys).toHaveLength(4);
    const [payer, config, mint, cosigner] = keys;
    expect(mint).toMatch(/jupx$/); // Jupiter's vanity mint
    const f = rpcFetch({ [tx.signature]: tx });
    const proves = (m: string, t: unknown = tx) => tokenLaunchedBy(testEnv(), rpcFetch({ [tx.signature]: t }), jobOf('jup', payer), m, tx.signature);
    expect(await tokenLaunchedBy(testEnv(), f, jobOf('jup', payer), mint, tx.signature)).toBe(true);
    for (const notMint of [config, cosigner, WSOL]) expect(await proves(notMint)).toBe(false);
    // each sign of creation holds on its own on the real shape: the initializeMint2...
    const noBalances = structuredClone(tx);
    noBalances.meta.postTokenBalances = [];
    expect(await proves(mint, noBalances)).toBe(true);
    // ...and the balance that only exists after the tx
    const noInit = structuredClone(tx);
    for (const g of noInit.meta.innerInstructions) g.instructions = g.instructions.filter((i) => (i as { parsed?: { type?: string } }).parsed?.type !== 'initializeMint2');
    expect(await proves(mint, noInit)).toBe(true);
    noInit.meta.postTokenBalances = [];
    expect(await proves(mint, noInit)).toBe(false);
  });

  it('StonkLauncher create + arm: the arm names the created launch id in topic 1', async () => {
    const { create, arm } = real.stonk;
    const payer = create.receipt.from;
    const created = create.receipt.logs.find((l) => l.topics[0] === LAUNCH_CREATED)!;
    const token = '0x' + created.topics[2].slice(26);
    const armedLog = arm.receipt.logs.find((l) => l.topics[0] === LAUNCH_ARMED)!;
    expect(armedLog.topics[1]).toBe(created.topics[1]); // the id is indexed
    expect(BigInt('0x' + armedLog.data.slice(2, 66))).toBe(10n ** 27n); // the first data word is the supply
    const f = rpcFetch({ [create.hash]: create.receipt, [arm.hash]: arm.receipt });
    const job = jobOf('stonk', payer, 'robinhood');
    expect(await tokenLaunchedBy(testEnv(), f, job, token, create.hash)).toBe(true);
    expect(await stonkArmed(testEnv(), f, job, token, create.hash, arm.hash)).toBe(true);
    expect(await stonkArmed(testEnv(), f, job, token, create.hash, create.hash)).toBe(false);
    expect(await stonkArmed(testEnv(), f, job, token, arm.hash, create.hash)).toBe(false);
    expect(await stonkArmed(testEnv(), f, job, '0x' + 'cd'.repeat(20), create.hash, arm.hash)).toBe(false); // not this launch's token
    expect(await stonkArmed(testEnv(), f, jobOf('stonk', PAYER_EVM, 'robinhood'), token, create.hash, arm.hash)).toBe(false);
  });
});
