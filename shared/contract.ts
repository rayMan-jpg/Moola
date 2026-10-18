// Types and pure helpers shared by the site (src/) and the API worker (worker/).
// Nothing in here may touch the DOM, Node or Workers-only APIs.

export type ChainId = 'solana' | 'robinhood';
export type PadId = 'pump' | 'jup' | 'bonk' | 'pons' | 'stonk' | 'utoken';
export type Tier = 'lite' | 'standard' | 'deep';
export type TargetKind = 'github' | 'web';

export const PAD_CHAIN: Record<PadId, ChainId> = {
  pump: 'solana',
  jup: 'solana',
  bonk: 'solana',
  pons: 'robinhood',
  stonk: 'robinhood',
  utoken: 'robinhood',
};

export const CHAIN_ASSET: Record<ChainId, { symbol: 'SOL' | 'ETH'; decimals: number }> = {
  solana: { symbol: 'SOL', decimals: 9 },
  robinhood: { symbol: 'ETH', decimals: 18 },
};

export interface Target {
  kind: TargetKind;
  /** Normalized URL: https://github.com/<owner>/<repo> or https://<host>/<path> */
  url: string;
  host: string;
  /** Short human label: "owner/repo" or the host */
  label: string;
  /** Brand words that must not appear in the token name (repo name, host's main label). */
  brand: string[];
  owner?: string;
  repo?: string;
}

export interface TierInfo {
  id: Tier;
  name: string;
  usdCents: number;
  blurb: string;
  /** Outcome grader cycles. */
  iterations: number;
  effort: 'medium' | 'high';
}

export const TIERS: Record<Tier, TierInfo> = {
  lite: { id: 'lite', name: 'Lite', usdCents: 500, blurb: 'Full spec + a runnable skeleton of the main flow', iterations: 2, effort: 'medium' },
  standard: { id: 'standard', name: 'Standard', usdCents: 1500, blurb: 'Spec + working clone of the core features', iterations: 3, effort: 'high' },
  deep: { id: 'deep', name: 'Deep', usdCents: 4000, blurb: 'Spec + full-featured clone with tests and deploy configs', iterations: 5, effort: 'high' },
};

export interface HostingNeeds {
  /** free: only free tiers. cheap: up to ~$10/mo. any: whatever fits best. */
  budget: 'free' | 'cheap' | 'any';
  traffic: 'hobby' | 'real' | 'serious';
  customDomain: boolean;
}

export const DEFAULT_NEEDS: HostingNeeds = { budget: 'free', traffic: 'hobby', customDomain: false };

/** What the engine found the clone needs to run. Written by the agent into rea4u.json. */
export interface DetectedNeeds {
  server: boolean;
  database: 'none' | 'sqlite' | 'postgres' | 'mysql' | 'redis' | 'mongo' | 'other';
  websockets: boolean;
  cron: boolean;
  storage: boolean;
  env: string[];
}

export interface Manifest {
  status: 'complete' | 'partial' | 'refused';
  refusal?: string;
  project: string;
  summary: string;
  target: { url: string; license: string; approach: 'fork' | 'clean-room' };
  stack: string[];
  kind: 'static' | 'server' | 'fullstack';
  needs: DetectedNeeds;
  build: { install?: string; build?: string; start?: string; output?: string; port?: number };
  features: { name: string; status: 'done' | 'partial' | 'todo' }[];
  verified: { build: boolean; tests?: string; smoke: boolean };
  deploy?: { dockerfile?: boolean; files?: string[] };
}

export interface Quote {
  v: 1;
  id: string;
  /** Present when this quote tops up an existing job instead of starting one. */
  topup?: string;
  target: Target;
  tier: Tier;
  usdCents: number;
  chain: ChainId;
  asset: 'SOL' | 'ETH';
  /** Atomic units (lamports / wei), decimal string. */
  amount: string;
  priceUsd: number;
  treasury: string;
  /** EVM chain id for robinhood quotes. */
  evmChainId?: number;
  issuedAt: number;
  expiresAt: number;
  sig: string;
}

export interface QuoteRequest {
  target: string;
  tier: Tier;
  chain: ChainId;
  topup?: string;
  usdCents?: number;
}

export interface ProjectInput {
  name: string;
}

export interface TokenInput {
  name: string;
  ticker: string;
  pad: PadId;
}

export interface JobRequest {
  quote: Quote;
  payTx: string;
  /**
   * Only for payments whose rea4u tag the wallet dropped (no memo / empty calldata): a signature by
   * the paying wallet over claimMessage(quote.id, payTx). EVM: personal_sign hex. Solana: base64
   * ed25519 signature of the UTF-8 message.
   */
  claimSig?: string;
  project: ProjectInput;
  token: TokenInput;
  needs: HostingNeeds;
}

export type JobStatus = 'starting' | 'running' | 'paused' | 'done' | 'failed' | 'refused';

export interface FeedItem {
  at: string;
  text: string;
}

export interface TokenRecord extends TokenInput {
  status: 'pending' | 'live' | 'failed';
  mint?: string;
  tx?: string;
  url?: string;
}

export interface JobView {
  id: string;
  createdAt: number;
  status: JobStatus;
  target: Target;
  tier: Tier;
  project: ProjectInput;
  token: TokenRecord;
  needs: HostingNeeds;
  chain: ChainId;
  payer: string;
  budgetCents: number;
  spentCents: number;
  repo?: { url: string; fullName: string; branch: string };
  feed: FeedItem[];
  manifest?: Manifest;
  spec?: string;
  live?: string;
  error?: string;
}

export interface ApiConfig {
  ok: boolean;
  treasury: Partial<Record<ChainId, string>>;
  chains: ChainId[];
  tiers: TierInfo[];
  evmChainId?: number;
}

/** What the paying wallet signs to claim a payment that lost its tag (see JobRequest.claimSig). */
export function claimMessage(quoteId: string, tx: string): string {
  return `rea4u payment claim\nquote: ${quoteId}\ntx: ${tx}`;
}

/** The memo that binds a payment to a quote. Solana: memo instruction. EVM: tx calldata. */
export function payMemo(quoteId: string): string {
  return `rea4u:${quoteId}`;
}

export const QUOTE_ID_RE = /^q_[a-z2-7]{16}$/;
export const JOB_ID_RE = QUOTE_ID_RE;

const GH_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/** Main label of a host: "app.notion.so" -> "notion", "www.example.co.uk" -> "example". */
export function hostBrand(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? host;
  const sld = parts[parts.length - 2];
  const twoLevel = parts.length >= 3 && sld.length <= 3 && ['co', 'com', 'net', 'org', 'gov', 'ac', 'edu'].includes(sld);
  return twoLevel ? parts[parts.length - 3] : sld;
}

/** Registrable-ish domain used for sandbox network allowlisting. */
export function hostRoot(host: string): string {
  const brand = hostBrand(host);
  const h = host.toLowerCase().replace(/^www\./, '');
  const i = h.lastIndexOf(brand + '.');
  return i >= 0 ? h.slice(i) : h;
}

/**
 * Parses what the user typed into a Target. Accepts GitHub repo URLs (with or without
 * scheme, trailing .git, /tree/... paths) and http(s) websites. Throws a user-facing
 * message on anything else.
 */
export function parseTarget(input: string): Target {
  let raw = input.trim();
  if (!raw) throw new Error('paste a GitHub repo or a website to rea');
  if (raw.length > 300) throw new Error('that link is way too long');
  // owner/repo shorthand (GitHub usernames never contain dots, hosts always do)
  if (/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(raw)) raw = `https://github.com/${raw}`;
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("that doesn't look like a link");
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('only http(s) links');
  if (u.username || u.password) throw new Error('no credentials in links');
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || /(^|\.)(localhost|local|internal|onion)$/.test(host)) {
    throw new Error('that host is not a public website');
  }
  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repoRaw] = u.pathname.split('/').filter(Boolean);
    const repo = repoRaw?.replace(/\.git$/, '');
    if (!owner || !repo || !GH_NAME.test(owner) || !GH_NAME.test(repo)) throw new Error('link a GitHub repo: github.com/owner/repo');
    return {
      kind: 'github',
      url: `https://github.com/${owner}/${repo}`,
      host: 'github.com',
      label: `${owner}/${repo}`,
      brand: uniq([repo.toLowerCase(), owner.toLowerCase()]).filter((b) => b.length >= 3),
      owner,
      repo,
    };
  }
  const path = u.pathname.replace(/\/+$/, '');
  return {
    kind: 'web',
    url: `https://${host}${path}`,
    host,
    label: host.replace(/^www\./, ''),
    brand: [hostBrand(host)].filter((b) => b.length >= 3),
  };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Returns a message when the token name/ticker would pass itself off as the original brand. */
export function brandClash(target: Target, name: string, ticker: string): string | null {
  const n = squash(name);
  const t = squash(ticker);
  for (const b of target.brand.map(squash)) {
    if (b.length < 3) continue;
    if (n.includes(b) || t.includes(b) || (t.length >= 3 && b === t)) {
      return `rebrand it: the token can't use "${b}" from the original. that's their name, not yours`;
    }
  }
  return null;
}

export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{1,31}$/;

export function validateProjectName(name: string): string | null {
  if (!PROJECT_NAME_RE.test(name.trim())) return 'project name: 2-32 letters, numbers, spaces, . _ -';
  return null;
}

/** Token names and tickers as the API accepts them (the token name is the project name). */
export const TOKEN_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'!&$-]{1,31}$/u;
export const TICKER_RE = /^[A-Z0-9]{2,10}$/;

/**
 * Every name check the API runs on an order, so the site can refuse BEFORE anything is paid.
 * Returns the offending field and message, or null.
 */
export function validateOrderNames(target: Target, projectName: string, tokenName: string, ticker: string): { field: 'name' | 'ticker'; msg: string } | null {
  const p = validateProjectName(projectName);
  if (p) return { field: 'name', msg: p };
  if (!TOKEN_NAME_RE.test(tokenName.trim())) return { field: 'name', msg: 'token name: 2-32 characters' };
  if (!TICKER_RE.test(ticker)) return { field: 'ticker', msg: 'ticker: 2-10 letters or numbers' };
  const clash = brandClash(target, tokenName, ticker) ?? brandClash(target, projectName, '');
  if (clash) return { field: brandClash(target, tokenName, '') || brandClash(target, projectName, '') ? 'name' : 'ticker', msg: clash };
  return null;
}

/** Repo-safe slug for the clone repository. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clone';
}

/** Converts USD cents to atomic units at a given USD price, rounding up. */
export function usdToAtomic(usdCents: number, priceUsd: number, decimals: number): bigint {
  if (!(priceUsd > 0) || !Number.isFinite(priceUsd)) throw new Error('bad price');
  // Work in integers: cents * 10^decimals / (price in micro-dollars / 10^4)
  const microPrice = BigInt(Math.round(priceUsd * 1e6));
  const num = BigInt(usdCents) * 10n ** BigInt(decimals) * 10n ** 4n;
  return (num + microPrice - 1n) / microPrice;
}

export function formatAtomic(amount: string | bigint, decimals: number, maxFrac = 4): string {
  const v = typeof amount === 'bigint' ? amount : BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').slice(0, maxFrac);
  // round up the last shown digit so the display never understates what's owed
  const exact = v % (base / 10n ** BigInt(maxFrac)) === 0n;
  let fracNum = BigInt(frac || '0');
  let w = whole;
  if (!exact) {
    fracNum += 1n;
    if (fracNum >= 10n ** BigInt(maxFrac)) {
      fracNum = 0n;
      w += 1n;
    }
  }
  const f = fracNum.toString().padStart(maxFrac, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : `${w}`;
}

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
