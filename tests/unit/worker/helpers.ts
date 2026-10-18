import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { payMemo, type Quote } from '../../../shared/contract';
import type { Env } from '../../../worker/src/env';
import { utf8Hex } from '../../../worker/src/pay';
import fixture from '../../fixtures/sol-memo-transfer.json';

export const TREASURY_SOL = '4ohMhNctr8aLPkqQoSkxtQa16PvZi1LqHeVvmPvZ66Q5';
export const PAYER_SOL = '6LY1JzAFVZsP2a2xKrtU6znQMQ5h4i7tocWdgrkZzkzF';
export const TREASURY_EVM = '0x1111111111111111111111111111111111111111';
export const PAYER_EVM = '0x2222222222222222222222222222222222222222';
export const SOL_SIG = '5'.repeat(88);
export const EVM_HASH = '0x' + 'ab'.repeat(32);

export function testEnv(over: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    ANTHROPIC_API_KEY: 'sk-test',
    GITHUB_TOKEN: 'ghp_test',
    GITHUB_OWNER: 'rea4u-builds',
    QUOTE_SECRET: 'test-secret-test-secret',
    TREASURY_SOLANA: TREASURY_SOL,
    TREASURY_EVM: TREASURY_EVM,
    SOLANA_RPC: 'https://sol.test',
    RH_RPC: 'https://rh.test',
    RH_CHAIN_ID: '4663',
    SITE_URL: 'https://rea4u.test/app/',
    ...over,
  };
}

type Handler = (req: { url: string; method: string; body: unknown }) => unknown | Response | Promise<unknown | Response>;

/** fetch mock: first matching [method, url regex] wins; JSON-RPC routes match on rpc method. */
export function mockFetch(routes: [string, RegExp, Handler][]) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });
    const rpcMethod = (body as { method?: string })?.method;
    for (const [m, re, h] of routes) {
      const key = m.startsWith('rpc:') ? m.slice(4) : null;
      if (key ? rpcMethod === key && re.test(url) : m === method && re.test(url)) {
        const out = await h({ url, method, body });
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(key ? { jsonrpc: '2.0', id: 1, result: out } : out), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ message: 'not mocked: ' + method + ' ' + url }), { status: 404 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

/** A real mainnet memo+transfer tx (tests/fixtures), re-pointed at a quote. */
export function solPaymentTx(
  q: Quote,
  o: { lamports?: bigint; memo?: string; err?: unknown; blockTime?: number; memoInLogsOnly?: boolean; source?: string } = {},
) {
  const tx = structuredClone(fixture) as Omit<typeof fixture, 'meta'> & { meta: Omit<typeof fixture.meta, 'err'> & { err: unknown } };
  const memo = o.memo ?? payMemo(q.id);
  const ixs = tx.transaction.message.instructions as Record<string, unknown>[];
  const memoIx = ixs.find((i) => i.program === 'spl-memo')!;
  memoIx.parsed = o.memoInLogsOnly ? 'something else' : memo;
  tx.meta.logMessages = tx.meta.logMessages.map((l) => (l.startsWith('Program log: Memo') ? `Program log: Memo (len ${memo.length}): "${memo}"` : l));
  const t = ixs.find((i) => i.program === 'system') as { parsed: { info: Record<string, unknown> } };
  t.parsed.info.destination = q.treasury;
  t.parsed.info.source = o.source ?? PAYER_SOL;
  (tx.transaction.message.accountKeys[0] as { pubkey: string }).pubkey = o.source ?? PAYER_SOL;
  t.parsed.info.lamports = Number(o.lamports ?? BigInt(q.amount));
  tx.meta.err = o.err ?? null;
  tx.blockTime = o.blockTime ?? Math.floor(q.issuedAt / 1000) + 30;
  return tx;
}

export function evmPayment(q: Quote, o: { to?: string; value?: bigint; input?: string; status?: string; chainId?: number; ts?: number; from?: string } = {}) {
  const from = o.from ?? PAYER_EVM;
  return {
    tx: {
      from,
      to: o.to ?? q.treasury,
      value: '0x' + (o.value ?? BigInt(q.amount)).toString(16),
      input: o.input ?? utf8Hex(payMemo(q.id)),
      chainId: '0x' + (o.chainId ?? q.evmChainId ?? 1).toString(16),
      blockNumber: '0x10',
    },
    receipt: { status: o.status ?? '0x1', blockNumber: '0x10', from, logs: [] },
    block: { timestamp: '0x' + Math.floor((o.ts ?? q.issuedAt + 20_000) / 1000).toString(16) },
  };
}

/** A wallet whose transfers can be claimed: an ed25519 key and its base58 address. */
export function solWallet() {
  const secret = ed25519.utils.randomSecretKey();
  const address = bs58.encode(ed25519.getPublicKey(secret));
  return { address, sign: (msg: string) => btoa(String.fromCharCode(...ed25519.sign(new TextEncoder().encode(msg), secret))) };
}

const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const tokenBalance = (mint: string, accountIndex: number) => ({
  accountIndex,
  mint,
  owner: 'AfX3mqKEBVboQpDqDdMneLT7WgWsaw8Q6SR1PRRwEisw',
  programId: TOKEN_2022,
  uiTokenAmount: { amount: '1000000000000000', decimals: 6, uiAmount: 1e9, uiAmountString: '1000000000' },
});

/**
 * jsonParsed getTransaction for a Solana launch (shapes as mainnet returns them): signers, programs
 * (outer or CPI), timing, and the token side. `mints` are created by the tx (token program
 * initializeMint2 + a balance afterwards); `pre`/`post` add bare token balances.
 */
export function solLaunchTx(o: {
  signers: string[];
  others?: string[];
  programs?: string[];
  inner?: string[];
  err?: unknown;
  blockTime?: number;
  mints?: string[];
  pre?: string[];
  post?: string[];
}) {
  const created = o.mints ?? [];
  const initMint = (mint: string) => ({
    program: 'spl-token',
    programId: TOKEN_2022,
    parsed: { type: 'initializeMint2', info: { decimals: 6, mint, mintAuthority: 'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM' } },
    stackHeight: 2,
  });
  return {
    blockTime: o.blockTime ?? Math.floor(Date.now() / 1000),
    meta: {
      err: o.err ?? null,
      innerInstructions: [{ index: 0, instructions: [...created.map(initMint), ...(o.inner ?? []).map((programId) => ({ programId, data: '' }))] }],
      preTokenBalances: (o.pre ?? []).map(tokenBalance),
      postTokenBalances: [...created, ...(o.post ?? [])].map(tokenBalance),
    },
    transaction: {
      message: {
        accountKeys: [...o.signers.map((pubkey) => ({ pubkey, signer: true })), ...(o.others ?? []).map((pubkey) => ({ pubkey, signer: false }))],
        instructions: (o.programs ?? []).map((programId) => ({ programId, accounts: [], data: '' })),
      },
    },
  };
}

export { FakeEngine } from './fakeEngine';

export const PRICES = {
  coinbase: (sym: string, price: number) => ['GET', new RegExp(`api\\.coinbase\\.com/v2/prices/${sym}-USD`), () => ({ data: { amount: String(price) } })] as [string, RegExp, Handler],
  kraken: (pair: string, price: number) => ['GET', new RegExp(`api\\.kraken\\.com.*pair=${pair}`), () => ({ error: [], result: { X: { c: [String(price), '1'] } } })] as [string, RegExp, Handler],
  gemini: (sym: string, price: number) => ['GET', new RegExp(`api\\.gemini\\.com/v1/pubticker/${sym.toLowerCase()}usd`), () => ({ last: String(price) })] as [string, RegExp, Handler],
};
