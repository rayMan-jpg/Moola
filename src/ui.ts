// Small DOM helpers shared by the order form, the project page and the engine room.

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function announce(msg: string) {
  const s = $('sr-status');
  s.textContent = '';
  requestAnimationFrame(() => (s.textContent = msg));
}

let toastTimer = 0;
export function toast(msg: string) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  announce(msg);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 2800);
}

export function friendly(message: string): Error {
  return Object.assign(new Error(message), { friendly: true });
}

const BACKGROUND = ['.marquee', '.header', '#order-view', '#project-view', '.footer', '#send-bar'];
function setInert(on: boolean) {
  for (const sel of BACKGROUND) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) el.inert = on;
  }
}

let lastFocus: HTMLElement | null = null;
let onClose: (() => void) | null = null;

/** Opens the dialog. `close` runs when the user dismisses it (not when code calls hideModal). */
export function openModal(title: string, html: string, close?: () => void) {
  if ($('modal').hidden) {
    const a = document.activeElement as HTMLElement | null;
    lastFocus = a && a !== document.body ? a : null;
  }
  onClose = close ?? null;
  $('modal-title').textContent = title;
  $('modal-content').innerHTML = html;
  $('modal').hidden = false;
  setInert(true);
  ($('modal').querySelector('#modal-content button, #modal-content a, #modal-content input, [data-close]') as HTMLElement | null)?.focus();
}

export function hideModal() {
  $('modal').hidden = true;
  onClose = null;
  setInert(false);
  const back = lastFocus;
  setTimeout(() => {
    if (back && back.isConnected && !back.matches(':disabled')) back.focus({ preventScroll: true });
  }, 0);
}

function dismiss() {
  const cb = onClose;
  hideModal();
  cb?.();
}

export function modalOpen() {
  return !$('modal').hidden;
}

$('modal').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.id === 'modal' || t.closest('[data-close]')) dismiss();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalOpen()) dismiss();
});

export function confetti(bits = ['⚙', '🚀', '💾', '🟢', '💎', '🔥', '🌙']) {
  if (reducedMotion()) return;
  const box = document.createElement('div');
  box.className = 'confetti';
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

export function copy(text: string, what = 'copied') {
  navigator.clipboard?.writeText(text).then(
    () => toast(what),
    () => toast('copy failed, select it manually'),
  );
}

/** GitHub Pages can't send frame-ancestors, so refuse to run framed (clickjacking a wallet prompt). */
export function framed(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}
