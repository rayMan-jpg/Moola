import { Buffer } from 'buffer';
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
import './styles.css';
import type { Wallet } from '@wallet-standard/base';
import { VersionedTransaction } from '@solana/web3.js';
import { coinify, validateDraft, sanitizeTicker, emojiFor, NAME_MAX, DESC_MAX, type CatalogItem } from './coinify';
import { drawCoinArt, canvasToBlob } from './coinArt';
import {
  listWallets, onWalletsChanged, onAccountsChanged, connect, disconnect, signAndSend, signOnly, canSignOnly, canSignMessage,
  signMessage, txSignature, isMobile, walletDeeplinks, INSTALL_LINKS, shortAddr, type Connected,
} from './wallet';
import { getBalanceSol, sendRaw, waitForLanding, isBlockhashValid, RpcError, setCustomRpc, rpcUrls, DEFAULT_RPCS } from './rpc';
import { LAUNCHPADS, padById } from './launchpads';
import type { StepId } from './launchpads/types';
import { friendlyError } from './errors';
import { stripImageMetadata } from './metadata';

// ── catalog types (shape produced by scripts/build-catalog.mjs) ──
interface RawItem { k: 'agent' | 'skill' | 'command'; id: string; n: string; d: string; b: string; m?: string; t?: string[]; g?: string; c?: string; lic?: string; src?: string }
interface Catalog { version: string; agents: RawItem[]; skills: RawItem[]; commands: RawItem[]; rules: { l: string; f: string[] }[]; mcps: { f: string; s: { n: string }[] }[]; hooks: { ev: string; m: string; id: string; d: string }[] }
type TabId = 'agent' | 'skill' | 'command' | 'rule';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const PAGE = 48;
/** Phone photos are big; anything is shrunk to a small logo before upload anyway. */
const IMAGE_MAX = 20 * 1024 * 1024;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const state = {
  catalog: null as Catalog | null,
  tab: 'agent' as TabId,
  query: '',
  shown: PAGE,
  /** The catalog item the form was filled from; null once the user goes custom. */
  item: null as CatalogItem | null,
  reroll: 0,
  emoji: '🤖',
  upload: null as Blob | null,
  pad: LAUNCHPADS[0].id,
  devBuy: 0,
  wallet: null as Connected | null,
  busy: false,
  /** User typed into the form; never overwrite their input with an automatic fill. */
  dirty: false,
  /** Description text we generated; while the field still equals it, we may regenerate it. */
  autoDesc: '',
};

const els = {
  name: $<HTMLInputElement>('name'),
  ticker: $<HTMLInputElement>('ticker'),
  description: $<HTMLTextAreaElement>('description'),
  twitter: $<HTMLInputElement>('twitter'),
  telegram: $<HTMLInputElement>('telegram'),
  website: $<HTMLInputElement>('website'),
  canvas: $<HTMLCanvasElement>('art-canvas'),
  uploadImg: $<HTMLImageElement>('art-upload'),
  imageInput: $<HTMLInputElement>('image-input'),
  send: $<HTMLButtonElement>('send-it'),
  sendBar: $('send-bar'),
  sendBarBtn: $<HTMLButtonElement>('send-bar-btn'),
  steps: $<HTMLOListElement>('steps'),
  msg: $('launch-msg'),
  form: $<HTMLFormElement>('launch-form'),
  result: $('result'),
  walletBtn: $<HTMLButtonElement>('wallet-btn'),
  balance: $('balance'),
};

// ── announcements / toast / modal / confetti ──
function announce(msg: string) {
  const s = $('sr-status');
  s.textContent = '';
  requestAnimationFrame(() => (s.textContent = msg));
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  announce(msg);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

const BACKGROUND = ['.marquee', '.header', '#top', 'main', '.footer', '#send-bar'];
function setInert(on: boolean) {
  for (const sel of BACKGROUND) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) el.inert = on;
  }
}

let lastFocus: HTMLElement | null = null;
function openModal(title: string, html: string) {
  if ($('modal').hidden) {
    const a = document.activeElement as HTMLElement | null;
    lastFocus = !a || a === document.body ? els.send : a;
  }
  $('modal-title').textContent = title;
  $('modal-content').innerHTML = html;
  $('modal').hidden = false;
  setInert(true);
  ($('modal').querySelector('button, a, input') as HTMLElement | null)?.focus();
}
/** Hide the dialog and give focus back once the page has re-enabled what it disabled. */
function hideModal() {
  $('modal').hidden = true;
  setInert(false);
  const back = lastFocus;
  setTimeout(() => {
    // :disabled also covers controls inside the disabled fieldset during a launch.
    const target = back && back.isConnected && !back.matches(':disabled') ? back : els.name;
    target.focus({ preventScroll: true });
  }, 0);
}
function closeModal() {
  hideModal();
  pendingConnect?.reject(new Error('cancelled'));
  pendingConnect = null;
}
$('modal').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'modal' || t.closest('[data-close]')) closeModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) closeModal();
});

function confetti() {
  if (reducedMotion()) return;
  const box = document.createElement('div');
  box.className = 'confetti';
  const bits = ['🚀', '💰', '🟢', '💎', '🔥', '$', '🌙'];
  for (let i = 0; i < 60; i++) {
    const s = document.createElement('i');
    s.textContent = bits[i % bits.length];
    s.style.left = `${Math.random() * 100}%`;
    s.style.animationDuration = `${2 + Math.random() * 2.5}s`;
    s.style.animationDelay = `${Math.random() * 0.8}s`;
    box.appendChild(s);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 6000);
}

// ── coin art ──
let artTimer = 0;
function scheduleArt() {
  clearTimeout(artTimer);
  artTimer = window.setTimeout(renderArt, 120);
}
async function renderArt() {
  if (state.upload) return;
  await drawCoinArt(els.canvas, {
    ticker: els.ticker.value || 'MOOLA',
    emoji: state.emoji,
    seed: `${state.item?.id ?? els.name.value}:${state.reroll}`,
  });
}
async function currentImage(): Promise<Blob> {
  if (state.upload) return state.upload;
  await renderArt();
  return canvasToBlob(els.canvas, 'image/jpeg');
}

const ART_HINT = 'auto-generated logo. or upload a png/jpg/gif/webp.';

els.imageInput.addEventListener('change', async () => {
  const f = els.imageInput.files?.[0];
  els.imageInput.value = ''; // so picking the same file again still fires 'change'
  if (!f) return;
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) return artError('png, jpg, gif or webp only ser');
  if (f.size > IMAGE_MAX) return artError('max 20 MB, this is not a museum');
  let clean: Blob;
  try {
    clean = await stripImageMetadata(f); // drops EXIF/GPS before anything gets published
  } catch {
    return artError("couldn't read that image, try another");
  }
  state.upload = clean;
  if (els.uploadImg.src.startsWith('blob:')) URL.revokeObjectURL(els.uploadImg.src);
  els.uploadImg.src = URL.createObjectURL(clean);
  els.uploadImg.hidden = false;
  els.canvas.hidden = true;
  $('art-hint').textContent = `${f.name} locked in. reroll to go back to the auto meme.`;
  announce('picture uploaded');
});

function artError(msg: string) {
  $('art-hint').textContent = msg;
  announce(msg);
}

$('reroll').addEventListener('click', () => {
  state.upload = null;
  els.uploadImg.hidden = true;
  els.canvas.hidden = false;
  $('art-hint').textContent = ART_HINT;
  state.reroll++;
  // From the catalog: new name + art. Custom coin: only new art, never touch what the user typed.
  if (state.item && !state.dirty) fillFromItem(state.item, state.reroll, false);
  else renderArt();
});

// ── form ──
function fillFromItem(item: CatalogItem, reroll = 0, scroll = true) {
  if (state.busy) return toast('hold up, a launch is in progress');
  state.item = item;
  state.reroll = reroll;
  state.dirty = false;
  const c = coinify(item, reroll);
  els.name.value = c.name;
  els.ticker.value = c.ticker;
  els.description.value = c.description;
  state.autoDesc = c.description;
  state.emoji = c.emoji;
  updateCounts();
  clearErrors();
  scheduleArt();
  updateSummary();
  if (scroll) {
    $('launch').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    els.send.focus({ preventScroll: true });
    history.replaceState(null, '', `#/${item.kind}/${encodeURIComponent(item.id)}`);
    announce(`${c.name}, $${c.ticker} loaded into the launch pad`);
  }
}

function customDescription(): string {
  const name = els.name.value.trim() || 'this coin';
  const t = sanitizeTicker(els.ticker.value) || 'MOOLA';
  return `${name} ($${t}). no roadmap, no utility, just vibes. launched with MOOLA.`;
}

/** The user typed their own coin: stop treating the form as a catalog item. */
function goCustom() {
  state.dirty = true;
  state.item = null;
  if (els.description.value === state.autoDesc) {
    els.description.value = state.autoDesc = customDescription();
  }
  state.emoji = emojiFor(els.name.value, els.ticker.value);
  updateCounts();
}

function updateCounts() {
  $('name-count').textContent = `${new TextEncoder().encode(els.name.value).length}/${NAME_MAX}`;
  $('desc-count').textContent = `${[...els.description.value].length}/${DESC_MAX}`;
}
const FIELDS = ['name', 'ticker', 'description'] as const;
function clearErrors() {
  for (const k of FIELDS) {
    $(`${k}-err`).textContent = '';
    $(k).removeAttribute('aria-invalid');
  }
}

// Only the user fires input events here (the app sets .value directly), so any input means "user edited".
els.name.addEventListener('input', () => {
  goCustom();
  updateCounts();
  scheduleArt();
  updateSummary();
});

function normalizeTicker() {
  const v = sanitizeTicker(els.ticker.value);
  if (!state.item && els.description.value === state.autoDesc && state.autoDesc) {
    els.description.value = state.autoDesc = customDescription();
  }
  if (v === els.ticker.value) return;
  const pos = els.ticker.selectionStart;
  els.ticker.value = v;
  if (pos !== null && document.activeElement === els.ticker) els.ticker.setSelectionRange(Math.min(pos, v.length), Math.min(pos, v.length));
}
els.ticker.addEventListener('input', (e) => {
  goCustom();
  // Don't rewrite the value mid-composition (Android/CJK keyboards duplicate text if we do).
  if (!(e as InputEvent).isComposing) normalizeTicker();
  scheduleArt();
  updateSummary();
});
els.ticker.addEventListener('compositionend', () => {
  normalizeTicker();
  updateSummary();
});
els.ticker.addEventListener('blur', normalizeTicker);
els.description.addEventListener('input', () => {
  state.dirty = true;
  updateCounts();
});
for (const el of [els.twitter, els.telegram, els.website]) el.addEventListener('input', () => (state.dirty = true));

function renderPads() {
  $('pads').innerHTML = LAUNCHPADS.map(
    (p) => `<button type="button" class="pad" role="radio" aria-checked="${p.id === state.pad}" tabindex="${p.id === state.pad ? 0 : -1}" data-pad="${p.id}">
      ${p.badge ? `<span class="pad__badge" aria-hidden="true">${esc(p.badge)}</span>` : ''}
      <span class="pad__name">${esc(p.name)}</span>
      <span class="pad__meta">${esc(p.tagline)}</span>
      <span class="pad__meta mono">${p.signatures} signature${p.signatures > 1 ? 's' : ''}${p.devBuy ? '' : ' · no dev buy'}</span>
    </button>`,
  ).join('');
}
function selectPad(id: string, focus: boolean) {
  state.pad = id;
  renderPads();
  renderBuys();
  updateSummary();
  if (focus) ($('pads').querySelector(`[data-pad="${id}"]`) as HTMLElement | null)?.focus();
}
$('pads').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pad]');
  if (b) selectPad(b.dataset.pad!, true);
});
$('pads').addEventListener('keydown', (e) => {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const i = LAUNCHPADS.findIndex((p) => p.id === state.pad);
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  selectPad(LAUNCHPADS[(i + d + LAUNCHPADS.length) % LAUNCHPADS.length].id, true);
});

const BUYS = [0, 0.1, 0.5, 1];
function renderBuys() {
  const pad = padById(state.pad);
  const off = pad.devBuy ? '' : ' disabled';
  const buy = effectiveDevBuy();
  $('buy-chips').innerHTML =
    BUYS.map((v) => `<button type="button" class="chip" aria-pressed="${buy === v}" data-buy="${v}"${off}>${v === 0 ? 'none' : v}</button>`).join('') +
    `<input class="chip-input" id="buy-custom" type="number" min="0" max="85" step="0.01" inputmode="decimal" placeholder="custom" aria-label="Custom dev buy in SOL" value="${BUYS.includes(state.devBuy) ? '' : state.devBuy}"${off} />` +
    (pad.devBuy ? '' : `<span class="art__hint">${esc(pad.name)} has no dev buy at launch. ape your own coin right after.</span>`);
}

function effectiveDevBuy(): number {
  return padById(state.pad).devBuy ? state.devBuy : 0;
}
$('buy-chips').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-buy]');
  if (!b) return;
  state.devBuy = Number(b.dataset.buy);
  renderBuys();
  updateSummary();
  ($('buy-chips').querySelector(`[data-buy="${b.dataset.buy}"]`) as HTMLElement | null)?.focus();
});
$('buy-chips').addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.id !== 'buy-custom') return;
  const v = Number(t.value);
  state.devBuy = Number.isFinite(v) && v > 0 ? Math.min(v, 85) : 0;
  document.querySelectorAll<HTMLElement>('#buy-chips .chip').forEach((c) => c.setAttribute('aria-pressed', String(Number(c.dataset.buy) === state.devBuy && !t.value)));
  updateSummary();
});

function updateSummary() {
  const pad = padById(state.pad);
  const t = els.ticker.value || '???';
  const devBuy = effectiveDevBuy();
  const buy = devBuy > 0 ? `<b>${devBuy} SOL</b> dev buy + ` : 'no dev buy, ';
  renderStepLabels();
  $('summary').innerHTML = `Launching <b>$${esc(t)}</b> on <b>${esc(pad.name)}</b>: ${buy}${esc(pad.costHint)}.`;
  $('launch-sub').textContent = `3 fields, ${pad.signatures} signature${pad.signatures > 1 ? 's' : ''}`;
  const label = state.wallet ? `SEND IT ($${t})` : 'CONNECT + SEND IT';
  els.send.textContent = label;
  els.sendBarBtn.textContent = label;
}

// ── wallet ──
let pendingConnect: { resolve: (c: Connected) => void; reject: (e: Error) => void } | null = null;

function walletIcon(w: Wallet) {
  return w.icon ? `<img src="${esc(w.icon)}" alt="" />` : '';
}

async function ensureWallet(): Promise<Connected> {
  if (state.wallet) return state.wallet;
  const wallets = listWallets();
  if (wallets.length === 1) return doConnect(wallets[0]);
  return new Promise<Connected>((resolve, reject) => {
    pendingConnect = { resolve, reject };
    showWalletPicker();
  });
}

// ── draft hand-off: carry the coin into a wallet's in-app browser ──
interface Draft { n: string; t: string; d: string; p: string; b: number; i?: [string, string]; r: number; s?: [string, string, string] }

function encodeDraft(): string {
  const draft: Draft = {
    n: els.name.value, t: els.ticker.value, d: els.description.value, p: state.pad, b: state.devBuy, r: state.reroll,
    i: state.item ? [state.item.kind, state.item.id] : undefined,
    s: [els.twitter.value, els.telegram.value, els.website.value],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(draft));
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeDraft(s: string): Draft | null {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as Draft;
    return typeof d.n === 'string' && typeof d.t === 'string' ? d : null;
  } catch {
    return null;
  }
}

function handoffUrl(): string {
  const u = new URL(location.href);
  u.searchParams.set('d', encodeDraft());
  return u.toString();
}

function restoreDraft(): boolean {
  const u = new URL(location.href);
  const raw = u.searchParams.get('d');
  if (!raw) return false;
  u.searchParams.delete('d');
  history.replaceState(null, '', u.toString());
  const d = decodeDraft(raw);
  if (!d) return false;
  if (d.i) {
    const kind = (['agent', 'skill', 'command', 'rule'] as TabId[]).find((k) => k === d.i![0]);
    state.item = kind ? items(kind).find((x) => x.id === d.i![1]) ?? null : null;
  }
  state.reroll = d.r || 0;
  els.name.value = d.n.slice(0, 64);
  els.ticker.value = sanitizeTicker(d.t);
  els.description.value = d.d.slice(0, DESC_MAX);
  [els.twitter.value, els.telegram.value, els.website.value] = (d.s ?? ['', '', '']).map((x) => String(x).slice(0, 200));
  if (LAUNCHPADS.some((p) => p.id === d.p)) state.pad = d.p;
  state.devBuy = Math.min(Math.max(Number(d.b) || 0, 0), 85);
  state.emoji = emojiFor(state.item?.id ?? d.n, d.d);
  state.dirty = true;
  renderPads();
  renderBuys();
  updateCounts();
  scheduleArt();
  updateSummary();
  toast('your coin made it over. hit SEND IT');
  return true;
}

function showWalletPicker() {
  const wallets = listWallets();
  if (wallets.length) {
    openModal(
      'PICK YOUR WALLET',
      `<div class="wallets">${wallets.map((w, i) => `<button class="wallet-btn" type="button" data-wallet="${i}">${walletIcon(w)}${esc(w.name)}</button>`).join('')}</div>`,
    );
    $('modal-content').querySelectorAll<HTMLElement>('[data-wallet]').forEach((b) =>
      b.addEventListener('click', async () => {
        const p = pendingConnect;
        pendingConnect = null;
        hideModal();
        try {
          const c = await doConnect(wallets[Number(b.dataset.wallet)]);
          p?.resolve(c);
        } catch (e) {
          p?.reject(e as Error);
        }
      }),
    );
    return;
  }
  const deeplinks = walletDeeplinks(handoffUrl());
  const phone = `<div class="wallets">${deeplinks.map((l) => `<a class="wallet-btn" href="${esc(l.url)}">Open in ${esc(l.name)}</a>`).join('')}</div>`;
  const carry = state.upload ? '<p class="art__hint">your coin details come along; re-upload your pic there.</p>' : '<p class="art__hint">your coin details come along.</p>';
  openModal(
    'NO WALLET DETECTED',
    isMobile()
      ? `<p>Open MOOLA inside your wallet app, then hit SEND IT again:</p>${phone}${carry}`
      : `<p>Install a Solana wallet extension, refresh, and hit SEND IT again:</p>
         <div class="wallets">${INSTALL_LINKS.map((l) => `<a class="wallet-btn" href="${esc(l.url)}" target="_blank" rel="noopener">Get ${esc(l.name)}</a>`).join('')}</div>
         <h3 class="field__label" style="margin-top:16px">On your phone?</h3><p class="art__hint">Open these links on the phone that has the wallet app.</p>${phone}`,
  );
}

const LAST_WALLET = 'moola.wallet';

let stopAccountWatch = () => {};

async function doConnect(w: Wallet, silent = false): Promise<Connected> {
  const c = await connect(w, silent);
  state.wallet = c;
  stopAccountWatch();
  stopAccountWatch = onAccountsChanged(c, (accounts) => {
    if (!state.wallet || state.wallet.wallet !== w) return;
    const solana = accounts.filter((a) => a.chains.some((ch) => ch.startsWith('solana:')));
    if (!solana.length) {
      state.wallet = null;
      toast('wallet disconnected');
    } else if (!solana.some((a) => a.address === state.wallet!.address)) {
      state.wallet = { wallet: w, account: solana[0], address: solana[0].address };
      toast(`switched to ${shortAddr(solana[0].address)}`);
    }
    renderWallet();
  });
  try {
    localStorage.setItem(LAST_WALLET, w.name);
  } catch {
    /* ignore */
  }
  renderWallet();
  return c;
}

async function refreshBalance() {
  if (!state.wallet) return;
  try {
    const sol = await getBalanceSol(state.wallet.address);
    els.balance.textContent = `${sol.toFixed(3)} SOL`;
    els.balance.hidden = false;
  } catch {
    els.balance.hidden = true;
  }
}

function renderWallet() {
  const w = state.wallet;
  els.walletBtn.textContent = w ? shortAddr(w.address) : 'Connect wallet';
  if (w) els.walletBtn.setAttribute('aria-label', `Wallet ${shortAddr(w.address)}: copy address or disconnect`);
  else els.walletBtn.removeAttribute('aria-label');
  if (!w) els.balance.hidden = true;
  else refreshBalance();
  updateSummary();
}

async function forgetWallet() {
  await disconnect(state.wallet);
  stopAccountWatch();
  state.wallet = null;
  try {
    localStorage.removeItem(LAST_WALLET);
  } catch {
    /* ignore */
  }
  renderWallet();
}

els.walletBtn.addEventListener('click', async () => {
  const w = state.wallet;
  if (w) {
    openModal(
      'YOUR WALLET',
      `<p class="mono" style="word-break:break-all">${esc(w.address)}</p>
       <div class="wallets"><button class="wallet-btn" type="button" id="w-copy">Copy address</button><button class="wallet-btn" type="button" id="w-off">Disconnect</button></div>`,
    );
    $('w-copy').addEventListener('click', () => {
      navigator.clipboard?.writeText(w.address).then(() => toast('address copied'), () => toast('copy failed, select it manually'));
      hideModal();
    });
    $('w-off').addEventListener('click', async () => {
      hideModal();
      await forgetWallet();
      toast('disconnected. paper hands.');
    });
    return;
  }
  try {
    await ensureWallet();
    toast('wallet connected. lfg.');
  } catch (e) {
    if ((e as Error).message !== 'cancelled') toast(friendlyError(e));
  }
});
onWalletsChanged(() => {
  if (!$('modal').hidden && pendingConnect) showWalletPicker();
});

// ── launch ──
const DEFAULT_STEP_LABELS: Record<StepId, string> = {
  upload: 'Pinning meme + metadata to Arweave',
  build: 'Cooking the transaction',
  sign: 'Sign in your wallet',
  confirm: 'Waiting for the chain',
};
function stepLabels(): Record<StepId, string> {
  return { ...DEFAULT_STEP_LABELS, ...padById(state.pad).stepLabels };
}
function renderStepLabels() {
  const labels = stepLabels();
  els.steps.querySelectorAll<HTMLElement>('li').forEach((li) => (li.textContent = labels[li.dataset.step as StepId]));
}

function setStep(step: StepId | null, mode: 'active' | 'error' = 'active') {
  const order: StepId[] = ['upload', 'build', 'sign', 'confirm'];
  const idx = step ? order.indexOf(step) : -1;
  els.steps.querySelectorAll<HTMLElement>('li').forEach((li, i) => {
    li.dataset.state = i < idx ? 'done' : i === idx ? mode : '';
    if (i === idx) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  if (step && mode === 'active') announce(stepLabels()[step]);
}

function showMsg(html: string, ok = false) {
  els.msg.innerHTML = html ? `<div class="alert${ok ? ' alert--ok' : ''}">${html}</div>` : '';
  if (html) els.msg.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function lockForm(locked: boolean) {
  state.busy = locked;
  $<HTMLFieldSetElement>('launch-fields').disabled = locked;
  updateSendBar();
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  clearErrors();
  showMsg('');
  normalizeTicker();
  const draft = { name: els.name.value.trim(), ticker: sanitizeTicker(els.ticker.value), description: els.description.value.trim() };
  const v = validateDraft(draft);
  if (!v.ok) {
    for (const [k, msg] of Object.entries(v.errors)) {
      $(`${k}-err`).textContent = msg ?? '';
      $(k)?.setAttribute('aria-invalid', 'true');
    }
    const first = Object.keys(v.errors)[0];
    if (first === 'description') ($('launch').querySelector('details') as HTMLDetailsElement).open = true;
    $(first)?.focus();
    return;
  }
  // Snapshot everything now: the user can't change pad, dev buy or art halfway through a launch.
  const pad = padById(state.pad);
  const devBuySol = pad.devBuy ? state.devBuy : 0;
  const socials = {
    twitter: safeUrl(els.twitter.value),
    telegram: safeUrl(els.telegram.value),
    website: safeUrl(els.website.value),
  };
  lockForm(true);
  let current: StepId | null = null;
  const onStep = (s: StepId) => {
    current = s;
    setStep(s);
  };
  try {
    const image = await currentImage();
    const wallet = await ensureWallet();
    if (pad.requires?.includes('signTransaction') && !canSignOnly(wallet)) {
      throw friendly(`this wallet can't do ${pad.name} launches (it can't sign without sending). use Phantom, Solflare or Backpack, or pick another launchpad.`);
    }
    if (pad.requires?.includes('signMessage') && !canSignMessage(wallet)) {
      throw friendly(`${pad.name} wants a signed login message and this wallet can't sign messages (Ledger?). pick another launchpad.`);
    }
    els.steps.hidden = false;
    els.steps.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    // Cheap pre-flight so people with an empty wallet don't upload + sign for nothing.
    const bal = await getBalanceSol(wallet.address).catch(() => null);
    const need = devBuySol + pad.overheadSol;
    if (bal !== null && bal < need) throw friendly(`need ~${need.toFixed(3)} SOL, wallet has ${bal.toFixed(3)} SOL. top up ser.`);

    const prepared = await pad.prepare({ ...draft, ...socials, image, devBuySol, creator: wallet.address }, onStep, {
      signMessage: canSignMessage(wallet) ? (m) => signMessage(wallet, m) : undefined,
    });
    if (prepared.notice) showMsg(esc(prepared.notice), true);
    onStep('sign');
    if (state.wallet?.address !== wallet.address) throw friendly('you switched wallet accounts mid-launch. nothing was sent. hit SEND IT again.');
    const blockhash = prepared.tx.message.recentBlockhash;
    let sig: string;
    let rebroadcast: (() => Promise<unknown>) | undefined;
    if (canSignOnly(wallet)) {
      // Same pattern pump.fun's own site uses: the wallet signs a tx the mint already signed, then we
      // (or the launchpad's API) broadcast it.
      let signed = await signOnly(wallet, prepared.tx);
      if (messageChanged(prepared.tx, signed)) {
        // Some wallets append their own instructions (e.g. guard assertions). That voids signatures made
        // before signing; we can redo ours when we hold the key, otherwise nothing is sent.
        if (!prepared.resign) throw friendly(`${wallet.wallet.name} changed the transaction while signing, which breaks ${pad.name}'s signature. nothing was sent. try again or use another wallet.`);
        signed = prepared.resign(signed);
      }
      if (!(await isBlockhashValid(blockhash).catch(() => true))) {
        throw friendly('the transaction expired while it waited in your wallet. nothing was sent. hit SEND IT again (and sign a bit faster).');
      }
      sig = txSignature(signed);
      onStep('confirm');
      if (prepared.submit) {
        await prepared.submit(signed);
      } else {
        try {
          await sendRaw(signed, { preflight: true });
        } catch (e) {
          // A definitive node answer (bad signature, expired, would fail) stops here; network blips
          // (incl. iOS "Load failed") just fall through to the rebroadcast loop.
          if (e instanceof RpcError && !/already been processed|AlreadyProcessed/i.test(e.message)) throw e;
        }
      }
      rebroadcast = () => sendRaw(signed);
    } else {
      sig = await signAndSend(wallet, prepared.tx, (b) => sendRaw(b, { preflight: true }));
      onStep('confirm');
    }
    const st = await waitForLanding(sig, blockhash, { rebroadcast });
    if (st.status === 'failed') throw new Error(`transaction failed on-chain, nothing was created: ${JSON.stringify(st.err)}`);
    if (st.status === 'expired') throw friendly("the transaction didn't land before it expired (network busy). nothing was created and no SOL left your wallet except maybe a tiny fee. hit SEND IT again.");
    setStep(null);
    els.steps.querySelectorAll('li').forEach((li) => ((li as HTMLElement).dataset.state = st.status === 'confirmed' ? 'done' : ''));
    showResult({ mint: prepared.mint, sig, coinUrl: prepared.coinUrl, ticker: draft.ticker, pad: pad.name, confirmed: st.status === 'confirmed', via: prepared.via });
    refreshBalance();
  } catch (err) {
    if ((err as Error).message === 'cancelled') {
      els.steps.hidden = true;
    } else {
      if (current) setStep(current, 'error');
      showMsg(esc(friendlyError(err)));
      announce(friendlyError(err));
    }
  } finally {
    lockForm(false);
  }
});

function friendly(message: string): Error {
  return Object.assign(new Error(message), { friendly: true });
}

/** Socials end up in public metadata and in links; only plain https URLs are kept. */
export function safeUrl(v: string): string | undefined {
  const t = v.trim();
  if (!t) return undefined;
  try {
    const u = new URL(/^[a-z]+:/i.test(t) ? t : `https://${t}`);
    return u.protocol === 'https:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

function messageChanged(original: VersionedTransaction, signed: Uint8Array): boolean {
  const a = original.message.serialize();
  const b = VersionedTransaction.deserialize(signed).message.serialize();
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
}

function showResult(r: { mint: string; sig: string; coinUrl: string; ticker: string; pad: string; confirmed: boolean; via?: string }) {
  try {
    localStorage.setItem('moola.last', JSON.stringify({ ...r, at: Date.now() }));
  } catch {
    /* ignore */
  }
  const share = encodeURIComponent(`just launched $${r.ticker} on ${r.pad} with MOOLA 🚀\n${r.coinUrl}`);
  els.form.hidden = true;
  els.result.hidden = false;
  els.result.dataset.via = r.via ?? '';
  els.result.innerHTML = `
    <h3 tabindex="-1">$${esc(r.ticker)} ${r.confirmed ? 'IS LIVE' : 'IS SENT'}</h3>
    <p>${r.confirmed ? 'confirmed on Solana. you are now a dev. act like it.' : "sent, but the RPC hasn't confirmed it yet. check the tx link before launching again, it may still land."}</p>
    <div class="ca"><span>${esc(r.mint)}</span><button class="btn btn--small btn--yellow" type="button" data-copy="${esc(r.mint)}">Copy CA</button></div>
    <div class="result__links">
      <a class="btn" href="${esc(r.coinUrl)}" target="_blank" rel="noopener">Open on ${esc(r.pad)}</a>
      <a class="btn btn--pink" href="https://x.com/intent/post?text=${share}" target="_blank" rel="noopener">Shill on X</a>
      <a class="btn btn--ghost" href="https://solscan.io/tx/${esc(r.sig)}" target="_blank" rel="noopener">View tx</a>
      <a class="btn btn--ghost" href="https://dexscreener.com/solana/${esc(r.mint)}" target="_blank" rel="noopener">Dexscreener</a>
    </div>
    <p style="margin-top:16px"><button class="btn btn--yellow" type="button" id="again">Launch another</button></p>`;
  if (r.confirmed) confetti();
  updateSendBar();
  els.result.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  els.result.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  announce(`${r.ticker} ${r.confirmed ? 'is live' : 'was sent'} on ${r.pad}`);
  els.result.querySelector<HTMLElement>('[data-copy]')?.addEventListener('click', (e) => {
    navigator.clipboard?.writeText((e.currentTarget as HTMLElement).dataset.copy!).then(() => toast('CA copied'), () => toast('copy failed, select it manually'));
  });
  $('again').addEventListener('click', () => {
    els.result.hidden = true;
    els.form.hidden = false;
    els.steps.hidden = true;
    showMsg('');
    state.reroll++;
    if (state.item) fillFromItem(state.item, state.reroll, false);
    updateSendBar();
    els.name.focus();
  });
}

// ── sticky SEND IT bar: the launch button is always one tap away ──
let sendVisible = true;
function updateSendBar() {
  els.sendBar.hidden = sendVisible || state.busy || els.form.hidden || !$('modal').hidden;
}
new IntersectionObserver((entries) => {
  sendVisible = entries.some((en) => en.isIntersecting);
  updateSendBar();
}).observe(els.send);
els.sendBarBtn.addEventListener('click', () => {
  $('launch').scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  els.form.requestSubmit();
});

// ── catalog (the ECC dashboard, degen edition) ──
function items(tab: TabId): CatalogItem[] {
  const c = state.catalog;
  if (!c) return [];
  if (tab === 'rule') return c.rules.map((r) => ({ kind: 'rule', id: `${r.l}-rules`, title: `${r.l}-rules`, description: `${r.f.length} rule files: ${r.f.join(', ')}.` }));
  const raw = tab === 'agent' ? c.agents : tab === 'skill' ? c.skills : c.commands;
  return raw.map((r) => ({ kind: r.k, id: r.id, title: r.n, description: r.d }));
}

function rawFor(kind: string, id: string): RawItem | undefined {
  const c = state.catalog;
  if (!c) return undefined;
  const list = kind === 'agent' ? c.agents : kind === 'command' ? c.commands : c.skills;
  return list.find((r) => r.id === id);
}

function renderTabs() {
  const c = state.catalog;
  const tabs: [TabId, string, number][] = [
    ['agent', 'Agents', c?.agents.length ?? 0],
    ['skill', 'Skills', c?.skills.length ?? 0],
    ['command', 'Commands', c?.commands.length ?? 0],
    ['rule', 'Rules', c?.rules.length ?? 0],
  ];
  $('tabs').innerHTML = tabs
    .map(([id, label, n]) => `<button class="tab" type="button" aria-pressed="${state.tab === id}" data-tab="${id}">${label}<span class="n">${n}</span></button>`)
    .join('');
}
$('tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab as TabId;
  state.shown = PAGE;
  renderTabs();
  renderGrid();
  ($('tabs').querySelector(`[data-tab="${state.tab}"]`) as HTMLElement | null)?.focus();
});

let searchTimer = 0;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.query = (e.target as HTMLInputElement).value.trim().toLowerCase();
    state.shown = PAGE;
    renderGrid();
  }, 120);
});

function renderGrid() {
  const q = state.query;
  const all = items(state.tab).filter((i) => !q || i.id.toLowerCase().includes(q) || i.description.toLowerCase().includes(q));
  const list = all.slice(0, state.shown);
  $('grid').innerHTML = list.length
    ? list
        .map((i) => {
          const c = coinify(i);
          return `<article class="card">
          <div class="card__top">
            <div class="card__emoji" aria-hidden="true">${c.emoji}</div>
            <div><div class="kind">${i.kind === 'rule' ? 'rule set' : i.kind}</div><h3 class="card__title">${esc(i.title)}</h3><div class="card__ticker">$${esc(c.ticker)}</div></div>
          </div>
          <p class="card__desc">${esc(i.description || 'no lore yet. you write it.')}</p>
          <div class="card__actions">
            <button class="btn btn--small" type="button" data-meme="${esc(i.kind)}|${esc(i.id)}" aria-label="Meme ${esc(i.title)}">Meme it</button>
            ${state.tab === 'rule' ? '' : `<button class="btn btn--small btn--ghost" type="button" data-lore="${esc(i.kind)}|${esc(i.id)}" aria-label="Lore for ${esc(i.title)}">Lore</button>`}
          </div>
        </article>`;
        })
        .join('')
    : `<div class="empty">nothing matches "${esc(q)}". ngmi. try another word.</div>`;
  $('more').hidden = all.length <= state.shown;
  $('more').textContent = `Show more (${all.length - state.shown} left)`;
  $('grid-count').textContent = `${all.length} result${all.length === 1 ? '' : 's'}`;
}
$('more').addEventListener('click', () => {
  state.shown += PAGE;
  renderGrid();
});
$('grid').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const meme = t.closest<HTMLElement>('[data-meme]');
  const lore = t.closest<HTMLElement>('[data-lore]');
  if (meme) {
    const [kind, id] = meme.dataset.meme!.split('|');
    const item = items(state.tab).find((i) => i.kind === kind && i.id === id);
    if (item) fillFromItem(item);
  } else if (lore) {
    const [kind, id] = lore.dataset.lore!.split('|');
    const r = rawFor(kind, id);
    if (!r) return;
    const meta = [r.m && `model: ${r.m}`, r.t?.length && `tools: ${r.t.join(', ')}`, r.c && `category: ${r.c}`].filter(Boolean).join(' · ');
    openModal(
      r.n.toUpperCase(),
      `<p>${esc(r.d)}</p>${meta ? `<p class="mono">${esc(meta)}</p>` : ''}${
        r.lic && r.src
          ? `<p>This one is ${esc(r.lic)} licensed (not MIT), so the full text lives upstream: <a href="${esc(r.src)}" target="_blank" rel="noopener">read it on GitHub</a>.</p>`
          : `<div class="modal__body">${esc(r.b || '')}</div>`
      }
       <p style="margin-top:12px"><button class="btn" type="button" id="lore-meme">Meme this one</button></p>`,
    );
    $('lore-meme').addEventListener('click', () => {
      hideModal();
      const item = items(r.k === 'agent' ? 'agent' : r.k === 'command' ? 'command' : 'skill').find((i) => i.id === r.id);
      if (item) fillFromItem(item);
    });
  }
});

function renderPadNames() {
  const names = LAUNCHPADS.map((p) => p.name);
  $('pad-names').textContent = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0];
}

function renderStatsAndMarquee() {
  const c = state.catalog!;
  $('stats').innerHTML = [`${c.agents.length} agents`, `${c.skills.length} skills`, `${c.commands.length} commands`, `${LAUNCHPADS.length} launchpads`, '1 click']
    .map((s) => `<span class="sticker">${s}</span>`)
    .join('');
  const tickers = [...c.agents, ...c.commands].slice(0, 40).map((r) => `$${coinify({ kind: r.k, id: r.id, title: r.n, description: r.d }).ticker}`);
  const slogans = ['1 CLICK = 1 COIN', 'NO BRAKES', 'AGENTS ARE THE NEW DEVS', 'NOT FINANCIAL ADVICE', 'WAGMI'];
  const bits: string[] = [];
  tickers.forEach((t, i) => {
    bits.push(t);
    if (i % 6 === 5) bits.push(slogans[(i / 6) % slogans.length | 0]);
  });
  $('marquee').innerHTML = bits.map((b) => `<span>${esc(b)}</span>`).join('');
}

function routeFromHash() {
  const m = location.hash.match(/^#\/(agent|skill|command|rule)\/(.+)$/);
  if (!m || !state.catalog) return false;
  const id = decodeURIComponent(m[2]);
  const tab = m[1] as TabId;
  const item = items(tab).find((i) => i.id === id);
  if (!item) return false;
  state.tab = tab;
  renderTabs();
  renderGrid();
  fillFromItem(item, 0, false);
  return true;
}
window.addEventListener('hashchange', routeFromHash);

$('rpc-btn').addEventListener('click', () => {
  const custom = rpcUrls().length > DEFAULT_RPCS.length ? rpcUrls()[0] : '';
  openModal(
    'RPC SETTINGS',
    `<p>Public RPCs get rate limited when everyone is aping. Paste your own (Helius, QuickNode, Triton...) to make building, checks and confirmations snappy.</p>
     <p class="art__hint">Saved in this browser only. If the URL contains an API key, use a key restricted to this site's origin.</p>
     <label class="field"><span class="field__label">Custom RPC URL</span><input class="input" id="rpc-input" type="url" placeholder="https://..." value="${esc(custom)}" /></label>
     <button class="btn" type="button" id="rpc-save">Save</button>`,
  );
  $('rpc-save').addEventListener('click', () => {
    const v = ($('rpc-input') as HTMLInputElement).value.trim();
    if (v && !/^https:\/\//.test(v)) return toast('needs https://');
    setCustomRpc(v);
    hideModal();
    toast(v ? 'RPC saved' : 'back to public RPCs');
  });
});

// ── boot ──
/** GitHub Pages can't send frame-ancestors, so refuse to run framed (clickjacking a wallet prompt). */
function framed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

async function boot() {
  if (framed()) {
    document.body.innerHTML = `<main class="hero"><h1>NOPE</h1><p>MOOLA doesn't run inside other sites. <a href="${esc(location.href)}" target="_blank" rel="noopener">Open MOOLA directly</a>.</p></main>`;
    return;
  }
  renderPadNames();
  renderPads();
  renderBuys();
  renderTabs();
  $('art-hint').textContent = ART_HINT;
  const starter: CatalogItem = { kind: 'agent', id: 'moola', title: 'Moola', description: 'The agent that turns agents into coins.' };
  fillFromItem(starter, 0, false);
  state.item = null;
  try {
    const res = await fetch('./catalog.json');
    state.catalog = (await res.json()) as Catalog;
  } catch {
    $('grid').innerHTML = '<div class="empty">catalog failed to load. refresh ser.</div>';
    return;
  }
  renderStatsAndMarquee();
  renderTabs();
  // A coin handed over from another browser (wallet in-app browser) wins over the #/agent/... route.
  const restored = restoreDraft();
  if (restored || !routeFromHash()) {
    renderGrid();
    const first = items('agent').find((i) => i.id === 'code-reviewer') ?? items('agent')[0];
    if (first && !state.dirty && !restored) fillFromItem(first, 0, false);
  }
  // Warm the pump.fun SDK chunk so the first launch doesn't wait on it.
  setTimeout(() => import('./launchpads/pumpSdk').catch(() => undefined), 1500);
  // Silent reconnect, only to the wallet this browser used last (never pops a prompt on load).
  let last = '';
  try {
    last = localStorage.getItem(LAST_WALLET) ?? '';
  } catch {
    /* ignore */
  }
  const w = last && listWallets().find((x) => x.name === last);
  if (w) {
    try {
      await doConnect(w, true);
    } catch {
      /* not trusted any more */
    }
  }
}
boot();
