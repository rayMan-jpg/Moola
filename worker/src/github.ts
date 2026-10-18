// GitHub: one public repo per job under GITHUB_OWNER. The engine pushes the clone to it, and
// static builds get GitHub Pages switched on from their gh-pages branch.

import type { Env } from './env';

export interface Repo {
  url: string;
  fullName: string;
  branch: string;
}

/** Waits before each retry of a transient GitHub failure; a retry-after header (capped) wins. */
const GH_RETRY_MS = [1_000, 3_000];
const GH_RETRY_AFTER_MAX_MS = 10_000;

/** How long to wait before retrying a response, or null when retrying won't help. */
function ghRetryDelay(r: Response, fallback: number): number | null {
  const rateLimited = r.status === 429 || (r.status === 403 && (r.headers.get('x-ratelimit-remaining') === '0' || r.headers.has('retry-after')));
  if (!rateLimited && r.status < 500) return null;
  const after = Number(r.headers.get('retry-after') ?? NaN);
  return Number.isFinite(after) && after >= 0 ? Math.min(after * 1000, GH_RETRY_AFTER_MAX_MS) : fallback;
}

async function gh(env: Env, f: typeof fetch, path: string, init: RequestInit = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const r = await f(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'user-agent': 'rea4u',
        'x-github-api-version': '2022-11-28',
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    const wait = attempt < GH_RETRY_MS.length ? ghRetryDelay(r, GH_RETRY_MS[attempt]) : null;
    if (wait === null) return r;
    await r.body?.cancel().catch(() => undefined);
    await new Promise((done) => setTimeout(done, wait));
  }
}

function toRepo(r: { html_url: string; full_name: string; default_branch: string }): Repo {
  return { url: r.html_url, fullName: r.full_name, branch: r.default_branch || 'main' };
}

let ownerKind: 'org' | 'user' | null = null;

async function isOrg(env: Env, f: typeof fetch): Promise<boolean> {
  if (!ownerKind) {
    const r = await gh(env, f, `/users/${env.GITHUB_OWNER}`);
    if (!r.ok) throw new Error(`GitHub owner lookup failed: ${r.status}`);
    ownerKind = ((await r.json()) as { type?: string }).type === 'Organization' ? 'org' : 'user';
  }
  return ownerKind === 'org';
}

/** Creates (or, on retry, reuses) the job's repo. Idempotent per name. */
export async function ensureRepo(env: Env, f: typeof fetch, name: string, description: string, homepage: string): Promise<Repo> {
  const lookup = async () => {
    const r = await gh(env, f, `/repos/${env.GITHUB_OWNER}/${name}`);
    return r.ok ? toRepo(await r.json()) : null;
  };
  const existing = await lookup();
  if (existing) return existing;
  const path = (await isOrg(env, f)) ? `/orgs/${env.GITHUB_OWNER}/repos` : '/user/repos';
  const res = await gh(env, f, path, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: description.slice(0, 340),
      homepage,
      private: false,
      auto_init: true,
      is_template: true,
      has_wiki: false,
      has_projects: false,
    }),
  });
  if (res.ok) return toRepo(await res.json());
  // 422 "name already exists": an earlier (retried or timed-out) create went through after all.
  const again = res.status === 422 ? await lookup() : null;
  if (again) return again;
  throw new Error(`GitHub repo create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

/** If the engine pushed a gh-pages branch, turn on Pages and return the live URL. */
export async function enablePages(env: Env, f: typeof fetch, fullName: string): Promise<string | null> {
  const branch = await gh(env, f, `/repos/${fullName}/branches/gh-pages`);
  if (!branch.ok) return null;
  const cur = await gh(env, f, `/repos/${fullName}/pages`);
  if (cur.ok) return ((await cur.json()) as { html_url?: string }).html_url ?? null;
  const res = await gh(env, f, `/repos/${fullName}/pages`, {
    method: 'POST',
    body: JSON.stringify({ build_type: 'legacy', source: { branch: 'gh-pages', path: '/' } }),
  });
  if (!res.ok && res.status !== 409) return null;
  const [owner, repo] = fullName.split('/');
  return `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

/** Fallback for outputs: read a file from the repo's default branch. */
export async function readRepoFile(env: Env, f: typeof fetch, fullName: string, path: string): Promise<string | null> {
  const r = await gh(env, f, `/repos/${fullName}/contents/${path}`, { headers: {} });
  if (!r.ok) return null;
  const j = (await r.json()) as { content?: string; encoding?: string };
  if (j.encoding !== 'base64' || !j.content) return null;
  const bin = atob(j.content.replace(/\n/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
