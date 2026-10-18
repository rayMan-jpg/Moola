// GitHub: one public repo per job under GITHUB_OWNER. The engine pushes the clone to it, and
// static builds get GitHub Pages switched on from their gh-pages branch.

import type { Env } from './env';

export interface Repo {
  url: string;
  fullName: string;
  branch: string;
}

function gh(env: Env, f: typeof fetch, path: string, init: RequestInit = {}) {
  return f(`https://api.github.com${path}`, {
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
  const existing = await gh(env, f, `/repos/${env.GITHUB_OWNER}/${name}`);
  if (existing.ok) {
    const r = (await existing.json()) as { html_url: string; full_name: string; default_branch: string };
    return { url: r.html_url, fullName: r.full_name, branch: r.default_branch || 'main' };
  }
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
  if (!res.ok) throw new Error(`GitHub repo create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const r = (await res.json()) as { html_url: string; full_name: string; default_branch: string };
  return { url: r.html_url, fullName: r.full_name, branch: r.default_branch || 'main' };
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
