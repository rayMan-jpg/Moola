// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { brandClash, formatAtomic, hostBrand, hostRoot, parseTarget, slugify, usdToAtomic, validateProjectName } from '../../../shared/contract';

describe('parseTarget', () => {
  it('normalizes GitHub repos in every common spelling', () => {
    for (const s of ['https://github.com/affaan-m/ECC', 'github.com/affaan-m/ECC.git', 'affaan-m/ECC', 'https://github.com/affaan-m/ECC/tree/main/skills', 'http://www.github.com/affaan-m/ECC/']) {
      const t = parseTarget(s);
      expect(t).toMatchObject({ kind: 'github', url: 'https://github.com/affaan-m/ECC', owner: 'affaan-m', repo: 'ECC', label: 'affaan-m/ECC' });
    }
    expect(parseTarget('affaan-m/ECC').brand).toEqual(['ecc', 'affaan-m']);
  });

  it('accepts public websites and drops query, hash and trailing slash', () => {
    const t = parseTarget('notion.so/product?x=1#y');
    expect(t).toMatchObject({ kind: 'web', url: 'https://notion.so/product', host: 'notion.so', label: 'notion.so', brand: ['notion'] });
    expect(parseTarget('https://www.linear.app/').label).toBe('linear.app');
  });

  it('rejects non-public and malformed targets', () => {
    for (const bad of ['', 'localhost:3000', 'http://127.0.0.1/admin', 'https://intranet.local', 'ftp://x.com', 'https://user:pw@x.com', 'github.com/onlyowner', 'not a url at all', 'http://[::1]/']) {
      expect(() => parseTarget(bad), bad).toThrow();
    }
  });
});

describe('brand helpers', () => {
  it('finds the brand label of a host', () => {
    expect(hostBrand('app.notion.so')).toBe('notion');
    expect(hostBrand('www.bbc.co.uk')).toBe('bbc');
    expect(hostRoot('docs.app.linear.app')).toBe('linear.app');
    expect(hostRoot('www.bbc.co.uk')).toBe('bbc.co.uk');
  });

  it('blocks token names and tickers that reuse the original brand', () => {
    const t = parseTarget('https://notion.so');
    expect(brandClash(t, 'Notion Killer', 'NKILL')).toMatch(/notion/);
    expect(brandClash(t, 'Notes4u', 'NOTION')).toMatch(/notion/);
    expect(brandClash(t, 'Noted', 'NOTED')).toBeNull();
    const gh = parseTarget('affaan-m/ECC');
    expect(brandClash(gh, 'ecc maxi', 'MAXI')).toMatch(/ecc/);
    expect(brandClash(gh, 'Agent Forge', 'FORGE')).toBeNull();
  });

  it('validates project names and slugs them', () => {
    expect(validateProjectName('Agent Forge')).toBeNull();
    expect(validateProjectName('x')).not.toBeNull();
    expect(validateProjectName('<script>')).not.toBeNull();
    expect(slugify('Agent Forge 2.0!')).toBe('agent-forge-2-0');
    expect(slugify('!!!')).toBe('clone');
  });
});

describe('money', () => {
  it('converts USD to atomic units, rounding up', () => {
    expect(usdToAtomic(1500, 150, 9)).toBe(100_000_000n); // $15 at $150/SOL = 0.1 SOL
    expect(usdToAtomic(500, 3000, 18)).toBe(1_666_666_666_666_667n); // never undercharges
    expect(() => usdToAtomic(100, 0, 9)).toThrow();
  });

  it('formats atomic amounts without understating them', () => {
    expect(formatAtomic(100_000_000n, 9)).toBe('0.1');
    expect(formatAtomic(1_666_666_666_666_667n, 18)).toBe('0.0017');
    expect(formatAtomic('1999990000', 9)).toBe('2');
    expect(formatAtomic(5n * 10n ** 9n, 9)).toBe('5');
  });
});
