// USD spot prices for SOL and ETH from keyless public APIs. Two sources are averaged
// when both answer, and quotes refuse to go out when neither does.

type Sym = 'SOL' | 'ETH';

const cache = new Map<Sym, { at: number; price: number }>();
const TTL_MS = 60_000;

async function coinbase(sym: Sym, f: typeof fetch): Promise<number> {
  const r = await f(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`coinbase ${r.status}`);
  const j = (await r.json()) as { data?: { amount?: string } };
  return Number(j.data?.amount);
}

async function kraken(sym: Sym, f: typeof fetch): Promise<number> {
  const pair = sym === 'SOL' ? 'SOLUSD' : 'XETHZUSD';
  const r = await f(`https://api.kraken.com/0/public/Ticker?pair=${pair}`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`kraken ${r.status}`);
  const j = (await r.json()) as { error?: string[]; result?: Record<string, { c?: string[] }> };
  const first = j.result ? Object.values(j.result)[0] : undefined;
  return Number(first?.c?.[0]);
}

export async function usdPrice(sym: Sym, f: typeof fetch = fetch): Promise<number> {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;
  const got = await Promise.allSettled([coinbase(sym, f), kraken(sym, f)]);
  const prices = got
    .filter((g): g is PromiseFulfilledResult<number> => g.status === 'fulfilled')
    .map((g) => g.value)
    .filter((p) => Number.isFinite(p) && p > 0);
  if (!prices.length) throw new Error(`no ${sym} price available right now`);
  if (prices.length === 2 && Math.abs(prices[0] - prices[1]) / Math.min(...prices) > 0.05) {
    throw new Error(`${sym} price sources disagree, try again in a minute`);
  }
  const price = prices.reduce((a, b) => a + b, 0) / prices.length;
  cache.set(sym, { at: Date.now(), price });
  return price;
}

export function clearPriceCache() {
  cache.clear();
}
