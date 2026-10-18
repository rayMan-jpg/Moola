import { Buffer } from 'buffer';
(globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
import './styles.css';
import { myJobs } from './api';
import { initEngineRoom } from './engineRoom';
import { initOrder, orderBusy } from './order';
import { PADS } from './pads';
import { projectBusy, setProjectNotice, showProject, stopProject } from './project';
import { DEFAULT_RPCS, rpcUrls, setCustomRpc } from './rpc';
import { $, esc, framed, hideModal, openModal, reducedMotion, toast } from './ui';
import { balanceText, onWalletChange, silentReconnect, walletLabel, walletMenu } from './wallets';

// ── routing: #/ (order form) and #/p/<job id> (project page) ──
function route() {
  const m = location.hash.match(/^#\/p\/(q_[a-z2-7]{16})$/);
  const project = !!m;
  $('order-view').hidden = project;
  $('project-view').hidden = !project;
  $('send-bar').hidden = true;
  if (m) {
    showProject(m[1]);
    window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
  } else {
    stopProject();
    if (location.hash.startsWith('#') && location.hash !== '#/' && !/^#[a-z-]+$/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  }
}
window.addEventListener('hashchange', route);

// ── header ──
async function renderWallet() {
  $('wallet-btn').textContent = walletLabel();
  const b = await balanceText();
  $('balance').textContent = b;
  $('balance').hidden = !b;
}
onWalletChange(renderWallet);
$('wallet-btn').addEventListener('click', walletMenu);

$('mine-btn').addEventListener('click', () => {
  const jobs = myJobs();
  openModal(
    'MY REAS',
    jobs.length
      ? `<div class="wallets">${jobs
          .map((j) => `<a class="wallet-btn" href="#/p/${esc(j.id)}" data-go>${esc(j.project)} <span class="pad__meta">rea of ${esc(j.target)} · ${new Date(j.at).toLocaleDateString()}</span></a>`)
          .join('')}</div>`
      : '<p>Nothing yet. Your reas show up here (saved in this browser), and every rea has a shareable project page.</p>',
  );
  $('modal-content')
    .querySelectorAll('[data-go]')
    .forEach((a) => a.addEventListener('click', () => hideModal()));
});

$('rpc-btn').addEventListener('click', () => {
  const custom = rpcUrls().length > DEFAULT_RPCS.length ? rpcUrls()[0] : '';
  openModal(
    'RPC SETTINGS',
    `<p>Public Solana RPCs get rate limited when everyone is aping. Paste your own (Helius, QuickNode, Triton...) to make builds, checks and confirmations snappy.</p>
     <p class="art__hint">Saved in this browser only. If the URL contains an API key, use a key restricted to this site's origin.</p>
     <label class="field"><span class="field__label">Custom Solana RPC URL</span><input class="input" id="rpc-input" type="url" placeholder="https://..." value="${esc(custom)}" /></label>
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

function renderStatsAndMarquee(agents: number, skills: number) {
  $('stats').innerHTML = [`ECC engine`, `${agents} agent playbooks`, `${skills} skills`, `${PADS.filter((p) => !p.soon).length} launchpads`, '2 chains']
    .map((s) => `<span class="sticker">${s}</span>`)
    .join('');
  const bits = ['REVERSE ENGINEER ANYTHING', 'CLONE + SPEC + HOSTING', 'PASTE A LINK', 'GET A REPO', 'LAUNCH A TOKEN', 'POWERED BY ECC', 'PUBLIC INFO ONLY', 'NO IMPERSONATION', 'NOT FINANCIAL ADVICE'];
  $('marquee').innerHTML = [...bits, ...bits].map((b) => `<span>${esc(b)}</span>`).join('');
}

async function boot() {
  if (framed()) {
    document.body.innerHTML = `<main class="hero"><h1>NOPE</h1><p>rea4u doesn't run inside other sites. <a href="${esc(location.href)}" target="_blank" rel="noopener">Open rea4u directly</a>.</p></main>`;
    return;
  }
  // A wallet flow in progress (order or project-page top-up/launch): ask before leaving.
  window.addEventListener('beforeunload', (e) => {
    if (orderBusy() || projectBusy()) e.preventDefault();
  });
  renderStatsAndMarquee(71, 311);
  route();
  await initOrder((jobId, message) => {
    if (message) setProjectNotice(jobId, message);
    location.hash = `#/p/${jobId}`;
  });
  const cat = await initEngineRoom();
  if (cat) renderStatsAndMarquee(cat.agents.length, cat.skills.length);
  // Warm the pump.fun SDK chunk so the first order doesn't wait on it.
  setTimeout(() => import('./launchpads/pumpSdk').catch(() => undefined), 1500);
  await silentReconnect();
}
boot();
