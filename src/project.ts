// Project page (#/p/<job id>): live engine feed, budget, the clone repo, SPEC.md, ranked hosting
// with one-click deploys, the project's token, and top-ups when the budget runs out. It also
// finishes whatever a paid order left in this browser (pending.ts): registration, top-ups, launches.
import { formatUsd, TIERS, type JobView } from '../shared/contract';
import { recommendHosts } from '../shared/hosting';
import { ApiError, createJob, getJob, needsClaim, recordToken, refused, type TokenProof } from './api';
import { claimFor, creditTopup, finishStonkLaunch, goneAfter, goneMessage, launchForJob, projectUrl, sentAt, setupError, topUp, txGone, untrack, type Hooks, type Step } from './checkout';
import { canvasToBlob, drawCoinArt } from './coinArt';
import { emojiFor } from './coinify';
import { friendlyError, isNotCharged, isRejection, PAID } from './errors';
import { RH_EXPLORER } from './evm/chain';
import { renderMarkdown } from './markdown';
import { CHAIN_LABEL, padInfo } from './pads';
import { clearLaunch, clearPending, clearTopup, loadLaunch, loadPending, loadTopups, savePending, saveTopup, type PendingJob, type PendingTopup, type SavedLaunch, type UnfinishedStonk, type UnrecordedLaunch } from './pending';
import { $, confetti, copy, esc, friendly, toast } from './ui';

let timer = 0;
let currentId = '';
/** Bumped on every visit: a slow response from an earlier visit never touches the page. */
let gen = 0;
let last: JobView | null = null;
/** The job whose wallet flow (launch, top-up, claim) is running. Its page isn't re-rendered meanwhile. */
let busyJob = '';
/** Recovery calls in flight, so overlapping polls don't post the same thing twice. */
let recovering = '';
let lastRecordTry = 0;
/** What the page last rendered: identical polls don't re-render (that drops focus and collapses SPEC.md). */
let rendered = { key: '', id: '', status: '' };
/** Shown at the top of a job's page, e.g. what happened after the payment. [job id, text] */
let notice: [string, string] | null = null;
/** Result of the last action on a job's page, kept across re-renders. [job id, html] */
let pageMsg: [string, string] | null = null;

export function projectBusy(): boolean {
  return busyJob !== '';
}

export function setProjectNotice(id: string, text: string) {
  notice = [id, text];
}

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
  gen++;
  currentId = '';
  last = null;
  rendered = { key: '', id: '', status: '' };
}

export async function showProject(id: string) {
  stopProject();
  currentId = id;
  if (notice?.[0] !== id) notice = null;
  if (pageMsg?.[0] !== id) pageMsg = null;
  renderShell(`<h2 class="panel__title">LOADING ${esc(id)}...</h2>`);
  await refresh(id, true);
}

async function refresh(id: string, first = false) {
  if (id !== currentId) return;
  const g = gen;
  const stale = () => g !== gen || id !== currentId;
  let job: JobView | null;
  try {
    job = await getJob(id);
    clearPending(id); // registered, even if the order's own createJob never heard back
  } catch (e) {
    if (stale()) return;
    if (!(e instanceof ApiError && e.status === 404)) {
      if (first) renderShell(`<div class="alert">${esc(friendlyError(e))}</div>`);
      return schedule(id, 10_000);
    }
    const pending = loadPending(id);
    if (!pending) return renderShell(`<p>No rea with id <span class="mono">${esc(id)}</span>. Check the link, or <a href="#/">start one</a>.</p>`);
    job = await registerPending(id, pending, stale);
  }
  if (!job || stale()) return;
  show(job);
  const after = await recover(job);
  if (stale()) return;
  if (after !== job) show(after);
  const live = after.status === 'starting' || after.status === 'running' ? 5000 : after.status === 'paused' ? 20_000 : 0;
  const local = owesEngine(after.id) ? 15_000 : 0;
  const wait = live && local ? Math.min(live, local) : live || local;
  if (wait) schedule(id, wait);
}

function show(job: JobView) {
  const prev = last;
  last = job;
  if (busyJob !== job.id) render(job);
  if (prev && prev.status !== 'done' && job.status === 'done') {
    confetti();
    toast('your clone is ready');
  }
}

/** Registrations in flight. Leaving the page and coming back joins the running call instead of starting another. */
const registering = new Map<string, Promise<JobView>>();

function registration(p: PendingJob): Promise<JobView> {
  const key = `${p.req.quote.id}:${p.req.claimSig ?? ''}`;
  let call = registering.get(key);
  if (!call) {
    call = createJob(p.req, undefined, 30_000).finally(() => registering.delete(key));
    registering.set(key, call);
  }
  return call;
}

/** A paid order this browser saved but the engine hasn't registered yet: finish it here. */
async function registerPending(id: string, p: PendingJob, stale: () => boolean): Promise<JobView | null> {
  renderShell(`<p>${PAID}. Finishing setup with the engine...</p>`);
  try {
    const job = await registration(p);
    clearPending(id);
    return job;
  } catch (e) {
    // A payment that provably never went through stops being shown as paid (and retried) forever.
    const gone = needsClaim(e) ? null : await goneAfter(e, p.req.quote.chain, p.req.payTx, { blockhash: p.blockhash, at: sentAt({ at: p.at, quote: p.req.quote }) });
    if (gone) untrack(id);
    if (stale()) return null;
    if (gone) {
      renderShell(`<div class="alert">${esc(goneMessage('payment', gone))} Nothing was launched. <a href="#/">Start a new rea</a>.</div>`);
    } else if (needsClaim(e)) {
      renderShell(`<div class="alert">${PAID}, but your wallet dropped its rea4u tag, so the engine can't match it on its own. Sign a free message with the paying wallet${
        p.payer ? ` (<span class="mono">${esc(shortAddr(p.payer))}</span>)` : ''
      } to claim it. No new payment.</div>
        <p><button class="btn btn--pink" type="button" id="p-claim">Sign to claim</button></p><div id="p-msg" aria-live="assertive"></div>`);
      $('p-claim').addEventListener('click', () => claimPending(id, p));
    } else if (refused(e)) {
      renderShell(`<div class="alert">${esc(setupError(e, p.req.payTx))}</div>`);
    } else {
      renderShell(`<div class="alert">${PAID}. The engine hasn't confirmed it yet (${esc(friendlyError(e))}). This page keeps retrying; don't pay again.</div>`);
      schedule(id, 10_000);
    }
    return null;
  }
}

async function claimPending(id: string, p: PendingJob) {
  if (busyJob) return;
  busyJob = id;
  try {
    p.req.claimSig = await claimFor(p.chain, p.payer, id, p.req.payTx, () => projectUrl(id));
    savePending(p);
  } catch (e) {
    if ((e as Error).message !== 'cancelled' && id === currentId) $('p-msg').innerHTML = `<div class="alert">${esc(claimError(e))}</div>`;
    return;
  } finally {
    busyJob = '';
  }
  await refresh(id);
}

/** A claim that didn't get signed. The payment behind it went through, and every message says so. */
function claimError(e: unknown): string {
  if (isRejection(e)) return `you didn't sign. ${PAID} and stays claimable: sign whenever you're ready.`;
  const m = friendlyError(e);
  return m.includes(PAID) ? m : `${m} (${PAID} and stays claimable, no need to pay again.)`;
}

/** Retries what this browser still owes the engine for this job: paid top-ups and launched tokens. */
async function recover(job: JobView): Promise<JobView> {
  if (busyJob === job.id || recovering === job.id) return job;
  recovering = job.id;
  try {
    for (const t of loadTopups(job.id)) {
      if (t.rejected || t.needsClaim) continue;
      try {
        job = await creditTopup(t, { timeoutMs: 15_000 });
        toast(`top-up of ${formatUsd(t.quote.usdCents)} credited. back to work`);
      } catch (e) {
        // Still saved (and marked when it needs a claim or was refused), unless it never went through.
        if (isNotCharged(e)) toast((e as Error).message);
      }
    }
    const l = loadLaunch(job.id);
    if (l && job.token.status === 'live') clearLaunch(job.id);
    else if (l?.kind === 'record' && Date.now() - lastRecordTry > 12_000) {
      lastRecordTry = Date.now();
      try {
        job = await recordToken(job.id, proofOf(l), 1);
        clearLaunch(job.id);
      } catch {
        // Not visible to the engine's RPC yet: next round. A Solana launch that provably failed or
        // expired never will be, so it stops holding back a relaunch.
        if (job.chain === 'solana' && l.blockhash && l.at && (await txGone('solana', l.tx, { blockhash: l.blockhash, at: l.at }))) clearLaunch(job.id);
      }
    }
    return job;
  } finally {
    recovering = '';
  }
}

function owesEngine(id: string): boolean {
  return loadTopups(id).some((t) => !t.rejected && !t.needsClaim) || loadLaunch(id)?.kind === 'record';
}

const proofOf = (l: UnrecordedLaunch): TokenProof => ({ mint: l.mint, tx: l.tx, url: l.url, armTx: l.armTx });
const shortAddr = (a: string) => `${a.slice(0, a.startsWith('0x') ? 6 : 4)}...${a.slice(-4)}`;

function schedule(id: string, ms: number) {
  clearTimeout(timer);
  timer = window.setTimeout(() => refresh(id), document.hidden ? Math.max(ms, 30_000) : ms);
}

function renderShell(inner: string) {
  rendered = { key: '', id: '', status: '' };
  const note = notice?.[0] === currentId ? `<div class="alert alert--ok" id="p-notice">${esc(notice[1])}</div>` : '';
  $('project-view').innerHTML = `<section class="panel project">${note}${inner}</section>`;
}

function explorerTx(job: JobView, tx: string) {
  return job.chain === 'solana' ? `https://solscan.io/tx/${tx}` : `${RH_EXPLORER}/tx/${tx}`;
}

/** Selector that finds the same control again after a re-render. */
function focusKey(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const a = [...el.attributes].find((x) => x.name.startsWith('data-'));
  return a ? `[${a.name}="${CSS.escape(a.value)}"]` : '';
}

function render(job: JobView, force = false) {
  const topups = loadTopups(job.id);
  const saved = loadLaunch(job.id);
  const msg = pageMsg?.[0] === job.id ? pageMsg[1] : '';
  const note = notice?.[0] === job.id ? notice[1] : '';
  const key = JSON.stringify([job, topups, saved, msg, note]);
  if (!force && key === rendered.key) return;
  const root = $('project-view');
  const same = rendered.id === job.id;
  const active = document.activeElement as HTMLElement | null;
  const focus = same && active && root.contains(active) ? focusKey(active) : '';
  const specWasOpen = root.querySelector<HTMLDetailsElement>('details.spec')?.open;
  const keepSpec = same && rendered.status === job.status && specWasOpen !== undefined;
  rendered = { key, id: job.id, status: job.status };

  const [label, color] = STATUS[job.status];
  const pct = job.budgetCents ? Math.min(100, Math.round((job.spentCents / job.budgetCents) * 100)) : 0;
  const repo = job.repo;
  const m = job.manifest;
  const pad = padInfo(job.token.pad);
  const feed = [...job.feed].reverse();
  const hosts = repo
    ? recommendHosts({ repoUrl: repo.url, fullName: repo.fullName, slug: repo.fullName.split('/')[1], branch: repo.branch, manifest: m, needs: job.needs, live: job.live })
    : [];

  root.innerHTML = `
  <section class="panel project" aria-labelledby="p-title">
    ${note ? `<div class="alert alert--ok" id="p-notice">${esc(note)}</div>` : ''}
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
    ${topups.map((t) => topupNote(job, t)).join('')}
    ${job.status === 'paused' ? topupBox() : ''}
    ${job.status === 'refused' ? `<div class="alert">The engine refused this target: ${esc(m?.refusal ?? 'it falls under the rules (no impersonation, fraud or bypassing access).')}</div>` : ''}
    ${job.error ? `<div class="alert">${esc(job.error)}</div>` : ''}
    <div class="project__grid">
      <div>
        <h3 class="step__title">Engine feed</h3>
        <ol class="feed" aria-live="polite">${feed.map((f) => `<li><time class="mono">${esc(timeOf(f.at))}</time> ${esc(f.text)}</li>`).join('') || '<li>waiting for the engine...</li>'}</ol>
        ${repo ? `<p class="repo"><a class="btn" href="${esc(repo.url)}" target="_blank" rel="noopener">Open the repo</a> <a class="btn btn--ghost" href="${esc(repo.url)}/generate" target="_blank" rel="noopener">Use as template</a></p>` : ''}
      </div>
      <div>${tokenCard(job, pad, saved)}</div>
    </div>
    ${m ? manifestBox(job) : ''}
    ${hosts.length ? hostingBox(job, hosts) : ''}
    ${job.spec ? `<details class="more spec" ${job.status === 'done' ? 'open' : ''}><summary>SPEC.md</summary><div class="md">${renderMarkdown(job.spec)}</div><p><button class="btn btn--small btn--ghost" type="button" id="spec-dl">Download SPEC.md</button></p></details>` : ''}
    <ol class="steps" id="p-steps" hidden></ol>
    <div id="p-msg" aria-live="assertive">${msg}</div>
    <p class="disclaimer">Share this page: <button class="btn btn--small btn--ghost" type="button" id="p-share">Copy link</button> · paid by <span class="mono">${esc(job.payer.slice(0, 6))}...${esc(job.payer.slice(-4))}</span> on ${esc(CHAIN_LABEL[job.chain])}</p>
  </section>`;

  const spec = root.querySelector<HTMLDetailsElement>('details.spec');
  if (spec && keepSpec) spec.open = !!specWasOpen;
  if (focus) root.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });

  $('p-share').addEventListener('click', () => copy(projectUrl(job.id), 'link copied'));
  document.getElementById('spec-dl')?.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([job.spec ?? ''], { type: 'text/markdown' }));
    a.download = 'SPEC.md';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  document.getElementById('p-launch')?.addEventListener('click', () => relaunch(job));
  document.getElementById('p-finish')?.addEventListener('click', () => saved?.kind === 'stonk' && finish(job, saved));
  document.getElementById('p-record')?.addEventListener('click', () => saved?.kind === 'record' && recordNow(job, saved));
  document.getElementById('p-copy-ca')?.addEventListener('click', () => copy(job.token.mint ?? '', 'address copied'));
  root.querySelectorAll<HTMLElement>('[data-topup]').forEach((b) => b.addEventListener('click', () => doTopup(job, Number(b.dataset.topup))));
  root.querySelectorAll<HTMLElement>('[data-claim-topup]').forEach((b) => b.addEventListener('click', () => claimTopup(job, b.dataset.claimTopup!)));
  root.querySelectorAll<HTMLElement>('[data-dismiss-topup]').forEach((b) =>
    b.addEventListener('click', () => {
      clearTopup(b.dataset.dismissTopup!);
      render(job);
    }),
  );
}

function timeOf(at: string) {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function topupNote(job: JobView, t: PendingTopup) {
  const amount = formatUsd(t.quote.usdCents);
  const tx = `<a href="${esc(explorerTx(job, t.payTx))}" target="_blank" rel="noopener">tx</a>`;
  if (t.rejected) {
    return `<div class="alert">Your +${amount} top-up payment (${tx}) went through, but the engine refused it: ${esc(t.rejected)}. Don't pay again; contact support with the tx.
      <button class="btn btn--small btn--ghost" type="button" data-dismiss-topup="${esc(t.quote.id)}">Dismiss</button></div>`;
  }
  if (t.needsClaim) {
    return `<div class="alert">Your +${amount} top-up payment (${tx}) went through, but your wallet dropped its rea4u tag. Sign a free message with the paying wallet (<span class="mono">${esc(shortAddr(t.payer))}</span>) to claim it.
      <button class="btn btn--small btn--pink" type="button" data-claim-topup="${esc(t.quote.id)}">Sign to claim</button></div>`;
  }
  return `<div class="alert alert--ok">Your +${amount} top-up payment (${tx}) went through. Crediting it with the engine...</div>`;
}

function tokenCard(job: JobView, pad: ReturnType<typeof padInfo>, saved: SavedLaunch | null) {
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
  if (saved?.kind === 'stonk') {
    const tx = `<a href="${esc(explorerTx(job, saved.createTx))}" target="_blank" rel="noopener">tx</a>`;
    // Until its receipt is read, the create may never have landed (dropped, or replaced in the wallet).
    const unread = !saved.launchId;
    return `<div class="token">
      <h3 class="step__title">$${esc(t.ticker)} isn't armed yet</h3>
      <p class="pad__meta">${unread ? `Its create transaction went out on ${esc(pad.name)} (${tx})` : `The token was created on ${esc(pad.name)} (${tx})`} but its supply isn't loaded into the curve. Finish it with the wallet that paid: approve + arm, no new token, no extra charge.</p>
      <button class="btn btn--pink" type="button" id="p-finish">Finish launch</button>
      ${unread ? `<p class="art__hint">If that create tx never landed (check the explorer), launch a new one instead.</p><button class="btn btn--ghost" type="button" id="p-launch">Launch a new one instead</button>` : ''}
    </div>`;
  }
  const recording =
    saved?.kind === 'record'
      ? `<p class="art__hint">Your launch (<a href="${esc(explorerTx(job, saved.tx))}" target="_blank" rel="noopener">tx</a>) went out; recording it here as soon as the engine sees it on-chain. <button class="btn btn--small btn--ghost" type="button" id="p-record">Check again</button></p>`
      : '';
  return `<div class="token">
    <h3 class="step__title">$${esc(t.ticker)} ${recording ? 'launch on its way' : t.status === 'failed' ? "didn't launch" : 'not launched yet'}</h3>
    <p class="pad__meta">${esc(t.name)} on ${esc(pad.name)}. No extra charge: the job is already paid. Use the wallet that paid.</p>
    ${recording || (t.status === 'pending' ? '<p class="art__hint">If you just launched, give it a minute and check your wallet before launching again.</p>' : '')}
    <button class="btn ${recording ? 'btn--ghost' : 'btn--pink'}" type="button" id="p-launch">${recording ? 'Launch a new one instead' : `Launch $${esc(t.ticker)} now`}</button>
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
          ${h.forkFirst && !pending && job.repo ? `<a class="pad__meta" href="${esc(job.repo.url)}/generate" target="_blank" rel="noopener">own a copy first (use as template)</a>` : ''}
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

async function withSteps(job: JobView, steps: Step[], run: (h: Hooks) => Promise<void>) {
  if (busyJob) {
    if (busyJob !== job.id) $('p-msg').innerHTML = '<div class="alert">finish the wallet flow you started on your other rea first.</div>';
    return;
  }
  busyJob = job.id;
  // Captured now: if the user navigates away meanwhile, these are detached and writes go nowhere.
  const list = $('p-steps');
  const msg = $('p-msg');
  list.innerHTML = steps.map((s) => `<li data-step="${s}">${P_STEP_LABELS[s]}</li>`).join('');
  list.hidden = !steps.length;
  const say = (html: string) => {
    pageMsg = html ? [job.id, html] : null;
    msg.innerHTML = html;
  };
  say('');
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
      note: (m) => say(`<div class="alert alert--ok">${esc(m)}</div>`),
      handoff: () => projectUrl(job.id),
    });
    set(null);
    say('');
  } catch (e) {
    if ((e as Error).message === 'cancelled') {
      list.hidden = true;
    } else {
      if (current) set(current, 'error');
      say(`<div class="alert">${esc(pageError(e))}</div>`);
    }
  } finally {
    busyJob = '';
  }
  // The flow drew into this page (steps, messages): redraw it from scratch.
  rendered.key = '';
  if (currentId === job.id) await refresh(job.id);
  else if (currentId && last) render(last);
}

/** No REA IT button here, and a refusal in the wallet sent nothing. */
function pageError(e: unknown): string {
  if (isRejection(e)) return 'you rejected it in the wallet. nothing was sent.';
  return friendlyError(e).replace(/hit REA IT( again| when ready)?/g, 'try again');
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

async function finish(job: JobView, saved: UnfinishedStonk) {
  await withSteps(job, ['launch'], async (h) => {
    await finishStonkLaunch(job, saved, h);
    confetti();
  });
}

async function recordNow(job: JobView, saved: UnrecordedLaunch) {
  await withSteps(job, [], async () => {
    await recordToken(job.id, proofOf(saved), 2);
    clearLaunch(job.id);
    toast(`$${job.token.ticker} recorded`);
  });
}

async function doTopup(job: JobView, cents: number) {
  await withSteps(job, ['quote', 'pay', 'start'], async (h) => {
    await topUp(job, cents, h);
    toast(`topped up ${formatUsd(cents)}. back to work`);
  });
}

async function claimTopup(job: JobView, quoteId: string) {
  const t = loadTopups(job.id).find((x) => x.quote.id === quoteId);
  if (!t) return;
  await withSteps(job, ['sign', 'start'], async (h) => {
    h.step('sign');
    const claimSig = await claimFor(job.chain, t.payer, t.quote.id, t.payTx, h.handoff).catch((e) => {
      throw (e as Error)?.message === 'cancelled' ? e : friendly(claimError(e));
    });
    const entry: PendingTopup = { ...t, claimSig, needsClaim: undefined };
    saveTopup(entry);
    h.step('start');
    await creditTopup(entry, { onWait: h.note });
    toast('top-up credited. back to work');
  });
}
