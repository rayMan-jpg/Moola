// The money path. One order = pay the engine's budget + launch the project's token.
//
// Solana: the payment and the launch are built first and signed together in ONE wallet prompt.
// The payment is broadcast first; the launch only goes out once the payment has landed, so a
// token is never launched without a paid job (and nothing is charged if the payment fails).
// Robinhood Chain: two prompts (pay, then launch), same ordering.

import { VersionedTransaction } from '@solana/web3.js';
import { formatUsd, payMemo, type HostingNeeds, type JobRequest, type JobView, type Target, type Tier } from '../shared/contract';
import { createJob, getQuote, recordToken, rememberJob, topupJob } from './api';
import { friendlyError } from './errors';
import { getBalanceEth, sendEvm, utf8Hex, waitReceipt } from './evm/chain';
import { uploadImage } from './metadata';
import type { PadInfo } from './pads';
import { buildSolPayment, PAY_FEE_SOL } from './payment';
import { getBalanceSol, isBlockhashValid, RpcError, sendRaw, waitForLanding } from './rpc';
import { friendly } from './ui';
import { canSignMessage, canSignOnly, signAndSend, signMany, signMessage, txSignature, type Connected } from './wallet';
import { ensureEvm, ensureSol, wallets } from './wallets';

export type Step = 'quote' | 'upload' | 'build' | 'sign' | 'pay' | 'start' | 'launch';

export interface Hooks {
  step(s: Step): void;
  note(msg: string): void;
  /** URL that reopens this order inside a mobile wallet's browser. */
  handoff(): string;
}

export interface OrderInput {
  target: Target;
  tier: Tier;
  name: string;
  ticker: string;
  pad: PadInfo;
  devBuy: number;
  needs: HostingNeeds;
  image: Blob;
}

export interface OrderResult {
  jobId: string;
  launched: boolean;
  launchError?: string;
}

/** Where the site is published. Token metadata always links here (launchpads reject http:// links). */
export const CANONICAL_SITE = 'https://rayman-jpg.github.io/Moola/';

export function projectUrl(id: string): string {
  const base = location.protocol === 'https:' ? `${location.origin}${location.pathname}` : CANONICAL_SITE;
  return `${base}#/p/${id}`;
}

export function tokenDescription(name: string, ticker: string): string {
  return `${name} ($${ticker}) was built by rea4u, the reverse-engineer-anything engine. Clone, spec and hosting live on the project page.`;
}

// A paid job that hasn't been registered yet survives a closed tab: the project page retries it.
const PENDING = (id: string) => `rea4u.pending.${id}`;
export function savePending(req: JobRequest) {
  try {
    localStorage.setItem(PENDING(req.quote.id), JSON.stringify(req));
  } catch {
    /* private mode */
  }
}
export function loadPending(id: string): JobRequest | null {
  try {
    return JSON.parse(localStorage.getItem(PENDING(id)) ?? 'null') as JobRequest | null;
  } catch {
    return null;
  }
}
export function clearPending(id: string) {
  try {
    localStorage.removeItem(PENDING(id));
  } catch {
    /* ignore */
  }
}

function messageChanged(original: VersionedTransaction, signed: Uint8Array): boolean {
  const a = original.message.serialize();
  const b = VersionedTransaction.deserialize(signed).message.serialize();
  return a.length !== b.length || a.some((x, i) => x !== b[i]);
}

async function broadcast(signed: Uint8Array) {
  try {
    await sendRaw(signed, { preflight: true });
  } catch (e) {
    // A definitive node answer (bad signature, would fail, no funds) stops here; network blips fall
    // through to the rebroadcast loop in waitForLanding.
    if (e instanceof RpcError && !/already been processed|AlreadyProcessed/i.test(e.message)) throw e;
  }
}

async function register(req: JobRequest, h: Hooks) {
  savePending(req);
  rememberJob({ id: req.quote.id, project: req.project.name, target: req.quote.target.label, at: Date.now() });
  h.step('start');
  await createJob(req, () => h.note('payment landed, waiting for the engine to see it confirmed...'));
  clearPending(req.quote.id);
}

export async function placeOrder(o: OrderInput, h: Hooks): Promise<OrderResult> {
  return o.pad.chain === 'solana' ? solanaOrder(o, h) : evmOrder(o, h);
}

function checkSolWallet(wallet: Connected, pad: PadInfo) {
  const lp = pad.sol!;
  if (lp.requires?.includes('signMessage') && !canSignMessage(wallet)) {
    throw friendly(`${pad.name} wants a signed login message and this wallet can't sign messages (Ledger?). pick another launchpad.`);
  }
  if (lp.requires?.includes('signTransaction') && !canSignOnly(wallet)) {
    throw friendly(`this wallet can't do ${pad.name} launches (it can't sign without sending). use Phantom, Solflare or Backpack, or pick another launchpad.`);
  }
}

async function solanaOrder(o: OrderInput, h: Hooks): Promise<OrderResult> {
  const lp = o.pad.sol!;
  const wallet = await ensureSol(h.handoff);
  checkSolWallet(wallet, o.pad);
  const devBuySol = lp.devBuy ? o.devBuy : 0;

  h.step('quote');
  const { quote, note } = await getQuote({ target: o.target.url, tier: o.tier, chain: 'solana' });
  if (note) h.note(note);
  const bal = await getBalanceSol(wallet.address).catch(() => null);
  const need = Number(quote.amount) / 1e9 + devBuySol + lp.overheadSol + PAY_FEE_SOL;
  if (bal !== null && bal < need) {
    throw friendly(`need ~${need.toFixed(3)} SOL (${formatUsd(quote.usdCents)} engine budget + launch + fees), wallet has ${bal.toFixed(3)} SOL. top up ser.`);
  }

  const page = projectUrl(quote.id);
  const prepared = await lp.prepare(
    { name: o.name, ticker: o.ticker, description: tokenDescription(o.name, o.ticker), image: o.image, website: page, devBuySol, creator: wallet.address },
    (s) => h.step(s === 'upload' ? 'upload' : 'build'),
    { signMessage: canSignMessage(wallet) ? (m) => signMessage(wallet, m) : undefined },
  );
  if (prepared.notice) h.note(prepared.notice);
  const payTx = await buildSolPayment(quote, wallet.address);

  h.step('sign');
  if (wallets.sol?.address !== wallet.address) throw friendly('you switched wallet accounts mid-order. nothing was sent. hit REA IT again.');
  let signedPay: Uint8Array | null = null;
  let signedLaunch: Uint8Array | null = null;
  let paySig: string;
  if (canSignOnly(wallet)) {
    [signedPay, signedLaunch] = await signMany(wallet, [payTx, prepared.tx]);
    if (messageChanged(prepared.tx, signedLaunch)) {
      if (!prepared.resign) throw friendly(`${wallet.wallet.name} changed the launch transaction while signing, which breaks ${o.pad.name}'s signature. nothing was sent. try again or use another wallet.`);
      signedLaunch = prepared.resign(signedLaunch);
    }
    if (!(await isBlockhashValid(payTx.message.recentBlockhash).catch(() => true))) {
      throw friendly('the transactions expired while they waited in your wallet. nothing was sent. hit REA IT again (and sign a bit faster).');
    }
    h.step('pay');
    paySig = txSignature(signedPay);
    await broadcast(signedPay);
  } else {
    // Sign-and-send-only wallets: pay now, launch with a second prompt after the payment lands.
    h.step('pay');
    paySig = await signAndSend(wallet, payTx, (b) => sendRaw(b, { preflight: true }));
  }
  const sp = signedPay;
  const landed = await waitForLanding(paySig, payTx.message.recentBlockhash, { rebroadcast: sp ? () => sendRaw(sp) : undefined });
  if (landed.status === 'failed') throw friendly('the payment failed on-chain. nothing was charged and nothing launched.');
  if (landed.status === 'expired') throw friendly("the payment didn't land before it expired (network busy). nothing was charged and nothing launched. hit REA IT again.");

  await register({ quote, payTx: paySig, project: { name: o.name }, token: { name: o.name, ticker: o.ticker, pad: o.pad.id }, needs: o.needs }, h);

  h.step('launch');
  try {
    let launchSig: string;
    const blockhash = prepared.tx.message.recentBlockhash;
    if (signedLaunch) {
      if (!(await isBlockhashValid(blockhash).catch(() => true))) throw friendly('the launch transaction expired while the payment confirmed. launch it from your project page, no extra charge.');
      launchSig = txSignature(signedLaunch);
      const sl = signedLaunch;
      if (prepared.submit) await prepared.submit(sl);
      else await broadcast(sl);
      const st = await waitForLanding(launchSig, blockhash, { rebroadcast: prepared.submit ? undefined : () => sendRaw(sl) });
      if (st.status === 'failed' || st.status === 'expired') throw friendly(`the launch ${st.status === 'failed' ? 'failed on-chain' : 'expired before it landed'}. relaunch from your project page, no extra charge.`);
      if (st.status === 'unknown') return { jobId: quote.id, launched: false, launchError: 'launch sent but not confirmed yet. check your wallet before relaunching from the project page.' };
    } else {
      launchSig = await signAndSend(wallet, prepared.tx, (b) => sendRaw(b, { preflight: true }));
      const st = await waitForLanding(launchSig, blockhash);
      if (st.status !== 'confirmed') throw friendly('the launch did not confirm. relaunch from your project page, no extra charge.');
    }
    await recordToken(quote.id, { mint: prepared.mint, tx: launchSig });
    return { jobId: quote.id, launched: true };
  } catch (e) {
    await recordToken(quote.id, { failed: true }).catch(() => undefined);
    return { jobId: quote.id, launched: false, launchError: friendlyError(e) };
  }
}

async function evmOrder(o: OrderInput, h: Hooks): Promise<OrderResult> {
  const lp = o.pad.evm!;
  const wallet = await ensureEvm(h.handoff);
  const devBuyEth = lp.devBuy ? o.devBuy : 0;

  h.step('quote');
  const { quote, note } = await getQuote({ target: o.target.url, tier: o.tier, chain: 'robinhood' });
  if (note) h.note(note);
  const bal = await getBalanceEth(wallet.address).catch(() => null);
  const need = Number(quote.amount) / 1e18 + devBuyEth + lp.overheadEth;
  if (bal !== null && bal < need) {
    throw friendly(`need ~${need.toFixed(4)} ETH on Robinhood Chain (${formatUsd(quote.usdCents)} engine budget + launch), wallet has ${bal.toFixed(4)} ETH. bridge some over.`);
  }

  h.step('upload');
  const logo = await uploadImage(o.image);
  h.step('build');
  const page = projectUrl(quote.id);
  // Simulated from the user's address before any money moves.
  const prepared = await lp.prepare({ name: o.name, ticker: o.ticker, description: tokenDescription(o.name, o.ticker), logo, website: page, devBuyEth, creator: wallet.address });

  h.step('pay');
  const payHash = await sendEvm(wallet, { to: quote.treasury as `0x${string}`, data: utf8Hex(payMemo(quote.id)), value: BigInt(quote.amount) });
  const pr = await waitReceipt(payHash);
  if (pr.status !== '0x1') throw friendly('the payment reverted. nothing was charged and nothing launched.');

  await register({ quote, payTx: payHash, project: { name: o.name }, token: { name: o.name, ticker: o.ticker, pad: o.pad.id }, needs: o.needs }, h);

  h.step('launch');
  try {
    const { hash, token } = await sendEvmLaunch(prepared, wallet);
    await recordToken(quote.id, { mint: token, tx: hash });
    return { jobId: quote.id, launched: true };
  } catch (e) {
    await recordToken(quote.id, { failed: true }).catch(() => undefined);
    return { jobId: quote.id, launched: false, launchError: friendlyError(e) };
  }
}

async function sendEvmLaunch(prepared: Awaited<ReturnType<NonNullable<PadInfo['evm']>['prepare']>>, wallet: NonNullable<typeof wallets.evm>) {
  const hash = await sendEvm(wallet, prepared.tx);
  const rc = await waitReceipt(hash);
  if (rc.status !== '0x1') throw friendly('the launch reverted on-chain. relaunch from your project page, no extra charge.');
  const token = prepared.tokenFrom(rc) ?? prepared.predicted;
  if (!token) throw friendly('launched, but could not read the token address. check the explorer.');
  return { hash, token };
}

/** Project page: launch (or relaunch) the job's token without paying again. Must be the paying wallet. */
export async function launchForJob(job: JobView, pad: PadInfo, image: Blob, h: Hooks): Promise<void> {
  const page = projectUrl(job.id);
  const t = job.token;
  if (pad.chain === 'solana') {
    const wallet = await ensureSol(h.handoff);
    if (wallet.address !== job.payer) throw friendly(`connect the wallet that paid for this job (${job.payer.slice(0, 4)}...${job.payer.slice(-4)}).`);
    checkSolWallet(wallet, pad);
    const prepared = await pad.sol!.prepare(
      { name: t.name, ticker: t.ticker, description: tokenDescription(t.name, t.ticker), image, website: page, devBuySol: 0, creator: wallet.address },
      (s) => h.step(s === 'upload' ? 'upload' : 'build'),
      { signMessage: canSignMessage(wallet) ? (m) => signMessage(wallet, m) : undefined },
    );
    h.step('sign');
    let sig: string;
    const blockhash = prepared.tx.message.recentBlockhash;
    if (canSignOnly(wallet)) {
      let [signed] = await signMany(wallet, [prepared.tx]);
      if (messageChanged(prepared.tx, signed)) {
        if (!prepared.resign) throw friendly('your wallet changed the transaction while signing. nothing was sent.');
        signed = prepared.resign(signed);
      }
      h.step('launch');
      sig = txSignature(signed);
      if (prepared.submit) await prepared.submit(signed);
      else await broadcast(signed);
      const s = signed;
      const st = await waitForLanding(sig, blockhash, { rebroadcast: prepared.submit ? undefined : () => sendRaw(s) });
      if (st.status !== 'confirmed') throw friendly(st.status === 'unknown' ? 'sent but not confirmed yet. check your wallet before trying again.' : `the launch ${st.status}. nothing was created.`);
    } else {
      h.step('launch');
      sig = await signAndSend(wallet, prepared.tx, (b) => sendRaw(b, { preflight: true }));
      const st = await waitForLanding(sig, blockhash);
      if (st.status !== 'confirmed') throw friendly('the launch did not confirm. check your wallet before trying again.');
    }
    await recordToken(job.id, { mint: prepared.mint, tx: sig });
    return;
  }
  const wallet = await ensureEvm(h.handoff);
  if (wallet.address !== job.payer.toLowerCase()) throw friendly(`connect the wallet that paid for this job (${job.payer.slice(0, 6)}...${job.payer.slice(-4)}).`);
  h.step('upload');
  const logo = await uploadImage(image);
  h.step('build');
  const prepared = await pad.evm!.prepare({ name: t.name, ticker: t.ticker, description: tokenDescription(t.name, t.ticker), logo, website: page, devBuyEth: 0, creator: wallet.address });
  h.step('launch');
  const { hash, token } = await sendEvmLaunch(prepared, wallet);
  await recordToken(job.id, { mint: token, tx: hash });
}

/** Project page: pay more to raise a paused job's budget. Anyone can top up a job. */
export async function topUp(job: JobView, usdCents: number, h: Hooks): Promise<JobView> {
  h.step('quote');
  const { quote } = await getQuote({ target: job.target.url, tier: job.tier, chain: job.chain, topup: job.id, usdCents });
  let tx: string;
  if (job.chain === 'solana') {
    const wallet = await ensureSol(h.handoff);
    const payTx = await buildSolPayment(quote, wallet.address);
    h.step('pay');
    let rebroadcast: (() => Promise<unknown>) | undefined;
    if (canSignOnly(wallet)) {
      const [signed] = await signMany(wallet, [payTx]);
      tx = txSignature(signed);
      await broadcast(signed);
      rebroadcast = () => sendRaw(signed);
    } else {
      tx = await signAndSend(wallet, payTx, (b) => sendRaw(b, { preflight: true }));
    }
    const st = await waitForLanding(tx, payTx.message.recentBlockhash, { rebroadcast });
    if (st.status === 'failed' || st.status === 'expired') throw friendly(`the top-up ${st.status === 'failed' ? 'failed' : 'expired'}. nothing was charged.`);
  } else {
    const wallet = await ensureEvm(h.handoff);
    h.step('pay');
    tx = await sendEvm(wallet, { to: quote.treasury as `0x${string}`, data: utf8Hex(payMemo(quote.id)), value: BigInt(quote.amount) });
    const r = await waitReceipt(tx);
    if (r.status !== '0x1') throw friendly('the top-up reverted. nothing was charged.');
  }
  h.step('start');
  return topupJob(job.id, quote, tx, () => h.note('payment landed, waiting for confirmation...'));
}
