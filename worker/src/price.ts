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

async function gemini(sym: Sym, f: typeof fetch): Promise<number> {
  const r = await f(`https://api.gemini.com/v1/pubticker/${sym.toLowerCase()}usd`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`gemini ${r.status}`);
  return Number(((await r.json()) as { last?: string }).last);
}

/** Median of three exchanges; at least two must answer and sit within 2% of it. */
export async function usdPrice(sym: Sym, f: typeof fetch = fetch): Promise<number> {
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.price;
  const got = await Promise.allSettled([coinbase(sym, f), kraken(sym, f), gemini(sym, f)]);
  const prices = got
    .filter((g): g is PromiseFulfilledResult<number> => g.status === 'fulfilled')
    .map((g) => g.value)
    .filter((p) => Number.isFinite(p) && p > 0)
    .sort((a, b) => a - b);
  if (prices.length < 2) throw new Error(`not enough ${sym} price sources answered, try again in a minute`);
  const price = prices.length === 3 ? prices[1] : (prices[0] + prices[1]) / 2;
  if (prices.filter((p) => Math.abs(p - price) / price <= 0.02).length < 2) {
    throw new Error(`${sym} price sources disagree, try again in a minute`);
  }
  cache.set(sym, { at: Date.now(), price });
  return price;
}

export function clearPriceCache() {
  cache.clear();
}
