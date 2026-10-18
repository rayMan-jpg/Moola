import { describe, expect, it } from 'vitest';
import { coinify, tickerFor, titleCase, validateDraft, sanitizeTicker, emojiFor, cleanDescription, clipBytes, NAME_MAX } from '../../src/coinify';

describe('coinify', () => {
  const item = { kind: 'agent' as const, id: 'code-reviewer', title: 'code-reviewer', description: 'Expert code review specialist. Proactively reviews code for quality.' };

  it('is deterministic for the same item and reroll', () => {
    expect(coinify(item, 3)).toEqual(coinify(item, 3));
  });

  it('canonical coin uses the plain title', () => {
    const c = coinify(item);
    expect(c.name).toBe('Code Reviewer');
    expect(c.ticker).toBe('CODE');
    expect(c.emoji).toBe('🔍');
    expect(c.description).toContain('Expert code review specialist.');
    expect(c.description).toContain('rea4u');
  });

  it('every reroll stays valid', () => {
    for (let r = 0; r < 50; r++) {
      const c = coinify({ ...item, id: 'super-long-kubernetes-deployment-orchestrator-agent', title: 'super-long-kubernetes-deployment-orchestrator-agent' }, r);
      expect(validateDraft(c).ok, JSON.stringify(c)).toBe(true);
      expect(new TextEncoder().encode(c.name).length).toBeLessThanOrEqual(NAME_MAX);
    }
  });

  it('ticker heuristics', () => {
    expect(tickerFor('tdd-guide')).toBe('TDD');
    expect(tickerFor('/plan')).toBe('PLAN');
    expect(tickerFor('security-reviewer')).toBe('SECURITY');
    expect(tickerFor('a-b')).toMatch(/^[A-Z0-9]{1,10}$/);
    expect(tickerFor('internationalization-localization')).toBe('ILAI');
  });

  it('title case keeps short acronyms loud', () => {
    expect(titleCase('go-build-resolver')).toBe('GO Build Resolver');
    expect(titleCase('/e2e')).toBe('E2E');
  });

  it('clips names on byte boundaries', () => {
    expect(clipBytes('Super Long Kubernetes Deployment Orchestrator', 32)).toBe('Super Long Kubernetes');
    expect(new TextEncoder().encode(clipBytes('🚀'.repeat(20), 32)).length).toBeLessThanOrEqual(32);
  });

  it('sanitizes tickers', () => {
    expect(sanitizeTicker('$mo-ola!!')).toBe('MOOLA');
    expect(sanitizeTicker('abcdefghijklmnop')).toHaveLength(10);
  });

  it('picks emojis', () => {
    expect(emojiFor('security-reviewer')).toBe('🛡️');
    expect(emojiFor('rust-build-resolver')).toBe('🔨');
    expect(emojiFor('nothing-matches-here')).toBe('🤖');
    expect(emojiFor('code-reviewer', 'catches security holes')).toBe('🔍');
    expect(emojiFor('zzz', 'catches security holes')).toBe('🛡️');
  });

  it('cleans markdown descriptions', () => {
    expect(cleanDescription('**Bold** `code` thing that does stuff. Second sentence here.')).toBe('Bold code thing that does stuff.');
    expect(cleanDescription('')).toBe('');
  });

  it('validation catches bad input', () => {
    const v = validateDraft({ name: '', ticker: 'bad ticker', description: 'x'.repeat(600) });
    expect(v.ok).toBe(false);
    expect(Object.keys(v.errors).sort()).toEqual(['description', 'name', 'ticker']);
    expect(validateDraft({ name: '🚀'.repeat(9), ticker: 'OK', description: '' }).errors.name).toBeDefined();
  });
});
