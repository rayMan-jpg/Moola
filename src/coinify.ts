// Turns an ECC agent / skill / command into coin metadata (name, ticker, description, emoji).
import { hashSeed, rng } from './coinArt';

export interface CatalogItem {
  kind: 'agent' | 'skill' | 'command';
  id: string;
  title: string;
  description: string;
}

export interface CoinDraft {
  name: string;
  ticker: string;
  description: string;
  emoji: string;
}

export const NAME_MAX = 32;
export const TICKER_MAX = 10;
export const DESC_MAX = 480;

const GENERIC = new Set([
  'agent', 'skill', 'skills', 'the', 'and', 'for', 'with', 'of', 'to', 'a', 'an', 'pro', 'max', 'plus', 'helper',
  'patterns', 'pattern', 'workflow', 'guide', 'expert', 'specialist', 'review', 'reviewer', 'ops', 'tool', 'tools',
]);

const EMOJI_RULES: [RegExp, string][] = [
  [/secur|shield|vuln|audit|threat|guard/, '🛡️'],
  [/review|critic|inspect|lint/, '🔍'],
  [/test|tdd|e2e|qa|coverage/, '🧪'],
  [/plan|architect|design-doc|roadmap|spec/, '🗺️'],
  [/build|fix|compile|gradle|cargo/, '🔨'],
  [/python|django|fastapi|pytorch/, '🐍'],
  [/\bgo\b|golang|^go-/, '🐹'],
  [/rust/, '🦀'],
  [/java|kotlin|spring/, '☕'],
  [/swift|ios|apple/, '🍎'],
  [/flutter|dart|android|mobile/, '📱'],
  [/react|frontend|ui|css|tailwind|design/, '🎨'],
  [/doc|readme|write|blog|content|copy/, '📜'],
  [/data|sql|postgres|database|analytics|chart/, '📊'],
  [/ml|model|llm|ai|prompt|eval|agentic/, '🧠'],
  [/market|seo|growth|campaign|social/, '📣'],
  [/trad|defi|token|crypto|amm|prediction|finance/, '📈'],
  [/deploy|docker|k8s|kube|cloud|infra|devops/, '🚀'],
  [/git|pr\b|commit|merge/, '🌳'],
  [/memory|learn|instinct|evolve/, '🧬'],
  [/perf|speed|optimi|cache/, '⚡'],
  [/research|search|investig/, '🕵️'],
  [/video|media|audio|image|slides|presentation/, '🎬'],
  [/game/, '🎮'],
  [/santa|fun|meme/, '🎅'],
];

const NAME_TEMPLATES = [
  '{T}',
  '{T} Inu',
  'Based {T}',
  'Baby {T}',
  '{T} Wif Hat',
  'Super {T}',
  '{T} On Sol',
  '{T}GPT',
  'Turbo {T}',
  'Lil {T}',
  '{T} Maxi',
  'Degen {T}',
];

const DESC_TEMPLATES = [
  '{D} now it has a ticker. ser this agent works harder than your portfolio. forked from ECC, launched with MOOLA.',
  '{D} the devs are literally AI agents. wagmi. forked from ECC, launched with MOOLA.',
  'gm. {D} 1000x engineer, 1000x coin (not financial advice). forked from ECC, launched with MOOLA.',
  '{D} probably nothing. forked from ECC, launched with MOOLA.',
];

export function emojiFor(...texts: string[]): string {
  // First text that matches a rule wins, so an item's id beats words buried in its description.
  for (const text of texts) {
    const t = text.toLowerCase();
    for (const [re, e] of EMOJI_RULES) if (re.test(t)) return e;
  }
  return '🤖';
}

export function titleCase(id: string): string {
  return id
    .replace(/^\//, '')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && /^[a-z0-9]+$/.test(w) && !['inu', 'wif'].includes(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

export function sanitizeTicker(s: string): string {
  return s.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, TICKER_MAX);
}

export function tickerFor(id: string): string {
  const words = id.replace(/^\//, '').split(/[-_\s]+/).filter(Boolean);
  const meaningful = words.filter((w) => !GENERIC.has(w.toLowerCase()));
  const pool = meaningful.length ? meaningful : words;
  // Prefer a single punchy word; fall back to initials for long multi-word ids.
  const best = [...pool].sort((a, b) => b.length - a.length)[0] ?? 'MOOLA';
  if (best.length <= TICKER_MAX && best.length >= 3) return sanitizeTicker(best);
  if (pool.length > 1) return sanitizeTicker(pool.map((w) => w[0]).join('') + 'AI');
  return sanitizeTicker(best);
}

export function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…';
}

/** Trim to at most `max` UTF-8 bytes, preferring a word boundary (on-chain name/symbol limits are bytes). */
export function clipBytes(s: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(s).length <= max) return s;
  let out = '';
  for (const ch of s) {
    if (enc.encode(out + ch).length > max) break;
    out += ch;
  }
  const cut = out.lastIndexOf(' ');
  return (cut > max / 2 ? out.slice(0, cut) : out).trim();
}

export function cleanDescription(d: string): string {
  const one = d.replace(/\s+/g, ' ').replace(/[`*_#>]/g, '').trim();
  if (!one) return '';
  const sentence = one.match(/^.{20,220}?[.!?](\s|$)/)?.[0]?.trim() ?? clip(one, 200);
  return /[.!?…]$/.test(sentence) ? sentence : sentence + '.';
}

/** reroll = 0 gives the canonical coin for an item; higher values give alternative names. */
export function coinify(item: CatalogItem, reroll = 0): CoinDraft {
  const rand = rng(hashSeed(`${item.kind}:${item.id}:${reroll}`));
  const T = titleCase(item.title || item.id);
  const tpl = reroll === 0 ? NAME_TEMPLATES[0] : NAME_TEMPLATES[Math.floor(rand() * NAME_TEMPLATES.length)];
  let name = tpl.replace('{T}', T);
  if (new TextEncoder().encode(name).length > NAME_MAX) name = clipBytes(T, NAME_MAX);
  const D = cleanDescription(item.description) || `${T} from the ECC arsenal.`;
  const description = clip(DESC_TEMPLATES[Math.floor(rand() * DESC_TEMPLATES.length)].replace('{D}', D), DESC_MAX);
  return {
    name,
    ticker: tickerFor(item.id),
    description,
    emoji: emojiFor(item.id, item.description),
  };
}

export interface Validation {
  ok: boolean;
  errors: Partial<Record<'name' | 'ticker' | 'description' | 'image', string>>;
}

export function validateDraft(d: { name: string; ticker: string; description: string }): Validation {
  const errors: Validation['errors'] = {};
  const nameBytes = new TextEncoder().encode(d.name.trim()).length;
  if (!d.name.trim()) errors.name = 'needs a name ser';
  else if ([...d.name.trim()].length < 2) errors.name = 'at least 2 characters';
  else if (nameBytes > NAME_MAX) errors.name = `max ${NAME_MAX} bytes (emoji count double)`;
  if (!d.ticker.trim()) errors.ticker = 'no ticker = no coin';
  else if (!/^[A-Z0-9]{1,10}$/.test(d.ticker)) errors.ticker = 'A-Z / 0-9 only, max 10';
  if ([...d.description].length > DESC_MAX) errors.description = `keep it under ${DESC_MAX} chars`;
  return { ok: Object.keys(errors).length === 0, errors };
}
