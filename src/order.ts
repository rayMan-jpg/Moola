// The rea order form: target -> depth -> name/logo -> launchpad -> hosting vibe -> REA IT.
import { brandClash, DEFAULT_NEEDS, formatUsd, parseTarget, TIERS, validateProjectName, type HostingNeeds, type PadId, type Target, type Tier } from '../shared/contract';
import { engineStatus } from './api';
import { placeOrder, type Step } from './checkout';
import { canvasToBlob, drawCoinArt } from './coinArt';
import { emojiFor, sanitizeTicker } from './coinify';
import { friendlyError } from './errors';
import { stripImageMetadata } from './metadata';
import { suggestName } from './naming';
import { CHAIN_LABEL, PADS, padInfo, type PadInfo } from './pads';
import { $, announce, confetti, esc, modalOpen, reducedMotion, toast } from './ui';

const IMAGE_MAX = 20 * 1024 * 1024;

const PICKS: [string, string][] = [
  ['affaan-m/ECC', 'ECC (our own engine)'],
  ['excalidraw/excalidraw', 'Excalidraw'],
  ['calendly.com', 'Calendly'],
  ['linear.app', 'Linear'],
  ['pump.fun', 'pump.fun'],
];

const st = {
  target: null as Target | null,
  tier: 'standard' as Tier,
  pad: 'pump' as PadId,
  devBuy: 0,
  needs: { ...DEFAULT_NEEDS } as HostingNeeds,
  reroll: 0,
  upload: null as Blob | null,
  /** The user typed their own name/ticker: never overwrite it with a suggestion. */
  named: false,
  busy: false,
  engineOk: null as boolean | null,
};

const els = {
  form: $<HTMLFormElement>('order'),
  target: $<HTMLInputElement>('target'),
  name: $<HTMLInputElement>('name'),
  ticker: $<HTMLInputElement>('ticker'),
  canvas: $<HTMLCanvasElement>('art-canvas'),
  uploadImg: $<HTMLImageElement>('art-upload'),
  imageInput: $<HTMLInputElement>('image-input'),
  submit: $<HTMLButtonElement>('rea-it'),
  steps: $<HTMLOListElement>('steps'),
  msg: $('order-msg'),
  sendBar: $('send-bar'),
  sendBarBtn: $<HTMLButtonElement>('send-bar-btn'),
};

let onDone: (jobId: string) => void = () => {};

// ── target ──
function renderPicks() {
  $('picks').innerHTML = PICKS.map(([v, label]) => `<button type="button" class="chip" data-pick="${esc(v)}">${esc(label)}</button>`).join('');
}

let ghTimer = 0;
function setTarget(raw: string, announceIt = false) {
  $('target-err').textContent = '';
  els.target.removeAttribute('aria-invalid');
  try {
    st.target = raw.trim() ? parseTarget(raw) : null;
  } catch (e) {
    st.target = null;
    $('target-info').textContent = '';
    if (announceIt) $('target-err').textContent = (e as Error).message;
    updateSummary();
    return;
  }
  const t = st.target;
  const info = $('target-info');
  if (!t) info.textContent = '';
  else if (t.kind === 'github') {
    info.innerHTML = `<b>GitHub repo</b> · ${esc(t.label)} <span class="muted">checking...</span>`;
    clearTimeout(ghTimer);
    ghTimer = window.setTimeout(() => githubInfo(t), 350);
  } else {
    info.innerHTML = `<b>Website</b> · ${esc(t.label)} · clean-room rebuild from its public pages`;
  }
  if (!st.named) applySuggestion();
  updateSummary();
}

async function githubInfo(t: Target) {
  try {
    const r = await fetch(`https://api.github.com/repos/${t.owner}/${t.repo}`, { headers: { accept: 'application/vnd.github+json' } });
    if (st.target?.url !== t.url) return;
    if (r.status === 404) {
      $('target-info').innerHTML = `<b>GitHub repo</b> · ${esc(t.label)} · <span class="bad">not found or private. rea4u only does public stuff</span>`;
      return;
    }
    const j = (await r.json()) as { stargazers_count?: number; license?: { spdx_id?: string } | null; description?: string | null; language?: string | null };
    const lic = j.license?.spdx_id && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : 'no license';
    const approach = /^(MIT|Apache-2\.0|BSD|ISC|MPL|GPL|AGPL|LGPL|Unlicense|0BSD)/i.test(lic) ? 'license-respecting fork' : 'clean-room rebuild';
    $('target-info').innerHTML = `<b>GitHub repo</b> · ${esc(t.label)} · ⭐ ${(j.stargazers_count ?? 0).toLocaleString()} · ${esc(lic)}${j.language ? ` · ${esc(j.language)}` : ''} · <span class="good">${approach}</span>`;
  } catch {
    /* rate limited: no extra info, not a problem */
  }
}

$('picks').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pick]');
  if (!b) return;
  els.target.value = b.dataset.pick!;
  setTarget(els.target.value, true);
  els.target.focus();
});
els.target.addEventListener('input', () => setTarget(els.target.value));
els.target.addEventListener('blur', () => setTarget(els.target.value, true));

// ── tiers ──
function renderTiers() {
  $('tiers').innerHTML = Object.values(TIERS)
    .map(
      (t) => `<button type="button" class="pad" role="radio" aria-checked="${t.id === st.tier}" tabindex="${t.id === st.tier ? 0 : -1}" data-tier="${t.id}">
        ${t.id === 'standard' ? '<span class="pad__badge" aria-hidden="true">BEST VALUE</span>' : ''}
        <span class="pad__name">${esc(t.name)} · ${formatUsd(t.usdCents)}</span>
        <span class="pad__meta">${esc(t.blurb)}</span>
      </button>`,
    )
    .join('');
}
radioGroup('tiers', 'tier', () => Object.keys(TIERS), () => st.tier, (v) => {
  st.tier = v as Tier;
  renderTiers();
  updateSummary();
});

// ── name, ticker, logo ──
function applySuggestion() {
  const s = suggestName(st.target, st.reroll);
  els.name.value = s.name;
  els.ticker.value = s.ticker;
  scheduleArt();
}

let artTimer = 0;
function scheduleArt() {
  clearTimeout(artTimer);
  artTimer = window.setTimeout(renderArt, 120);
}
async function renderArt() {
  if (st.upload) return;
  await drawCoinArt(els.canvas, { ticker: els.ticker.value || 'REA', emoji: emojiFor(els.name.value, st.target?.label ?? ''), seed: `${els.name.value}:${st.reroll}` });
}
async function currentImage(): Promise<Blob> {
  if (st.upload) return st.upload;
  await renderArt();
  return canvasToBlob(els.canvas, 'image/jpeg');
}

const ART_HINT = 'auto-generated logo. or upload a png/jpg/gif/webp.';
els.imageInput.addEventListener('change', async () => {
  const f = els.imageInput.files?.[0];
  els.imageInput.value = '';
  if (!f) return;
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) return artMsg('png, jpg, gif or webp only');
  if (f.size > IMAGE_MAX) return artMsg('max 20 MB');
  try {
    st.upload = await stripImageMetadata(f); // drops EXIF/GPS before anything gets published
  } catch {
    return artMsg("couldn't read that image, try another");
  }
  if (els.uploadImg.src.startsWith('blob:')) URL.revokeObjectURL(els.uploadImg.src);
  els.uploadImg.src = URL.createObjectURL(st.upload);
  els.uploadImg.hidden = false;
  els.canvas.hidden = true;
  artMsg(`${f.name} locked in. reroll to go back to the generated logo.`);
});
function artMsg(m: string) {
  $('art-hint').textContent = m;
  announce(m);
}

$('reroll').addEventListener('click', () => {
  st.upload = null;
  els.uploadImg.hidden = true;
  els.canvas.hidden = false;
  $('art-hint').textContent = ART_HINT;
  st.reroll++;
  if (!st.named) applySuggestion();
  else scheduleArt();
});

els.name.addEventListener('input', () => {
  st.named = true;
  if (!els.ticker.dataset.touched) els.ticker.value = sanitizeTicker(els.name.value.split(/\s+/).map((w, i, a) => (i < a.length - 1 ? w[0] ?? '' : w.slice(0, 6))).join(''));
  scheduleArt();
  updateSummary();
});
els.ticker.addEventListener('input', (e) => {
  st.named = true;
  els.ticker.dataset.touched = '1';
  if (!(e as InputEvent).isComposing) normalizeTicker();
  scheduleArt();
  updateSummary();
});
els.ticker.addEventListener('compositionend', normalizeTicker);
els.ticker.addEventListener('blur', normalizeTicker);
function normalizeTicker() {
  const v = sanitizeTicker(els.ticker.value);
  if (v !== els.ticker.value) els.ticker.value = v;
}

// ── launchpads ──
function renderPads() {
  $('pads').innerHTML = PADS.map((p) => {
    const on = p.id === st.pad && !p.soon;
    return `<button type="button" class="pad" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-pad="${p.id}"${p.soon ? ' aria-disabled="true" disabled' : ''}>
      ${p.badge || p.soon ? `<span class="pad__badge" aria-hidden="true">${esc(p.soon ? 'SOON' : p.badge!)}</span>` : ''}
      <span class="pad__chain pad__chain--${p.chain}">${esc(CHAIN_LABEL[p.chain])}</span>
      <span class="pad__name">${esc(p.name)}</span>
      <span class="pad__meta">${esc(p.tagline)}</span>
      <span class="pad__meta mono">${p.soon ? 'coming next' : `${p.prompts} wallet prompt${p.prompts > 1 ? 's' : ''} total`}</span>
    </button>`;
  }).join('');
}
radioGroup('pads', 'pad', () => PADS.filter((p) => !p.soon).map((p) => p.id), () => st.pad, (v) => {
  const before = padInfo(st.pad).chain;
  st.pad = v as PadId;
  if (padInfo(st.pad).chain !== before) st.devBuy = 0;
  renderPads();
  renderBuys();
  updateSummary();
});

const BUYS: Record<PadInfo['chain'], number[]> = { solana: [0, 0.1, 0.5, 1], robinhood: [0, 0.001, 0.005, 0.01] };
function renderBuys() {
  const pad = padInfo(st.pad);
  const unit = pad.chain === 'solana' ? 'SOL' : 'ETH';
  $('buy-unit').textContent = `${unit}, optional`;
  const off = pad.devBuy ? '' : ' disabled';
  const buy = pad.devBuy ? st.devBuy : 0;
  const opts = BUYS[pad.chain];
  $('buy-chips').innerHTML =
    opts.map((v) => `<button type="button" class="chip" aria-pressed="${buy === v}" data-buy="${v}"${off}>${v === 0 ? 'none' : v}</button>`).join('') +
    `<input class="chip-input" id="buy-custom" type="number" min="0" step="any" inputmode="decimal" placeholder="custom" aria-label="Custom dev buy in ${unit}" value="${opts.includes(st.devBuy) ? '' : st.devBuy}"${off} />` +
    (pad.devBuy ? '' : `<span class="art__hint">${esc(pad.name)} has no dev buy at launch.</span>`);
}
$('buy-chips').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-buy]');
  if (!b) return;
  st.devBuy = Number(b.dataset.buy);
  renderBuys();
  updateSummary();
  ($('buy-chips').querySelector(`[data-buy="${b.dataset.buy}"]`) as HTMLElement | null)?.focus();
});
$('buy-chips').addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id !== 'buy-custom') return;
  const max = padInfo(st.pad).chain === 'solana' ? 85 : 5;
  const v = Number(t.value);
  st.devBuy = Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0;
  document.querySelectorAll<HTMLElement>('#buy-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.buy) === st.devBuy && !t.value)));
  updateSummary();
});

// ── hosting needs ──
const BUDGET: [HostingNeeds['budget'], string][] = [
  ['free', 'Free only'],
  ['cheap', 'Cheap (≤$10/mo)'],
  ['any', 'Whatever fits'],
];
const TRAFFIC: [HostingNeeds['traffic'], string][] = [
  ['hobby', 'Hobby'],
  ['real', 'Real users'],
  ['serious', 'Serious traffic'],
];
function renderNeeds() {
  $('need-budget').innerHTML = BUDGET.map(([v, l]) => `<button type="button" class="chip" aria-pressed="${st.needs.budget === v}" data-budget="${v}">${l}</button>`).join('');
  $('need-traffic').innerHTML = TRAFFIC.map(([v, l]) => `<button type="button" class="chip" aria-pressed="${st.needs.traffic === v}" data-traffic="${v}">${l}</button>`).join('');
  $<HTMLInputElement>('need-domain').checked = st.needs.customDomain;
}
$('need-budget').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-budget]');
  if (!b) return;
  st.needs.budget = b.dataset.budget as HostingNeeds['budget'];
  renderNeeds();
});
$('need-traffic').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-traffic]');
  if (!b) return;
  st.needs.traffic = b.dataset.traffic as HostingNeeds['traffic'];
  renderNeeds();
});
$<HTMLInputElement>('need-domain').addEventListener('change', (e) => (st.needs.customDomain = (e.target as HTMLInputElement).checked));

// ── summary + steps ──
function updateSummary() {
  const pad = padInfo(st.pad);
  const tier = TIERS[st.tier];
  const unit = pad.chain === 'solana' ? 'SOL' : 'ETH';
  const buy = pad.devBuy && st.devBuy > 0 ? ` + <b>${st.devBuy} ${unit}</b> dev buy` : '';
  const t = els.ticker.value || '???';
  $('summary').innerHTML = `rea <b>${esc(st.target?.label ?? '...')}</b> (${esc(tier.name)}): <b>${formatUsd(tier.usdCents)}</b> engine budget, paid in ${unit} at today's price.
    Then <b>$${esc(t)}</b> launches on <b>${esc(pad.name)}</b> (${esc(pad.costHint)})${buy}. <b>${pad.prompts}</b> wallet prompt${pad.prompts > 1 ? 's' : ''} total.`;
  $('order-sub').textContent = `1 form, ${pad.prompts} wallet prompt${pad.prompts > 1 ? 's' : ''}`;
  const label = st.engineOk === false ? 'ENGINE OFFLINE' : 'REA IT';
  els.submit.textContent = label;
  els.sendBarBtn.textContent = label;
}

const STEP_LABELS: Record<Step, string> = {
  quote: 'Locking the price',
  upload: 'Pinning your logo to Arweave',
  build: 'Building your token launch',
  sign: 'Sign in your wallet (payment + launch together)',
  pay: 'Paying the engine',
  start: 'Booting the ECC engine',
  launch: 'Launching your token',
};
function stepsFor(pad: PadInfo): Step[] {
  return pad.chain === 'solana' ? ['quote', 'upload', 'build', 'sign', 'pay', 'start', 'launch'] : ['quote', 'upload', 'build', 'pay', 'start', 'launch'];
}
function renderSteps(pad: PadInfo) {
  const labels = { ...STEP_LABELS };
  if (pad.chain === 'robinhood') {
    labels.pay = `Pay in your wallet (prompt 1 of ${pad.prompts})`;
    labels.launch = pad.prompts > 2 ? `Launch in your wallet (prompts 2-${pad.prompts})` : `Launch in your wallet (prompt 2 of ${pad.prompts})`;
  }
  els.steps.innerHTML = stepsFor(pad)
    .map((s) => `<li data-step="${s}">${esc(labels[s])}</li>`)
    .join('');
}
function setStep(step: Step | null, mode: 'active' | 'error' = 'active') {
  const lis = [...els.steps.querySelectorAll<HTMLElement>('li')];
  const idx = step ? lis.findIndex((li) => li.dataset.step === step) : lis.length;
  lis.forEach((li, i) => {
    li.dataset.state = i < idx ? 'done' : i === idx ? mode : '';
    if (i === idx) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  if (step && mode === 'active') announce(lis[idx]?.textContent ?? '');
}

function showMsg(html: string, ok = false) {
  els.msg.innerHTML = html ? `<div class="alert${ok ? ' alert--ok' : ''}">${html}</div>` : '';
  if (html) els.msg.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function lock(on: boolean) {
  st.busy = on;
  $<HTMLFieldSetElement>('order-fields').disabled = on;
  els.submit.disabled = on;
  updateSendBar();
}

// ── draft hand-off: carry the order into a wallet's in-app browser ──
interface Draft {
  t: string;
  r: Tier;
  n: string;
  k: string;
  p: PadId;
  b: number;
  h: HostingNeeds;
  x: number;
}
function handoffUrl(): string {
  const d: Draft = { t: els.target.value, r: st.tier, n: els.name.value, k: els.ticker.value, p: st.pad, b: st.devBuy, h: st.needs, x: st.reroll };
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  const u = new URL(location.href);
  u.hash = '';
  u.searchParams.set('d', btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
  return u.toString();
}
function restoreDraft(): boolean {
  const u = new URL(location.href);
  const raw = u.searchParams.get('d');
  if (!raw) return false;
  u.searchParams.delete('d');
  history.replaceState(null, '', u.toString());
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Draft;
    if (typeof d.t !== 'string' || typeof d.n !== 'string') return false;
    els.target.value = d.t.slice(0, 300);
    if (d.r in TIERS) st.tier = d.r;
    if (PADS.some((p) => p.id === d.p && !p.soon)) st.pad = d.p;
    st.devBuy = Math.max(0, Math.min(Number(d.b) || 0, 85));
    st.needs = { budget: d.h?.budget ?? 'free', traffic: d.h?.traffic ?? 'hobby', customDomain: d.h?.customDomain === true };
    st.reroll = Number(d.x) || 0;
    setTarget(els.target.value);
    els.name.value = d.n.slice(0, 32);
    els.ticker.value = sanitizeTicker(d.k ?? '');
    st.named = true;
    toast('your order made it over. hit REA IT');
    return true;
  } catch {
    return false;
  }
}

// ── submit ──
function fieldError(id: string, msg: string) {
  $(`${id}-err`).textContent = msg;
  $(id).setAttribute('aria-invalid', 'true');
  $(id).focus();
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (st.busy) return;
  for (const id of ['target', 'name', 'ticker']) {
    $(`${id}-err`).textContent = '';
    $(id).removeAttribute('aria-invalid');
  }
  showMsg('');
  normalizeTicker();
  setTarget(els.target.value, true);
  if (!st.target) return fieldError('target', $('target-err').textContent || 'paste a GitHub repo or a website to rea');
  const name = els.name.value.trim().replace(/\s+/g, ' ');
  const ticker = sanitizeTicker(els.ticker.value);
  const nameErr = validateProjectName(name);
  if (nameErr) return fieldError('name', nameErr);
  if (ticker.length < 2) return fieldError('ticker', 'ticker: 2-10 letters or numbers');
  const clash = brandClash(st.target, name, ticker);
  if (clash) return fieldError(brandClash(st.target, name, '') ? 'name' : 'ticker', clash);
  if (st.engineOk === false) return showMsg('the rea4u engine is not connected yet, so nothing can be paid. check back soon.');

  const pad = padInfo(st.pad);
  const order = { target: st.target, tier: st.tier, name, ticker, pad, devBuy: pad.devBuy ? st.devBuy : 0, needs: { ...st.needs }, image: await currentImage() };
  lock(true);
  renderSteps(pad);
  els.steps.hidden = false;
  let current: Step | null = null;
  try {
    const r = await placeOrder(order, {
      step: (s) => {
        current = s;
        setStep(s);
      },
      note: (m) => showMsg(esc(m), true),
      handoff: handoffUrl,
    });
    setStep(null);
    if (r.launched) confetti();
    else toast(r.launchError ?? 'token launch pending');
    onDone(r.jobId);
  } catch (err) {
    if ((err as Error).message === 'cancelled') {
      els.steps.hidden = true;
    } else {
      if (current) setStep(current, 'error');
      showMsg(esc(friendlyError(err)));
      announce(friendlyError(err));
    }
  } finally {
    lock(false);
  }
});

// ── sticky REA IT bar (phones: the button is always one tap away) ──
let submitVisible = true;
function updateSendBar() {
  els.sendBar.hidden = submitVisible || st.busy || st.engineOk === false || modalOpen() || $('order-view').hidden;
}
new IntersectionObserver((entries) => {
  submitVisible = entries.some((en) => en.isIntersecting);
  updateSendBar();
}).observe(els.submit);
els.sendBarBtn.addEventListener('click', () => {
  els.form.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  els.form.requestSubmit();
});

/** Arrow-key radio group over buttons with data-<attr>. */
function radioGroup(id: string, attr: string, values: () => string[], current: () => string, select: (v: string) => void) {
  const box = $(id);
  box.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>(`[data-${attr}]`);
    if (!b || b.hasAttribute('disabled')) return;
    select(b.dataset[attr]!);
    (box.querySelector(`[data-${attr}="${b.dataset[attr]}"]`) as HTMLElement | null)?.focus();
  });
  box.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const vs = values();
    const i = vs.indexOf(current());
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    const v = vs[(i + d + vs.length) % vs.length];
    select(v);
    (box.querySelector(`[data-${attr}="${v}"]`) as HTMLElement | null)?.focus();
  });
}

export function setEngineState(ok: boolean, missing?: string[]) {
  st.engineOk = ok;
  const banner = $('engine-banner');
  banner.hidden = ok;
  if (!ok) {
    banner.innerHTML = `<b>Engine offline.</b> The rea4u engine isn't connected yet, so jobs can't be paid for. Look around; the button wakes up the moment it's live.${
      missing?.length ? ` <span class="muted">(${esc(missing.join(', '))})</span>` : ''
    }`;
  }
  updateSummary();
  updateSendBar();
}

export async function initOrder(done: (jobId: string) => void) {
  onDone = done;
  renderPicks();
  renderTiers();
  renderPads();
  renderBuys();
  renderNeeds();
  $('art-hint').textContent = ART_HINT;
  const names = PADS.filter((p) => !p.soon).map((p) => p.name);
  $('pad-names').textContent = `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  if (!restoreDraft()) {
    els.target.value = PICKS[0][0];
    setTarget(els.target.value);
  }
  updateSummary();
  scheduleArt();
  const cfg = await engineStatus();
  const missing = (cfg as { missing?: string[] } | null)?.missing;
  setEngineState(!!cfg?.ok, cfg ? missing : ['engine not deployed']);
}

export function orderBusy() {
  return st.busy;
}
