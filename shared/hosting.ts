// Hosting recommender: ranks deploy targets for a finished clone from what the engine found it
// needs (rea4u.json) and what the user said they want (budget, traffic, custom domain).
// Pure function; the project page renders the result as one-click deploy buttons.

import type { DetectedNeeds, HostingNeeds, Manifest } from './contract';

export interface HostOption {
  id: string;
  name: string;
  /** Short reason this host fits (or the caveat that matters). */
  why: string;
  cost: string;
  /** One-click deploy link, when the host has one. */
  deployUrl?: string;
  /** Manual steps when there's no button (or as a fallback). */
  steps?: string;
  score: number;
  best?: boolean;
}

interface Ctx {
  repoUrl: string;
  fullName: string;
  slug: string;
  branch: string;
  manifest?: Manifest;
  needs: HostingNeeds;
  live?: string;
}

const SERVERLESS_FRAMEWORKS = ['next', 'nextjs', 'next.js', 'nuxt', 'sveltekit', 'remix', 'astro', 'solidstart', 'qwik'];

function has(stack: string[], ...names: string[]) {
  const s = stack.map((x) => x.toLowerCase().replace(/[^a-z0-9.]/g, ''));
  return names.some((n) => s.includes(n.replace(/[^a-z0-9.]/g, '')));
}

export function recommendHosts(c: Ctx): HostOption[] {
  const m = c.manifest;
  const stack = m?.stack ?? [];
  const need: DetectedNeeds = m?.needs ?? { server: false, database: 'none', websockets: false, cron: false, storage: false, env: [] };
  const isStatic = m ? m.kind === 'static' && !need.server : false;
  const unknown = !m;
  const serverless = has(stack, ...SERVERLESS_FRAMEWORKS);
  const workersNative = has(stack, 'hono', 'workers', 'cloudflare', 'wrangler');
  const db = need.database;
  const free = c.needs.budget === 'free';
  const cheap = c.needs.budget === 'cheap';
  const serious = c.needs.traffic === 'serious';
  const real = c.needs.traffic === 'real';
  const repo = encodeURIComponent(c.repoUrl);
  const envList = need.env.length ? `&env=${encodeURIComponent(need.env.join(','))}` : '';
  const out: HostOption[] = [];

  const add = (o: Omit<HostOption, 'score'>, score: number) => out.push({ ...o, score });

  // GitHub Pages: rea4u turns it on for static builds, so it may already be live.
  if (isStatic || unknown) {
    add(
      {
        id: 'ghpages',
        name: 'GitHub Pages',
        why: c.live ? 'already live, rea4u switched it on for you' : 'free static hosting straight from the repo',
        cost: 'free',
        deployUrl: c.live,
        steps: c.live ? undefined : `Repo Settings > Pages > deploy from branch gh-pages`,
      },
      (isStatic ? 70 : 20) + (c.live ? 25 : 0) - (serious ? 25 : 0),
    );
  }

  add(
    {
      id: 'cloudflare',
      name: 'Cloudflare',
      why: isStatic ? 'free global CDN that handles serious traffic' : workersNative ? 'runs Workers code natively, D1/KV for data' : 'free edge hosting for static sites and Workers apps',
      cost: 'free tier, then $5/mo',
      deployUrl: `https://deploy.workers.cloudflare.com/?url=${repo}`,
    },
    (isStatic ? 75 : workersNative ? 85 : unknown ? 40 : 10) + (serious ? 15 : 0) + (need.cron && workersNative ? 5 : 0),
  );

  add(
    {
      id: 'netlify',
      name: 'Netlify',
      why: isStatic ? 'one click from the repo, preview deploys included' : 'static front end plus serverless functions',
      cost: 'free tier',
      deployUrl: `https://app.netlify.com/start/deploy?repository=${repo}`,
    },
    (isStatic ? 68 : serverless && !need.websockets ? 55 : unknown ? 35 : 5) - (db === 'sqlite' ? 30 : 0),
  );

  add(
    {
      id: 'vercel',
      name: 'Vercel',
      why: serverless ? 'home turf for this framework' : 'fast static + serverless hosting',
      cost: 'Hobby is free but non-commercial; Pro $20/mo',
      deployUrl: `https://vercel.com/new/clone?repository-url=${repo}${envList}`,
    },
    (serverless ? 80 : isStatic ? 55 : unknown ? 35 : 5) - (need.websockets ? 40 : 0) - (db === 'sqlite' ? 30 : 0) - (free ? 8 : 0),
  );

  if (!isStatic) {
    add(
      {
        id: 'render',
        name: 'Render',
        why: db === 'postgres' ? 'web service + managed Postgres from one blueprint' : 'deploys the Dockerfile/blueprint, websockets ok',
        cost: 'free tier sleeps when idle; $7/mo always-on',
        deployUrl: `https://render.com/deploy?repo=${repo}`,
      },
      (unknown ? 35 : 62) + (db === 'postgres' ? 12 : 0) + (need.websockets ? 6 : 0) - (serious ? 15 : 0) + (free || real ? 6 : 0),
    );
    add(
      {
        id: 'koyeb',
        name: 'Koyeb',
        why: 'free always-on instance for a small server',
        cost: 'free instance, paid plans for more',
        deployUrl: `https://app.koyeb.com/deploy?type=git&repository=github.com/${c.fullName}&branch=${encodeURIComponent(c.branch)}&name=${encodeURIComponent(c.slug)}`,
      },
      (unknown ? 25 : 55) + (free ? 8 : 0) - (db === 'sqlite' || need.storage ? 25 : 0) - (serious ? 20 : 0),
    );
    add(
      {
        id: 'railway',
        name: 'Railway',
        why: 'server + database + cron + volumes in one project',
        cost: '$5/mo Hobby (includes $5 usage)',
        deployUrl: `https://railway.com/new/github`,
        steps: `New project > Deploy from GitHub repo > ${c.fullName}`,
      },
      (unknown ? 30 : 64) + (db !== 'none' ? 10 : 0) + (need.cron ? 8 : 0) + (need.websockets ? 6 : 0) + (serious ? 10 : 0) - (free ? 40 : 0),
    );
    add(
      {
        id: 'fly',
        name: 'Fly.io',
        why: 'global VMs from the Dockerfile, volumes for SQLite',
        cost: 'pay as you go, ~$2-5/mo small app',
        steps: `brew install flyctl && fly launch --from ${c.repoUrl}`,
      },
      (unknown ? 25 : 58) + (db === 'sqlite' ? 14 : 0) + (need.websockets ? 6 : 0) + (serious ? 12 : 0) - (free ? 40 : 0),
    );
  }

  if (serious || c.needs.budget === 'any') {
    add(
      {
        id: 'vps',
        name: 'Your own VPS',
        why: 'full control, flat price (Hetzner, DigitalOcean...)',
        cost: '~$5/mo',
        steps: `git clone ${c.repoUrl} && cd ${c.slug} && ${m?.deploy?.dockerfile ? 'docker build -t app . && docker run -p 80:${PORT:-3000} app' : (m?.build.install ?? 'npm ci') + ' && ' + (m?.build.start ?? 'npm start')}`,
      },
      (isStatic ? 10 : 40) + (serious ? 15 : 0) - (free ? 50 : cheap ? 5 : 0),
    );
  }

  out.sort((a, b) => b.score - a.score);
  if (out[0]) out[0].best = true;
  return out.slice(0, 5);
}
