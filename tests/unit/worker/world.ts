import type { ChainId, JobRequest, PadId, Quote } from '../../../shared/contract';
import type { Deps } from '../../../worker/src/jobs';
import { makeQuote } from '../../../worker/src/quote';
import { MemoryStore } from '../../../worker/src/store';
import { EVM_HASH, evmPayment, FakeEngine, mockFetch, PRICES, SOL_SIG, solPaymentTx, testEnv } from './helpers';

export const MANIFEST = {
  status: 'complete',
  project: 'Agent Forge',
  summary: 'A rebranded agent harness.',
  target: { url: 'https://github.com/affaan-m/ECC', license: 'MIT', approach: 'fork' },
  stack: ['node'],
  kind: 'static',
  needs: { server: false, database: 'none', websockets: false, cron: false, storage: false, env: ['OPENAI_KEY', 'bad key'] },
  build: { install: 'npm ci', build: 'npm run build', output: 'dist' },
  features: [{ name: 'Browse agents', status: 'done' }],
  verified: { build: true, tests: '3 passed', smoke: true },
};

export interface World {
  d: Deps;
  engine: FakeEngine;
  store: MemoryStore;
  calls: { method: string; url: string; body: unknown }[];
  quote: Quote;
  pad: PadId;
  /** Solana getTransaction answer for any signature not in `sol`. */
  payTx: unknown;
  sol: Record<string, unknown>;
  /** Robinhood Chain answers per tx hash. */
  evm: Record<string, { tx?: unknown; receipt?: unknown; block?: unknown }>;
  now: { t: number };
  sleeps: number[];
  gh: {
    created: unknown[];
    pages: boolean;
    ghPagesBranch: boolean;
    /** Repo creates that answer this status first (502 = GitHub blip). */
    createFailures: number;
    createStatus: number;
  };
}

/** A worker wired to fakes: GitHub, price feeds and chain RPCs mocked, engine and store in memory. */
export async function world(o: { chain?: ChainId; pad?: PadId } = {}): Promise<World> {
  const chain = o.chain ?? 'solana';
  const env = testEnv();
  const engine = new FakeEngine();
  const store = new MemoryStore();
  const now = { t: Date.now() };
  const gh = { created: [] as unknown[], pages: false, ghPagesBranch: true, createFailures: 0, createStatus: 502 };
  const w = { payTx: null as unknown, sol: {}, evm: {}, sleeps: [] as number[], pad: o.pad ?? (chain === 'solana' ? 'pump' : 'pons') } as World;
  const evmAnswer = (k: 'tx' | 'receipt' | 'block') => ({ body }: { body: unknown }) => {
    const hash = (body as { params: unknown[] }).params[0];
    if (k === 'block') return Object.values(w.evm)[0]?.block ?? null;
    return w.evm[String(hash)]?.[k] ?? null;
  };
  const { fetch, calls } = mockFetch([
    ['GET', /api\.github\.com\/repos\/affaan-m\/ECC$/, () => ({ private: false, archived: false, size: 900 })],
    PRICES.coinbase('SOL', 150),
    PRICES.kraken('SOLUSD', 150),
    PRICES.coinbase('ETH', 3000),
    PRICES.kraken('XETHZUSD', 3000),
    ['rpc:getTransaction', /sol\.test/, ({ body }) => w.sol[String((body as { params: unknown[] }).params[0])] ?? w.payTx],
    ['rpc:eth_getTransactionByHash', /rh\.test/, evmAnswer('tx')],
    ['rpc:eth_getTransactionReceipt', /rh\.test/, evmAnswer('receipt')],
    ['rpc:eth_getBlockByNumber', /rh\.test/, evmAnswer('block')],
    ['GET', /api\.github\.com\/users\/rea4u-builds$/, () => ({ type: 'Organization' })],
    ['GET', /api\.github\.com\/repos\/rea4u-builds\/[^/]+$/, () => new Response('{}', { status: 404 })],
    [
      'POST',
      /api\.github\.com\/orgs\/rea4u-builds\/repos$/,
      ({ body }) => {
        if (gh.createFailures > 0) {
          gh.createFailures--;
          return new Response('{"message":"bad gateway"}', { status: gh.createStatus, headers: { 'retry-after': '0' } });
        }
        gh.created.push(body);
        const name = (body as { name: string }).name;
        return { html_url: `https://github.com/rea4u-builds/${name}`, full_name: `rea4u-builds/${name}`, default_branch: 'main' };
      },
    ],
    ['GET', /\/branches\/gh-pages$/, () => (gh.ghPagesBranch ? { name: 'gh-pages' } : new Response('{}', { status: 404 }))],
    ['GET', /\/pages$/, () => new Response('{}', { status: 404 })],
    [
      'POST',
      /\/pages$/,
      () => {
        gh.pages = true;
        return { html_url: 'x' };
      },
    ],
  ]);
  const quote = (await makeQuote({ target: 'affaan-m/ECC', tier: 'standard', chain }, env, { fetch })).quote;
  if (chain === 'solana') w.payTx = solPaymentTx(quote);
  else w.evm[EVM_HASH] = evmPayment(quote);
  const d: Deps = {
    env,
    store,
    engine,
    fetch,
    now: () => now.t,
    sleep: async (ms) => {
      w.sleeps.push(ms);
    },
  };
  Object.assign(w, { d, engine, store, calls, quote, now, gh });
  return w;
}

export function req(w: World, over: Partial<JobRequest> = {}): JobRequest {
  return {
    quote: w.quote,
    payTx: w.quote.chain === 'solana' ? SOL_SIG : EVM_HASH,
    project: { name: 'Agent Forge' },
    token: { name: 'Agent Forge', ticker: 'FORGE', pad: w.pad },
    needs: { budget: 'free', traffic: 'hobby', customDomain: false },
    ...over,
  };
}

/** A validly signed top-up quote for the world's job. */
export async function topupQuote(w: World, usdCents = 1000): Promise<Quote> {
  const { quote } = await makeQuote({ target: '', tier: 'lite', chain: w.quote.chain, topup: w.quote.id, usdCents }, w.d.env, {
    fetch: w.d.fetch,
    jobTarget: async () => ({ target: w.quote.target, chain: w.quote.chain, tier: w.quote.tier }),
  });
  return quote;
}
