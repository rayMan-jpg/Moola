// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Manifest } from '../../../shared/contract';
import { recommendHosts } from '../../../shared/hosting';

const base = { repoUrl: 'https://github.com/rea4u-builds/forge-abc123', fullName: 'rea4u-builds/forge-abc123', slug: 'forge-abc123', branch: 'main' };
const manifest = (o: Partial<Manifest>): Manifest => ({
  status: 'complete',
  project: 'Forge',
  summary: '',
  target: { url: '', license: 'MIT', approach: 'fork' },
  stack: [],
  kind: 'static',
  needs: { server: false, database: 'none', websockets: false, cron: false, storage: false, env: [] },
  build: {},
  features: [],
  verified: { build: true, smoke: true },
  ...o,
});

describe('hosting recommender', () => {
  it('static + already live on Pages: Pages first, Cloudflare button only when the repo has a wrangler config', () => {
    const m = manifest({ deploy: { files: ['wrangler.jsonc', 'netlify.toml'] } });
    const r = recommendHosts({ ...base, manifest: m, needs: { budget: 'free', traffic: 'hobby', customDomain: false }, live: 'https://rea4u-builds.github.io/forge-abc123/' });
    expect(r[0]).toMatchObject({ id: 'ghpages', best: true, deployUrl: 'https://rea4u-builds.github.io/forge-abc123/' });
    expect(r.find((h) => h.id === 'cloudflare')?.deployUrl).toBe(`https://deploy.workers.cloudflare.com/?url=${encodeURIComponent(base.repoUrl)}`);
    const noWrangler = recommendHosts({ ...base, manifest: manifest({}), needs: { budget: 'free', traffic: 'hobby', customDomain: false } });
    expect(noWrangler.find((h) => h.id === 'cloudflare')?.deployUrl).toBeUndefined();
  });

  it('static + serious traffic: Cloudflare beats Pages', () => {
    const r = recommendHosts({ ...base, manifest: manifest({ deploy: { files: ['wrangler.jsonc'] } }), needs: { budget: 'free', traffic: 'serious', customDomain: true }, live: 'x' });
    expect(r[0].id).toBe('cloudflare');
  });

  it('node + postgres on a free budget: Render, and paid-only hosts drop out', () => {
    const m = manifest({ kind: 'server', needs: { server: true, database: 'postgres', websockets: true, cron: false, storage: false, env: ['DATABASE_URL'] }, deploy: { dockerfile: true } });
    const r = recommendHosts({ ...base, manifest: m, needs: { budget: 'free', traffic: 'hobby', customDomain: false } });
    expect(r[0]).toMatchObject({ id: 'render', forkFirst: true });
    expect(r[0].deployUrl).toBe(`https://render.com/deploy?repo=${encodeURIComponent(base.repoUrl)}`);
    expect(r.findIndex((h) => h.id === 'fly')).toBeGreaterThan(r.findIndex((h) => h.id === 'render'));
    expect(r.some((h) => h.id === 'koyeb')).toBe(false);
  });

  it('sqlite + cron + serious traffic with money: volumes hosts win', () => {
    const m = manifest({ kind: 'server', needs: { server: true, database: 'sqlite', websockets: false, cron: true, storage: true, env: [] }, deploy: { dockerfile: true } });
    const r = recommendHosts({ ...base, manifest: m, needs: { budget: 'any', traffic: 'serious', customDomain: true } });
    expect(['railway', 'fly']).toContain(r[0].id);
    expect(r.some((h) => h.id === 'vercel')).toBe(false); // serverless + SQLite is a bad fit
  });

  it('Next.js app: Vercel, with required env vars passed by name only', () => {
    const m = manifest({ kind: 'fullstack', stack: ['Next.js', 'react'], needs: { server: true, database: 'none', websockets: false, cron: false, storage: false, env: ['OPENAI_API_KEY'] } });
    const r = recommendHosts({ ...base, manifest: m, needs: { budget: 'cheap', traffic: 'real', customDomain: false } });
    expect(r[0].id).toBe('vercel');
    expect(r[0].deployUrl).toContain('&env=OPENAI_API_KEY');
    expect(r[0].cost).toMatch(/non-commercial/);
  });
});
