// @vitest-environment node
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs build script without types
import { parseFrontmatter, stripBoilerplate, agentTag, buildCatalog } from '../../scripts/build-catalog.mjs';

describe('catalog build (ported ECC loaders)', () => {
  it('parses folded block scalars', () => {
    const fm = parseFrontmatter('---\nname: x\ndescription: >-\n  line one\n  line two\nlicense: MIT\n---\n\nbody');
    expect(fm.description).toBe('line one line two');
    expect(fm.license).toBe('MIT');
    expect(fm._body).toBe('body');
  });

  it('parses quoted values and inline arrays', () => {
    const fm = parseFrontmatter('---\ndescription: "a: b"\ntools: ["Read", "Grep"]\n---\n');
    expect(fm.description).toBe('a: b');
    expect(fm.tools).toEqual(['Read', 'Grep']);
  });

  it('strips the prompt defense boilerplate but keeps the rest', () => {
    expect(stripBoilerplate('## Prompt Defense Baseline\n\n- rule\n- rule\n\n## Review Process\nstep')).toBe('## Review Process\nstep');
  });

  it('keeps ECC dashboard agent buckets', () => {
    expect(agentTag('code-reviewer')).toBe('reviewer');
    expect(agentTag('go-build-resolver')).toBe('builder');
  });

  it('builds the real forked catalog with licenses respected', () => {
    const c = buildCatalog();
    expect(c.agents.length).toBeGreaterThan(50);
    expect(c.skills.length).toBeGreaterThan(250);
    expect([...c.agents, ...c.skills, ...c.commands].every((x: { d: string }) => x.d && !/^[>|]-?$/.test(x.d))).toBe(true);
    const nonMit = c.skills.filter((s: { lic?: string }) => s.lic);
    expect(nonMit.length).toBeGreaterThan(0);
    expect(nonMit.every((s: { b: string; src: string }) => s.b === '' && s.src.startsWith('https://github.com/affaan-m/ECC/'))).toBe(true);
  });
});
