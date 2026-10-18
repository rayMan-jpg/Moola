// Hosting recommender: ranks deploy targets for a finished clone from what the engine found it
// needs (rea4u.json) and what the user said they want (budget, traffic, custom domain).
// Pure function; the project page renders the result as one-click deploy buttons.
// Provider facts (URL templates, free tiers, caveats) checked 2026-10-18; see README "Hosting".

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
  /** Hosts that deploy from the source repo need the user to own a copy first. */
  forkFirst?: boolean;
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

function has(list: string[], ...names: string[]) {
  const s = list.map((x) => x.toLowerCase().replace(/[^a-z0-9.]/g, ''));
  return names.some((n) => s.includes(n.replace(/[^a-z0-9.]/g, '')));
}

export function recommendHosts(c: Ctx): HostOption[] {
  const m = c.manifest;
  const stack = m?.stack ?? [];
  const files = m?.deploy?.files ?? [];
  const need: DetectedNeeds = m?.needs ?? { server: false, database: 'none', websockets: false, cron: false, storage: false, env: [] };
  const isStatic = m ? m.kind === 'static' && !need.server : false;
  const unknown = !m;
  const serverless = has(stack, ...SERVERLESS_FRAMEWORKS);
  const hasWrangler = has(files, 'wrangler.jsonc', 'wrangler.toml', 'wrangler.json');
  const workersNative = has(stack, 'hono', 'workers', 'cloudflare', 'wrangler', 'd1');
  const db = need.database;
  const free = c.needs.budget === 'free';
  const anyBudget = c.needs.budget === 'any';
  const serious = c.needs.traffic === 'serious';
  const real = c.needs.traffic === 'real';
  const repo = encodeURIComponent(c.repoUrl);
  const envList = need.env.length ? `&env=${encodeURIComponent(need.env.join(','))}` : '';
  const out: HostOption[] = [];
  const add = (o: Omit<HostOption, 'score'>, score: number) => out.push({ ...o, score });

  // GitHub Pages: rea4u switches it on for static builds, so it may already be live (no login).
  if (isStatic || unknown) {
    add(
      {
        id: 'ghpages',
        name: 'GitHub Pages (instant preview)',
        why: c.live ? 'already live, no login. a preview: move to your own host for real users' : 'free preview from the repo. move to your own host for real users',
        cost: 'free',
        deployUrl: c.live,
        steps: c.live ? undefined : 'Repo Settings > Pages > deploy from branch gh-pages',
      },
      (isStatic ? 62 : 20) + (c.live ? 22 : 0) - (serious ? 25 : 0) - (real ? 8 : 0),
    );
  }

  // Cloudflare's button deploys Workers (static assets included) and needs a wrangler config in the repo.
  const cfReady = hasWrangler || workersNative;
  add(
    {
      id: 'cloudflare',
      name: 'Cloudflare',
      why: isStatic ? 'free global CDN, unlimited static requests, commercial use ok' : workersNative ? 'runs Workers code natively; D1/KV provisioned by the button' : 'edge hosting for static sites and Workers apps',
      cost: 'free (100k requests/day), then $5/mo',
      deployUrl: cfReady || unknown ? `https://deploy.workers.cloudflare.com/?url=${repo}` : undefined,
      steps: cfReady || unknown ? undefined : 'needs a wrangler.jsonc in the repo (Workers + static assets)',
    },
    (isStatic ? (cfReady ? 76 : 50) : workersNative ? 85 : unknown ? 40 : 5) + (serious ? 15 : 0) + (need.cron && workersNative ? 5 : 0),
  );

  add(
    {
      id: 'netlify',
      name: 'Netlify',
      why: isStatic ? 'copies the repo to your account, preview deploys included' : 'static front end plus serverless functions',
      cost: 'free 300 credits/mo (~15 per deploy, 20 per GB); sites pause when used up. $9/mo Personal',
      deployUrl: `https://app.netlify.com/start/deploy?repository=${repo}`,
    },
    (isStatic ? 66 : serverless && !need.websockets ? 55 : unknown ? 35 : 5) - (db === 'sqlite' ? 30 : 0) - (serious ? 10 : 0),
  );

  add(
    {
      id: 'vercel',
      name: 'Vercel',
      why: serverless ? 'home turf for this framework' : 'fast static + serverless hosting',
      cost: 'Hobby free but non-commercial (a token project may count); Pro $20/mo',
      deployUrl: `https://vercel.com/new/clone?repository-url=${repo}&project-name=${encodeURIComponent(c.slug)}${envList}`,
    },
    (serverless ? 80 : isStatic ? 54 : unknown ? 35 : 5) - (need.websockets ? 15 : 0) - (db === 'sqlite' ? 30 : 0) - (free ? 8 : 0),
  );

  if (!isStatic) {
    add(
      {
        id: 'render',
        name: 'Render',
        why: db === 'postgres' ? 'web service + managed Postgres from the repo blueprint' : 'deploys the Dockerfile/blueprint; websockets ok',
        cost: 'free web service sleeps after 15 min idle; free Postgres expires after 30 days; $7/mo always-on',
        deployUrl: `https://render.com/deploy?repo=${repo}`,
        forkFirst: true,
      },
      (unknown ? 35 : 64) + (db === 'postgres' ? 10 : 0) + (need.websockets ? 6 : 0) - (need.cron ? 8 : 0) - (serious ? 15 : 0) + (free || real ? 6 : 0),
    );
    add(
      {
        id: 'railway',
        name: 'Railway',
        why: 'server + database + cron + volumes in one project',
        cost: '$5/mo Hobby (includes $5 usage); free plan is $1/mo credit',
        deployUrl: 'https://railway.com/new',
        steps: `use the template first, then railway.com/new > Deploy from GitHub repo > your copy of ${c.slug}`,
        forkFirst: true,
      },
      (unknown ? 30 : 62) + (db !== 'none' ? 10 : 0) + (need.cron ? 10 : 0) + (need.websockets ? 6 : 0) + (serious ? 10 : 0) - (free ? 40 : 0),
    );
    add(
      {
        id: 'fly',
        name: 'Fly.io',
        why: 'global VMs from the Dockerfile; volumes for SQLite',
        cost: 'no free tier, card required, from $2.19/mo',
        steps: `fly launch --from ${c.repoUrl}`,
      },
      (unknown ? 25 : 56) + (db === 'sqlite' ? 16 : 0) + (need.websockets ? 6 : 0) + (serious ? 12 : 0) - (free ? 45 : 0),
    );
  }

  if (serious || anyBudget) {
    add(
      {
        id: 'vps',
        name: 'Your own VPS',
        why: 'full control, flat price (Hetzner, DigitalOcean...)',
        cost: '~$5/mo',
        steps: `git clone ${c.repoUrl} && cd ${c.slug} && ${m?.deploy?.dockerfile ? 'docker build -t app . && docker run -e PORT=8080 -p 80:8080 app' : `${m?.build.install ?? 'npm ci'} && ${m?.build.start ?? 'npm start'}`}`,
      },
      (isStatic ? 10 : 40) + (serious ? 15 : 0) - (free ? 50 : 0),
    );
  }

  // Once the engine has said what the clone needs, hosts that can't run it are left out.
  const fits = unknown ? out : out.filter((o) => o.score >= 20);
  fits.sort((a, b) => b.score - a.score);
  if (fits[0]) fits[0].best = true;
  return fits.slice(0, 5);
}
