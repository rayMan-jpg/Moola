#!/usr/bin/env node
// Builds public/catalog.json from the forked ECC content in ecc/.
// The loaders are ported from ECC's scripts/dashboard-web.js (see ecc/upstream/), trimmed for a static site.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ECC = path.join(ROOT, 'ecc');
const OUT = path.join(ROOT, 'public', 'catalog.json');

const BODY_MAX = { agent: 1200, skill: 800, command: 600 };

export function parseFrontmatter(c) {
  const m = c.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (m) {
    for (const l of m[1].split('\n')) {
      const s = l.indexOf(':');
      if (s <= 0 || /^\s/.test(l)) continue;
      const k = l.slice(0, s).trim();
      let v = l.slice(s + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v.startsWith('[') && v.endsWith(']')) {
        try {
          v = JSON.parse(v);
        } catch {
          v = v.slice(1, -1).split(',').map((x) => x.trim().replace(/["']/g, '')).filter(Boolean);
        }
      }
      fm[k] = v;
    }
  }
  fm._body = c.replace(/\r\n/g, '\n').replace(/^---[\s\S]*?\n---\n*/, '').trim();
  return fm;
}

function read(p) {
  try {
    return parseFrontmatter(fs.readFileSync(p, 'utf8'));
  } catch {
    return { _body: '' };
  }
}

function tools(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v) return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

// Same buckets as ECC's dashboard aType().
export function agentTag(name) {
  if (name.includes('reviewer') || name.includes('-review')) return 'reviewer';
  if (name.includes('build') || name.includes('resolver')) return 'builder';
  if (name.includes('architect')) return 'architect';
  if (name.includes('security')) return 'security';
  return 'other';
}

// Same prefixes as ECC's dashboard loadCommands().
const COMMAND_CATS = { plan: 'Planning', 'prp-': 'Git & PR', pr: 'Git & PR', 'review-': 'Review', 'code-': 'Review', build: 'Build', fix: 'Build', test: 'Testing', e2e: 'Testing', coverage: 'Testing', quality: 'Testing', session: 'Session', save: 'Session', resume: 'Session', skill: 'Knowledge', learn: 'Knowledge', instinct: 'Knowledge', evolve: 'Knowledge', ecc: 'System', hookify: 'System', model: 'System', setup: 'System', multi: 'Multi-Agent', security: 'Security', harness: 'Security', 'go-': 'Languages', 'rust-': 'Languages', 'cpp-': 'Languages', 'kotlin-': 'Languages', 'flutter-': 'Languages', 'react-': 'Languages', 'python-': 'Languages', 'fastapi-': 'Languages', 'gradle-': 'Languages', gan: 'GAN', marketing: 'Marketing', jira: 'Project', pm2: 'Process', cost: 'Analytics', promote: 'Project', aside: 'Other', santa: 'Fun' };

function clip(s, n) {
  return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
}

function listMd(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : [];
}

export function loadAgents(root = ECC) {
  return listMd(path.join(root, 'agents')).map((f) => {
    const fm = read(path.join(root, 'agents', f));
    const id = f.replace(/\.md$/, '');
    return { k: 'agent', id, n: fm.name || id, d: String(fm.description || ''), m: String(fm.model || ''), t: tools(fm.tools), g: agentTag(id), b: clip(fm._body, BODY_MAX.agent) };
  });
}

export function loadSkills(root = ECC) {
  const dir = path.join(root, 'skills');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'SKILL.md')))
    .sort()
    .map((id) => {
      const fm = read(path.join(dir, id, 'SKILL.md'));
      return { k: 'skill', id, n: id, d: String(fm.description || ''), b: clip(fm._body, BODY_MAX.skill) };
    });
}

export function loadCommands(root = ECC) {
  return listMd(path.join(root, 'commands')).map((f) => {
    const fm = read(path.join(root, 'commands', f));
    let c = 'Other';
    for (const [p, cat] of Object.entries(COMMAND_CATS)) if (f.startsWith(p)) { c = cat; break; }
    const id = '/' + f.replace(/\.md$/, '');
    return { k: 'command', id, n: id, d: String(fm.description || fm['argument-hint'] || ''), c, b: clip(fm._body, BODY_MAX.command) };
  });
}

export function loadRules(root = ECC) {
  const dir = path.join(root, 'rules');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.statSync(path.join(dir, d)).isDirectory())
    .sort()
    .map((l) => ({ l, f: listMd(path.join(dir, l)).map((f) => f.replace(/\.md$/, '')) }));
}

export function loadMcps(root = ECC) {
  const out = [];
  const servers = (d) =>
    Object.entries(d.mcpServers || {}).map(([n, v]) => ({ n, type: (v && v.type) || (v && v.url ? 'http' : 'stdio') }));
  const files = [['.mcp.json', path.join(root, '.mcp.json')]];
  const dir = path.join(root, 'mcp-configs');
  if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) files.push([f, path.join(dir, f)]);
  for (const [f, p] of files) {
    try {
      out.push({ f, s: servers(JSON.parse(fs.readFileSync(p, 'utf8'))) });
    } catch {
      /* skip unreadable configs, same as upstream */
    }
  }
  return out;
}

export function loadHooks(root = ECC) {
  const p = path.join(root, 'hooks', 'hooks.json');
  if (!fs.existsSync(p)) return [];
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.metadata.json'), 'utf8'));
  } catch {
    /* metadata sidecar is optional */
  }
  const metaFor = (ev, i) => {
    const m = meta.entries?.[ev] ?? meta.hooks?.[ev] ?? meta[ev];
    return Array.isArray(m) ? m[i] ?? {} : {};
  };
  const hooks = [];
  for (const [ev, entries] of Object.entries(data.hooks || {})) {
    (entries || []).forEach((e, i) => {
      const m = metaFor(ev, i);
      hooks.push({ ev, m: e.matcher || '*', id: m.id || e.id || '', d: m.description || e.description || '' });
    });
  }
  return hooks;
}

export function buildCatalog(root = ECC) {
  let version = '';
  try {
    version = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
  } catch {
    /* optional */
  }
  return {
    source: 'https://github.com/affaan-m/ECC',
    version,
    agents: loadAgents(root),
    skills: loadSkills(root),
    commands: loadCommands(root),
    rules: loadRules(root),
    mcps: loadMcps(root),
    hooks: loadHooks(root),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cat = buildCatalog();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(cat));
  const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
  console.log(
    `[catalog] ${cat.agents.length} agents, ${cat.skills.length} skills, ${cat.commands.length} commands, ` +
      `${cat.rules.length} rule sets, ${cat.mcps.length} mcp configs, ${cat.hooks.length} hooks -> public/catalog.json (${kb} KB)`,
  );
}
