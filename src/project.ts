// Project page (#/p/<job id>): live engine feed, budget, the clone repo, SPEC.md, ranked hosting
// with one-click deploys, the project's token, and top-ups when the budget runs out.
import { formatUsd, TIERS, type JobView } from '../shared/contract';
import { recommendHosts } from '../shared/hosting';
import { ApiError, createJob, getJob } from './api';
import { clearPending, launchForJob, loadPending, projectUrl, topUp, type Step } from './checkout';
import { canvasToBlob, drawCoinArt } from './coinArt';
import { emojiFor } from './coinify';
import { friendlyError } from './errors';
import { RH_EXPLORER } from './evm/chain';
import { renderMarkdown } from './markdown';
import { CHAIN_LABEL, padInfo } from './pads';
import { $, confetti, copy, esc, toast } from './ui';

let timer = 0;
let currentId = '';
let last: JobView | null = null;
let busy = false;

const STATUS: Record<JobView['status'], [string, string]> = {
  starting: ['BOOTING', 'yellow'],
  running: ['REA-ING', 'green'],
  paused: ['OUT OF BUDGET', 'pink'],
  done: ['DONE', 'cyan'],
  failed: ['FAILED', 'red'],
  refused: ['REFUSED', 'red'],
};

export function stopProject() {
  clearTimeout(timer);
  currentId = '';
  last = null;
}

export async function showProject(id: string) {
  stopProject();
  currentId = id;
  const root = $('project-view');
  root.innerHTML = `<section class="panel project"><h2 class="panel__title">LOADING ${esc(id)}...</h2></section>`;
  await refresh(id, true);
}

async function refresh(id: string, first = false) {
  if (id !== currentId) return;
  let job: JobView | null = null;
  try {
    job = await getJob(id);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      const pending = loadPending(id);
      if (pending) {
        renderShell(`<p>Payment received. Finishing setup with the engine...</p>`);
        try {
          job = await createJob(pending);
          clearPending(id);
        } catch (e2) {
          renderShell(`<div class="alert">Your payment is recorded in this browser, but the engine didn't accept it yet: ${esc(friendlyError(e2))}. We'll keep retrying while this page is open.</div>`);
          schedule(id, 10_000);
          return;
        }
      } else {
        renderShell(`<p>No rea with id <span class="mono">${esc(id)}</span>. Check the link, or <a href="#/">start one</a>.</p>`);
        return;
      }
    } else {
      if (first) renderShell(`<div class="alert">${esc(friendlyError(e))}</div>`);
      schedule(id, 10_000);
      return;
    }
  }
  if (id !== currentId || !job) return;
  const prev = last;
  last = job;
  if (!busy) render(job);
  if (prev && prev.status !== 'done' && job.status === 'done') {
    confetti();
    toast('your clone is ready');
  }
  const wait = job.status === 'starting' || job.status === 'running' ? 5000 : job.status === 'paused' ? 20_000 : 0;
  if (wait) schedule(id, wait);
}

function schedule(id: string, ms: number) {
  clearTimeout(timer);
  timer = window.setTimeout(() => refresh(id), document.hidden ? Math.max(ms, 30_000) : ms);
}

function renderShell(inner: string) {
  $('project-view').innerHTML = `<section class="panel project">${inner}</section>`;
}

function explorerTx(job: JobView, tx: string) {
  return job.chain === 'solana' ? `https://solscan.io/tx/${tx}` : `${RH_EXPLORER}/tx/${tx}`;
}

function render(job: JobView) {
  const [label, color] = STATUS[job.status];
  const pct = job.budgetCents ? Math.min(100, Math.round((job.spentCents / job.budgetCents) * 100)) : 0;
  const repo = job.repo;
  const m = job.manifest;
  const pad = padInfo(job.token.pad);
  const feed = [...job.feed].reverse();
  const hosts = repo
    ? recommendHosts({ repoUrl: repo.url, fullName: repo.fullName, slug: repo.fullName.split('/')[1], branch: repo.branch, manifest: m, needs: job.needs, live: job.live })
    : [];

  $('project-view').innerHTML = `
  <section class="panel project" aria-labelledby="p-title">
    <div class="project__head">
      <div>
        <div class="kind">rea of ${esc(job.target.label)} · ${esc(TIERS[job.tier].name)}</div>
        <h2 class="panel__title" id="p-title" tabindex="-1">${esc(job.project.name)}</h2>
      </div>
      <span class="badge badge--${color}">${label}</span>
    </div>
    <div class="budget" role="img" aria-label="Spent ${formatUsd(job.spentCents)} of ${formatUsd(job.budgetCents)} budget">
      <div class="budget__bar"><i style="width:${pct}%"></i></div>
      <span class="mono">${formatUsd(job.spentCents)} / ${formatUsd(job.budgetCents)} engine budget</span>
    </div>
    ${job.status === 'paused' ? topupBox() : ''}
    ${job.status === 'refused' ? `<div class="alert">The engine refused this target: ${esc(m?.refusal ?? 'it falls under the rules (no impersonation, fraud or bypassing access).')}</div>` : ''}
    ${job.error ? `<div class="alert">${esc(job.error)}</div>` : ''}
    <div class="project__grid">
      <div>
        <h3 class="step__title">Engine feed</h3>
        <ol class="feed" aria-live="polite">${feed.map((f) => `<li><time class="mono">${esc(timeOf(f.at))}</time> ${esc(f.text)}</li>`).join('') || '<li>waiting for the engine...</li>'}</ol>
        ${repo ? `<p class="repo"><a class="btn" href="${esc(repo.url)}" target="_blank" rel="noopener">Open the repo</a> <a class="btn btn--ghost" href="${esc(repo.url)}/generate" target="_blank" rel="noopener">Use as template</a></p>` : ''}
      </div>
      <div>${tokenCard(job, pad)}</div>
    </div>
    ${m ? manifestBox(job) : ''}
    ${hosts.length ? hostingBox(job, hosts) : ''}
    ${job.spec ? `<details class="more spec" ${job.status === 'done' ? 'open' : ''}><summary>SPEC.md</summary><div class="md">${renderMarkdown(job.spec)}</div><p><button class="btn btn--small btn--ghost" type="button" id="spec-dl">Download SPEC.md</button></p></details>` : ''}
    <ol class="steps" id="p-steps" hidden></ol>
    <div id="p-msg" aria-live="assertive"></div>
    <p class="disclaimer">Share this page: <button class="btn btn--small btn--ghost" type="button" id="p-share">Copy link</button> · paid by <span class="mono">${esc(job.payer.slice(0, 6))}...${esc(job.payer.slice(-4))}</span> on ${esc(CHAIN_LABEL[job.chain])}</p>
  </section>`;

  $('p-share').addEventListener('click', () => copy(projectUrl(job.id), 'link copied'));
  document.getElementById('spec-dl')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([job.spec ?? ''], { type: 'text/markdown' }));
    a.download = 'SPEC.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.getElementById('p-launch')?.addEventListener('click', () => relaunch(job));
  document.getElementById('p-copy-ca')?.addEventListener('click', () => copy(job.token.mint ?? '', 'address copied'));
  $('project-view')
    .querySelectorAll<HTMLElement>('[data-topup]')
    .forEach((b) => b.addEventListener('click', () => doTopup(job, Number(b.dataset.topup))));
}

function timeOf(at: string) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function tokenCard(job: JobView, pad: ReturnType<typeof padInfo>) {
  const t = job.token;
  if (t.status === 'live' && t.mint) {
    return `<div class="token">
      <h3 class="step__title">$${esc(t.ticker)} is live</h3>
      <p class="pad__meta">${esc(t.name)} on ${esc(pad.name)} (${esc(CHAIN_LABEL[pad.chain])})</p>
      <div class="ca mono"><span>${esc(t.mint)}</span><button class="btn btn--small btn--yellow" type="button" id="p-copy-ca">Copy</button></div>
      <p class="result__links">${t.url ? `<a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Open on ${esc(pad.name)}</a>` : ''}${
        t.tx ? `<a class="btn btn--ghost" href="${esc(explorerTx(job, t.tx))}" target="_blank" rel="noopener">View tx</a>` : ''
      }</p></div>`;
  }
  return `<div class="token">
    <h3 class="step__title">$${esc(t.ticker)} ${t.status === 'failed' ? "didn't launch" : 'not launched yet'}</h3>
    <p class="pad__meta">${esc(t.name)} on ${esc(pad.name)}. No extra charge: the job is already paid. Use the wallet that paid.</p>
    ${t.status === 'pending' ? '<p class="art__hint">If you just launched, give it a minute and check your wallet before launching again.</p>' : ''}
    <button class="btn btn--pink" type="button" id="p-launch">Launch $${esc(t.ticker)} now</button>
  </div>`;
}

function manifestBox(job: JobView) {
  const m = job.manifest!;
  const done = m.features.filter((f) => f.status === 'done').length;
  return `<div class="manifest">
    <h3 class="step__title">What you got</h3>
    <p>${esc(m.summary)}</p>
    <p class="chips">${m.stack.map((s) => `<span class="sticker">${esc(s)}</span>`).join('')}</p>
    <p class="pad__meta">${esc(m.target.approach === 'fork' ? `fork (original licence ${m.target.license})` : 'clean-room rebuild')} · ${esc(m.kind)} app · ${done}/${m.features.length} features done · build ${m.verified.build ? 'verified' : 'not verified'}${m.verified.tests ? ` · tests: ${esc(m.verified.tests)}` : ''}</p>
    <ul class="features">${m.features.map((f) => `<li data-s="${f.status}">${esc(f.name)}</li>`).join('')}</ul>
    ${m.needs.env.length ? `<p class="pad__meta">Env vars to set when deploying: <span class="mono">${m.needs.env.map(esc).join(', ')}</span></p>` : ''}
  </div>`;
}

function hostingBox(job: JobView, hosts: ReturnType<typeof recommendHosts>) {
  const pending = !job.manifest;
  return `<div class="hosting">
    <h3 class="step__title">Hosting, ranked for you</h3>
    <p class="art__hint">${pending ? 'Preview based on your answers. Final picks lock in when the engine knows what the clone needs.' : `Matched to what the clone needs and your vibe (${esc(job.needs.budget)} budget, ${esc(job.needs.traffic)} traffic${job.needs.customDomain ? ', own domain' : ''}).`}</p>
    <div class="hosts">${hosts
      .map(
        (h) => `<div class="host${h.best ? ' host--best' : ''}">
          ${h.best ? '<span class="pad__badge">BEST FIT</span>' : ''}
          <b>${esc(h.name)}</b>
          <span class="pad__meta">${esc(h.why)}</span>
          <span class="pad__meta mono">${esc(h.cost)}</span>
          ${h.deployUrl && !pending ? `<a class="btn btn--small" href="${esc(h.deployUrl)}" target="_blank" rel="noopener">${h.id === 'ghpages' && job.live ? 'Open live site' : 'Deploy'}</a>` : ''}
          ${h.steps && !pending ? `<code class="mono">${esc(h.steps)}</code>` : ''}
        </div>`,
      )
      .join('')}</div>
  </div>`;
}

function topupBox() {
  return `<div class="alert alert--ok topup">
    <p><b>The engine used its whole budget.</b> Whatever it built is pushed to the repo. Top up to keep it going; it continues right where it stopped.</p>
    <div class="chips">${[500, 1000, 2500].map((c) => `<button class="chip" type="button" data-topup="${c}">+${formatUsd(c)}</button>`).join('')}</div>
  </div>`;
}

const P_STEP_LABELS: Record<Step, string> = {
  quote: 'Locking the price',
  upload: 'Pinning the logo',
  build: 'Building the launch',
  sign: 'Sign in your wallet',
  pay: 'Paying',
  start: 'Handing it to the engine',
  launch: 'Launching',
};

async function withSteps(job: JobView, steps: Step[], run: (h: { step: (s: Step) => void; note: (m: string) => void; handoff: () => string }) => Promise<void>) {
  if (busy) return;
  busy = true;
  const list = $('p-steps');
  list.innerHTML = steps.map((s) => `<li data-step="${s}">${P_STEP_LABELS[s]}</li>`).join('');
  list.hidden = false;
  const msg = $('p-msg');
  msg.innerHTML = '';
  let current: Step | null = null;
  const set = (s: Step | null, mode = 'active') => {
    const lis = [...list.querySelectorAll<HTMLElement>('li')];
    const idx = s ? lis.findIndex((li) => li.dataset.step === s) : lis.length;
    lis.forEach((li, i) => (li.dataset.state = i < idx ? 'done' : i === idx ? mode : ''));
  };
  try {
    await run({
      step: (s) => {
        current = s;
        set(s);
      },
      note: (m) => (msg.innerHTML = `<div class="alert alert--ok">${esc(m)}</div>`),
      handoff: () => projectUrl(job.id),
    });
    set(null);
    busy = false;
    await refresh(job.id);
  } catch (e) {
    busy = false;
    if ((e as Error).message === 'cancelled') {
      list.hidden = true;
      return;
    }
    if (current) set(current, 'error');
    msg.innerHTML = `<div class="alert">${esc(friendlyError(e))}</div>`;
  }
}

async function relaunch(job: JobView) {
  const pad = padInfo(job.token.pad);
  const canvas = document.createElement('canvas');
  await drawCoinArt(canvas, { ticker: job.token.ticker, emoji: emojiFor(job.token.name, job.target.label), seed: `${job.token.name}:0` });
  const image = await canvasToBlob(canvas, 'image/jpeg');
  await withSteps(job, pad.chain === 'solana' ? ['upload', 'build', 'sign', 'launch'] : ['upload', 'build', 'launch'], async (h) => {
    await launchForJob(job, pad, image, h);
    confetti();
  });
}

async function doTopup(job: JobView, cents: number) {
  await withSteps(job, ['quote', 'pay', 'start'], async (h) => {
    await topUp(job, cents, h);
    toast(`topped up ${formatUsd(cents)}. back to work`);
  });
}
