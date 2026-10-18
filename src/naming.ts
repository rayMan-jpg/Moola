// Suggests a fresh, rebranded name + ticker for the user's version of a target. Never reuses the
// original's brand (the API rejects that too), deterministic per target + reroll.
import { brandClash, type Target } from '../shared/contract';
import { hashSeed, rng } from './coinArt';

const PREFIX = ['Giga', 'Based', 'Hyper', 'Turbo', 'Mega', 'Ultra', 'Chad', 'Moon', 'Degen', 'Alpha', 'Neo', 'Open', 'Rogue', 'Feral', 'Pixel', 'Cyber'];
const SUFFIX = ['Forge', 'Labs', 'Works', 'Hub', 'Kit', 'Stack', 'Engine', 'Studio', 'Base', 'Box', 'Deck', 'Craft', 'Yard', 'Den', 'Mill', 'Foundry'];

export function suggestName(target: Target | null, reroll: number): { name: string; ticker: string } {
  const seed = `${target?.url ?? 'rea4u'}:${reroll}`;
  for (let i = 0; i < 20; i++) {
    const r = rng(hashSeed(`${seed}:${i}`));
    const a = PREFIX[Math.floor(r() * PREFIX.length)];
    const b = SUFFIX[Math.floor(r() * SUFFIX.length)];
    const name = `${a} ${b}`;
    const ticker = tickerFrom(name);
    if (!target || !brandClash(target, name, ticker)) return { name, ticker };
  }
  return { name: 'Rea Forge', ticker: 'REAF' };
}

/** "Giga Forge" -> "GFORGE"; single word -> first 6 letters. Always 2-10 of [A-Z0-9]. */
export function tickerFrom(name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return 'REA';
  if (words.length === 1) return words[0].slice(0, 6).padEnd(2, 'X');
  const last = words[words.length - 1].slice(0, 6);
  return (words.slice(0, -1).map((w) => w[0]).join('') + last).slice(0, 10);
}
