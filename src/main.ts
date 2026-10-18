import { Buffer } from 'buffer';
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
import './styles.css';
import type { Wallet } from '@wallet-standard/base';
import { VersionedTransaction } from '@solana/web3.js';
import { coinify, validateDraft, sanitizeTicker, emojiFor, NAME_MAX, DESC_MAX, type CatalogItem } from './coinify';
import { drawCoinArt, canvasToBlob } from './coinArt';
import { listWallets, onWalletsChanged, connect, disconnect, signAndSend, signOnly, canSignOnly, canSignMessage, signMessage, txSignature, isMobile, walletDeeplinks, shortAddr, type Connected } from './wallet';
import { getBalanceSol, sendRaw, waitForSignature, setCustomRpc, rpcUrls } from './rpc';
import { LAUNCHPADS, padById } from './launchpads';
import type { StepId } from './launchpads/types';
import { friendlyError } from './errors';

// ── catalog types (shape produced by scripts/build-catalog.mjs) ──
interface RawItem { k: 'agent' | 'skill' | 'command'; id: string; n: string; d: string; b: string; m?: string; t?: string[]; g?: string; c?: string; lic?: string; src?: string }
interface Catalog { version: string; agents: RawItem[]; skills: RawItem[]; commands: RawItem[]; rules: { l: string; f: string[] }[]; mcps: { f: string; s: { n: string }[] }[]; hooks: { ev: string; m: string; id: string; d: string }[] }
type TabId = 'agent' | 'skill' | 'command' | 'rule';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const PAGE = 48;
const IMAGE_MAX = 4 * 1024 * 1024;

const state = {
  catalog: null as Catalog | null,
  tab: 'agent' as TabId,
  query: '',
  shown: PAGE,
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
  send: $<HTMLButtonElement>('send-it'),
  steps: $<HTMLOListElement>('steps'),
  msg: $('launch-msg'),
  form: $<HTMLFormElement>('launch-form'),
  result: $('result'),
  walletBtn: $<HTMLButtonElement>('wallet-btn'),
  balance: $('balance'),
};

// ── toast / modal / confetti ──
let toastTimer = 0;
function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2600);
}

let lastFocus: HTMLElement | null = null;
function openModal(title: string, html: string) {
  lastFocus = document.activeElement as HTMLElement;
  $('modal-title').textContent = title;
  $('modal-content').innerHTML = html;
  $('modal').hidden = false;
  ($('modal').querySelector('button, a') as HTMLElement | null)?.focus();
}
function closeModal() {
  $('modal').hidden = true;
  lastFocus?.focus();
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
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
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

$('image-input').addEventListener('change', (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  if (!/^image\/(png|jpe?g|gif|webp)$/.test(f.type)) return toast('png, jpg, gif or webp only ser');
  if (f.size > IMAGE_MAX) return toast('max 4 MB, this is not a museum');
  state.upload = f;
  els.uploadImg.src = URL.createObjectURL(f);
  els.uploadImg.hidden = false;
  els.canvas.hidden = true;
  $('art-hint').textContent = `${f.name} locked in. reroll to go back to the auto meme.`;
});

$('reroll').addEventListener('click', () => {
  state.upload = null;
  els.uploadImg.hidden = true;
  els.canvas.hidden = false;
  $('art-hint').textContent = 'auto-generated logo. or upload a png/jpg/gif under 4 MB.';
  state.reroll++;
  if (state.item) fillFromItem(state.item, state.reroll, false);
  else renderArt();
});

// ── form ──
function fillFromItem(item: CatalogItem, reroll = 0, scroll = true) {
  state.item = item;
  state.reroll = reroll;
  const c = coinify(item, reroll);
  els.name.value = c.name;
  els.ticker.value = c.ticker;
  els.description.value = c.description;
  state.emoji = c.emoji;
  updateCounts();
  clearErrors();
  scheduleArt();
  updateSummary();
  if (scroll) {
    $('launch').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    els.send.focus({ preventScroll: true });
    history.replaceState(null, '', `#/${item.kind}/${encodeURIComponent(item.id)}`);
  }
}

function updateCounts() {
  $('name-count').textContent = `${new TextEncoder().encode(els.name.value).length}/${NAME_MAX}`;
  $('desc-count').textContent = `${[...els.description.value].length}/${DESC_MAX}`;
}
function clearErrors() {
  for (const k of ['name', 'ticker', 'description']) $(`${k}-err`).textContent = '';
}

els.form.addEventListener('input', (e) => {
  if ((e as InputEvent).isTrusted) state.dirty = true;
});

els.name.addEventListener('input', () => {
  updateCounts();
  if (!state.item) state.emoji = emojiFor(els.name.value);
  scheduleArt();
  updateSummary();
});
els.ticker.addEventListener('input', () => {
  const pos = els.ticker.selectionStart;
  els.ticker.value = sanitizeTicker(els.ticker.value);
  if (pos !== null) els.ticker.setSelectionRange(pos, pos);
  scheduleArt();
  updateSummary();
});
els.description.addEventListener('input', updateCounts);

function renderPads() {
  $('pads').innerHTML = LAUNCHPADS.map(
    (p) => `<button type="button" class="pad" role="radio" aria-checked="${p.id === state.pad}" data-pad="${p.id}">
      ${p.badge ? `<span class="pad__badge">${esc(p.badge)}</span>` : ''}
      <span class="pad__name">${esc(p.name)}</span>
      <span class="pad__meta">${esc(p.tagline)}</span>
      <span class="pad__meta mono">${p.signatures} signature${p.signatures > 1 ? 's' : ''}${p.devBuy ? '' : ' · no dev buy'}</span>
    </button>`,
  ).join('');
}
$('pads').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-pad]');
  if (!b) return;
  state.pad = b.dataset.pad!;
  renderPads();
  renderBuys();
  updateSummary();
});
$('pads').addEventListener('keydown', (e) => {
  if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const i = LAUNCHPADS.findIndex((p) => p.id === state.pad);
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  state.pad = LAUNCHPADS[(i + d + LAUNCHPADS.length) % LAUNCHPADS.length].id;
  renderPads();
  renderBuys();
  updateSummary();
  ($('pads').querySelector(`[data-pad="${state.pad}"]`) as HTMLElement).focus();
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
  els.send.textContent = state.wallet ? `SEND IT ($${t})` : 'CONNECT + SEND IT';
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
        $('modal').hidden = true;
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
  const links = walletDeeplinks(location.href);
  openModal(
    'NO WALLET DETECTED',
    `<p>${isMobile() ? 'Open MOOLA inside your wallet app, then hit SEND IT again:' : 'Install a Solana wallet extension (Phantom, Solflare or Backpack), refresh, and hit SEND IT again. On your phone? Use these:'}</p>
     <div class="wallets">${links.map((l) => `<a class="wallet-btn" href="${esc(l.url)}">Open in ${esc(l.name)}</a>`).join('')}</div>`,
  );
}

const LAST_WALLET = 'moola.wallet';

async function doConnect(w: Wallet, silent = false): Promise<Connected> {
  const c = await connect(w, silent);
  state.wallet = c;
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
  els.walletBtn.textContent = state.wallet ? shortAddr(state.wallet.address) : 'Connect wallet';
  els.walletBtn.title = state.wallet ? 'Click to disconnect' : '';
  if (!state.wallet) els.balance.hidden = true;
  else refreshBalance();
  updateSummary();
}

els.walletBtn.addEventListener('click', async () => {
  if (state.wallet) {
    await disconnect(state.wallet);
    state.wallet = null;
    try {
      localStorage.removeItem(LAST_WALLET);
    } catch {
      /* ignore */
    }
    renderWallet();
    toast('disconnected. paper hands.');
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
function renderStepLabels() {
  const labels = { ...DEFAULT_STEP_LABELS, ...padById(state.pad).stepLabels };
  els.steps.querySelectorAll<HTMLElement>('li').forEach((li) => (li.textContent = labels[li.dataset.step as StepId]));
}

function setStep(step: StepId | null, mode: 'active' | 'error' = 'active') {
  const order: StepId[] = ['upload', 'build', 'sign', 'confirm'];
  const idx = step ? order.indexOf(step) : -1;
  els.steps.querySelectorAll<HTMLElement>('li').forEach((li, i) => {
    li.dataset.state = i < idx ? 'done' : i === idx ? mode : '';
  });
}

function showMsg(html: string, ok = false) {
  els.msg.innerHTML = html ? `<div class="alert${ok ? ' alert--ok' : ''}">${html}</div>` : '';
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.busy) return;
  clearErrors();
  showMsg('');
  const draft = { name: els.name.value.trim(), ticker: sanitizeTicker(els.ticker.value), description: els.description.value.trim() };
  const v = validateDraft(draft);
  if (!v.ok) {
    for (const [k, msg] of Object.entries(v.errors)) $(`${k}-err`).textContent = msg ?? '';
    const first = Object.keys(v.errors)[0];
    if (first === 'description') ($('launch').querySelector('details') as HTMLDetailsElement).open = true;
    $(first)?.focus();
    return;
  }
  const pad = padById(state.pad);
  state.busy = true;
  els.send.disabled = true;
  let current: StepId | null = null;
  const onStep = (s: StepId) => {
    current = s;
    setStep(s);
  };
  try {
    const wallet = await ensureWallet();
    els.steps.hidden = false;
    // Cheap pre-flight so people with an empty wallet don't upload + sign for nothing.
    try {
      const bal = await getBalanceSol(wallet.address);
      const need = effectiveDevBuy() + pad.overheadSol;
      if (bal < need) throw Object.assign(new Error(`need ~${need.toFixed(3)} SOL, wallet has ${bal.toFixed(3)} SOL. top up ser.`), { friendly: true });
    } catch (err) {
      if ((err as { friendly?: boolean }).friendly) throw err;
      /* balance lookup failed: let the wallet simulation be the judge */
    }
    const prepared = await pad.prepare(
      {
        ...draft,
        image: await currentImage(),
        twitter: els.twitter.value.trim() || undefined,
        telegram: els.telegram.value.trim() || undefined,
        website: els.website.value.trim() || undefined,
        devBuySol: effectiveDevBuy(),
        creator: wallet.address,
      },
      onStep,
      { signMessage: canSignMessage(wallet) ? (m) => signMessage(wallet, m) : undefined },
    );
    onStep('sign');
    let sig: string;
    let rebroadcast: (() => Promise<unknown>) | undefined;
    if (canSignOnly(wallet)) {
      // Same pattern pump.fun's own site uses: the wallet signs a tx the mint already signed, then we
      // (or the launchpad's API) broadcast it.
      let signed = await signOnly(wallet, prepared.tx);
      if (messageChanged(prepared.tx, signed)) {
        // Some wallets append their own instructions (e.g. guard assertions). That voids signatures made
        // before signing; we can redo ours when we hold the key, otherwise nothing is sent.
        if (!prepared.resign) {
          throw new Error(`${wallet.wallet.name} changed the transaction while signing, which breaks ${pad.name}'s signature. Nothing was sent. Try again or use another wallet.`);
        }
        signed = prepared.resign(signed);
      }
      if (prepared.submit) {
        onStep('confirm');
        sig = await prepared.submit(signed);
      } else {
        sig = txSignature(signed);
        rebroadcast = () => sendRaw(signed);
        try {
          await sendRaw(signed);
        } catch (e) {
          // Network blips get retried by the rebroadcast loop; real rejections (bad signature, expired) surface now.
          if (!/fetch|network|RPC 5\d\d|429/i.test(String((e as Error).message))) throw e;
        }
      }
    } else if (prepared.submit) {
      throw new Error(`${wallet.wallet.name} can only sign-and-send, but ${pad.name} needs to submit the signed transaction itself. Use Phantom, Solflare or Backpack.`);
    } else {
      sig = await signAndSend(wallet, prepared.tx, sendRaw);
    }
    onStep('confirm');
    const st = await waitForSignature(sig, { rebroadcast });
    if (st.status === 'failed') throw new Error(`transaction failed on-chain: ${JSON.stringify(st.err)}`);
    setStep(null);
    els.steps.querySelectorAll('li').forEach((li) => ((li as HTMLElement).dataset.state = 'done'));
    showResult({ mint: prepared.mint, sig, coinUrl: prepared.coinUrl, ticker: draft.ticker, pad: pad.name, pending: st.status === 'timeout', via: prepared.via });
    refreshBalance();
  } catch (err) {
    if ((err as Error).message === 'cancelled') {
      els.steps.hidden = true;
    } else {
      if (current) setStep(current, 'error');
      showMsg(esc(friendlyError(err)));
    }
  } finally {
    state.busy = false;
    els.send.disabled = false;
  }
});

function messageChanged(original: VersionedTransaction, signed: Uint8Array): boolean {
  const a = original.message.serialize();
  const b = VersionedTransaction.deserialize(signed).message.serialize();
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
}

function showResult(r: { mint: string; sig: string; coinUrl: string; ticker: string; pad: string; pending: boolean; via?: string }) {
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
    <h3>$${esc(r.ticker)} IS LIVE</h3>
    <p>${r.pending ? 'sent! the chain is slow, it will show up in a few seconds.' : 'confirmed on Solana. you are now a dev. act like it.'}</p>
    <div class="ca"><span>${esc(r.mint)}</span><button class="btn btn--small btn--yellow" type="button" data-copy="${esc(r.mint)}">Copy CA</button></div>
    <div class="result__links">
      <a class="btn" href="${esc(r.coinUrl)}" target="_blank" rel="noopener">Open on ${esc(r.pad)}</a>
      <a class="btn btn--pink" href="https://x.com/intent/post?text=${share}" target="_blank" rel="noopener">Shill on X</a>
      <a class="btn btn--ghost" href="https://solscan.io/tx/${esc(r.sig)}" target="_blank" rel="noopener">View tx</a>
      <a class="btn btn--ghost" href="https://dexscreener.com/solana/${esc(r.mint)}" target="_blank" rel="noopener">Dexscreener</a>
    </div>
    <p style="margin-top:16px"><button class="btn btn--yellow" type="button" id="again">Launch another</button></p>`;
  confetti();
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
  });
}

// ── catalog (the ECC dashboard, degen edition) ──
function items(tab: TabId): CatalogItem[] {
  const c = state.catalog;
  if (!c) return [];
  if (tab === 'rule') return c.rules.map((r) => ({ kind: 'skill', id: `${r.l}-rules`, title: `${r.l}-rules`, description: `${r.f.length} rule files: ${r.f.join(', ')}.` }));
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
    .map(([id, label, n]) => `<button class="tab" role="tab" type="button" aria-selected="${state.tab === id}" data-tab="${id}">${label}<span class="n">${n}</span></button>`)
    .join('');
}
$('tabs').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
  if (!b) return;
  state.tab = b.dataset.tab as TabId;
  state.shown = PAGE;
  renderTabs();
  renderGrid();
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
            <div><div class="kind">${i.kind === 'skill' && state.tab === 'rule' ? 'rule set' : i.kind}</div><div class="card__title">${esc(i.title)}</div><div class="card__ticker">$${esc(c.ticker)}</div></div>
          </div>
          <p class="card__desc">${esc(i.description || 'no lore yet. you write it.')}</p>
          <div class="card__actions">
            <button class="btn btn--small" type="button" data-meme="${esc(i.kind)}|${esc(i.id)}">Meme it</button>
            ${state.tab === 'rule' ? '' : `<button class="btn btn--small btn--ghost" type="button" data-lore="${esc(i.kind)}|${esc(i.id)}">Lore</button>`}
          </div>
        </article>`;
        })
        .join('')
    : `<div class="empty">nothing matches "${esc(q)}". ngmi. try another word.</div>`;
  $('more').hidden = all.length <= state.shown;
  $('more').textContent = `Show more (${all.length - state.shown} left)`;
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
      $('modal').hidden = true;
      const item = items(r.k === 'agent' ? 'agent' : r.k === 'command' ? 'command' : 'skill').find((i) => i.id === r.id);
      if (item) fillFromItem(item);
    });
  }
});

function renderPadNames() {
  const names = LAUNCHPADS.map((p) => p.name);
  $('pad-names').textContent = names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names.at(-1)}` : names[0];
}

function renderStatsAndMarquee() {
  const c = state.catalog!;
  $('stats').innerHTML = [
    `${c.agents.length} agents`,
    `${c.skills.length} skills`,
    `${c.commands.length} commands`,
    `${LAUNCHPADS.length} launchpads`,
    '1 signature',
  ]
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
  const m = location.hash.match(/^#\/(agent|skill|command)\/(.+)$/);
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
  openModal(
    'RPC SETTINGS',
    `<p>Public RPCs get rate limited when everyone is aping. Paste your own (Helius, QuickNode, Triton...) to make balance checks and confirmations snappy. Your wallet broadcasts the launch itself either way.</p>
     <label class="field"><span class="field__label">Custom RPC URL</span><input class="input" id="rpc-input" type="url" placeholder="https://..." value="${esc(rpcUrls().length > 2 ? rpcUrls()[0] : '')}" /></label>
     <button class="btn" type="button" id="rpc-save">Save</button>`,
  );
  $('rpc-save').addEventListener('click', () => {
    const v = ($('rpc-input') as HTMLInputElement).value.trim();
    if (v && !/^https:\/\//.test(v)) return toast('needs https://');
    setCustomRpc(v);
    $('modal').hidden = true;
    toast(v ? 'RPC saved' : 'back to public RPCs');
  });
});

// ── boot ──
async function boot() {
  renderPadNames();
  renderPads();
  renderBuys();
  renderTabs();
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
  if (!routeFromHash()) {
    renderGrid();
    const first = items('agent').find((i) => i.id === 'code-reviewer') ?? items('agent')[0];
    if (first && !state.dirty) fillFromItem(first, 0, false);
  }
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
