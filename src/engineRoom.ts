// The engine room: our ECC fork's agents, skills, commands and rules, the playbooks the rea4u
// engine reads while it reverse engineers a target (this is ECC's dashboard, degen edition).
import { coinify, type CatalogItem } from './coinify';
import { $, esc, openModal } from './ui';

interface RawItem {
  k: 'agent' | 'skill' | 'command';
  id: string;
  n: string;
  d: string;
  b: string;
  m?: string;
  t?: string[];
  c?: string;
  lic?: string;
  src?: string;
}
export interface Catalog {
  version: string;
  agents: RawItem[];
  skills: RawItem[];
  commands: RawItem[];
  rules: { l: string; f: string[] }[];
}
type TabId = 'agent' | 'skill' | 'command' | 'rule';

const PAGE = 48;
/** Playbooks the engine is told to read on every job (see engine/system.ts). */
const CORE = new Set(['code-explorer', 'spec-miner', 'planner', 'architect', 'tdd-guide', 'code-reviewer', 'security-reviewer', 'opensource-sanitizer']);

const st = { catalog: null as Catalog | null, tab: 'agent' as TabId, query: '', shown: PAGE };

function items(tab: TabId): CatalogItem[] {
  const c = st.catalog;
  if (!c) return [];
  if (tab === 'rule') return c.rules.map((r) => ({ kind: 'rule', id: `${r.l}-rules`, title: `${r.l}-rules`, description: `${r.f.length} rule files: ${r.f.join(', ')}.` }));
  const raw = tab === 'agent' ? c.agents : tab === 'skill' ? c.skills : c.commands;
  const list = raw.map((r) => ({ kind: r.k, id: r.id, title: r.n, description: r.d }));
  return tab === 'agent' ? [...list.filter((i) => CORE.has(i.id)), ...list.filter((i) => !CORE.has(i.id))] : list;
}

function renderTabs() {
  const c = st.catalog;
  const tabs: [TabId, string, number][] = [
    ['agent', 'Agents', c?.agents.length ?? 0],
    ['skill', 'Skills', c?.skills.length ?? 0],
    ['command', 'Commands', c?.commands.length ?? 0],
    ['rule', 'Rules', c?.rules.length ?? 0],
  ];
  $('tabs').innerHTML = tabs.map(([id, label, n]) => `<button class="tab" type="button" aria-pressed="${st.tab === id}" data-tab="${id}">${label}<span class="n">${n}</span></button>`).join('');
}

function renderGrid() {
  const q = st.query;
  const all = items(st.tab).filter((i) => !q || i.id.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
  const list = all.slice(0, st.shown);
  $('grid').innerHTML = list.length
    ? list
        .map((i) => {
          const c = coinify(i);
          const core = CORE.has(i.id);
          return `<article class="card">
          <div class="card__top">
            <div class="card__emoji" aria-hidden="true">${c.emoji}</div>
            <div><div class="kind">${i.kind === 'rule' ? 'rule set' : i.kind}${core ? ' · used every job' : ''}</div><h3 class="card__title">${esc(i.title)}</h3></div>
          </div>
          <p class="card__desc">${esc(i.description || 'no description yet.')}</p>
          ${st.tab === 'rule' ? '' : `<div class="card__actions"><button class="btn btn--small btn--ghost" type="button" data-read="${esc(i.kind)}|${esc(i.id)}" aria-label="Read the ${esc(i.title)} playbook">Read playbook</button></div>`}
        </article>`;
        })
        .join('')
    : `<div class="empty">nothing matches "${esc(q)}". try another word.</div>`;
  $('more').hidden = all.length <= st.shown;
  $('more').textContent = `Show more (${all.length - st.shown} left)`;
  $('grid-count').textContent = `${all.length} result${all.length === 1 ? '' : 's'}`;
}

function rawFor(kind: string, id: string): RawItem | undefined {
  const c = st.catalog;
  if (!c) return undefined;
  const list = kind === 'agent' ? c.agents : kind === 'command' ? c.commands : c.skills;
  return list.find((r) => r.id === id);
}

$('tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!b) return;
  st.tab = b.dataset.tab as TabId;
  st.shown = PAGE;
  renderTabs();
  renderGrid();
  ($('tabs').querySelector(`[data-tab="${st.tab}"]`) as HTMLElement | null)?.focus();
});

let searchTimer = 0;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    st.query = (e.target as HTMLInputElement).value.trim().toLowerCase();
    st.shown = PAGE;
    renderGrid();
  }, 120);
});

$('more').addEventListener('click', () => {
  st.shown += PAGE;
  renderGrid();
});

$('grid').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-read]');
  if (!b) return;
  const [kind, id] = b.dataset.read!.split('|');
  const r = rawFor(kind, id);
  if (!r) return;
  const meta = [r.m && `model: ${r.m}`, r.t?.length && `tools: ${r.t.join(', ')}`, r.c && `category: ${r.c}`].filter(Boolean).join(' · ');
  openModal(
    r.n.toUpperCase(),
    `<p>${esc(r.d)}</p>${meta ? `<p class="mono">${esc(meta)}</p>` : ''}${
      r.lic && r.src
        ? `<p>This one is ${esc(r.lic)} licensed (not MIT), so the full text lives upstream: <a href="${esc(r.src)}" target="_blank" rel="noopener">read it on GitHub</a>.</p>`
        : `<div class="modal__body">${esc(r.b || '')}</div>`
    }`,
  );
});

export async function initEngineRoom(): Promise<Catalog | null> {
  renderTabs();
  try {
    const res = await fetch('./catalog.json');
    st.catalog = (await res.json()) as Catalog;
  } catch {
    $('grid').innerHTML = '<div class="empty">engine room failed to load. refresh.</div>';
    return null;
  }
  renderTabs();
  renderGrid();
  return st.catalog;
}
