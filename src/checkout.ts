// The money path. One order = pay the engine's budget + launch the project's token.
//
// Solana: the payment and the launch are built first and signed together in ONE wallet prompt.
// The payment is broadcast first; the launch only goes out once the payment has landed, so a
// token is never launched without a paid job (and nothing is charged if the payment fails).
// Robinhood Chain: two prompts (pay, then launch), same ordering.
//
// From the moment a payment exists, everything needed to finish it is saved in this browser
// (pending.ts) and the order never throws again: whatever is left, the project page finishes.

import { VersionedTransaction } from '@solana/web3.js';
import { claimMessage, formatUsd, payMemo, validateOrderNames, type ChainId, type HostingNeeds, type JobView, type Quote, type QuoteRequest, type Target, type Tier } from '../shared/contract';
import { ApiError, createJob, forgetJob, getQuote, needsClaim, recordToken, refused, rememberJob, topupJob, type TokenProof } from './api';
import { isNotCharged, isRejection, notCharged, PAID, paidError, withPaid } from './errors';
import { evmRpc, getBalanceEth, personalSign, sendEvm, txInput, txState, utf8Hex, waitReceipt, type EvmConnected, type EvmReceipt } from './evm/chain';
import { launchCreated, stonkCoinUrl, stonkRemainingSteps } from './launchpads/stonk';
import { uploadImage } from './metadata';
import type { PadInfo } from './pads';
import { buildSolPayment, PAY_FEE_SOL } from './payment';
import { armsOf, clearLaunch, clearPending, clearTopup, saveLaunch, savePending, saveTopup, type PendingJob, type PendingTopup, type UnfinishedStonk } from './pending';
import { getBalanceSol, isBlockhashValid, landingNow, RpcError, sendRaw, toBase64, waitForLanding } from './rpc';
import { friendly } from './ui';
import { canSignMessage, canSignOnly, signAndSend, signMany, signMessage, txSignature, type Connected } from './wallet';
import { ensureEvm, ensureSol, wallets } from './wallets';

export type Step = 'quote' | 'upload' | 'build' | 'sign' | 'pay' | 'start' | 'launch';

export interface Hooks {
  step(s: Step): void;
  note(msg: string): void;
  /** URL that reopens this order inside a mobile wallet's browser. */
  handoff(): string;
  /** The payment for this job landed (or may have): from here on nobody gets sent back to pay. */
  paid?(jobId: string): void;
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
  /** For the project page; always says the payment went through. */
  message?: string;
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

const short = (a: string) => `${a.slice(0, a.startsWith('0x') ? 6 : 4)}...${a.slice(-4)}`;
const sameAddr = (chain: ChainId, a: string, b: string) => (chain === 'solana' ? a === b : a.toLowerCase() === b.toLowerCase());

// The engine takes a claimed (untagged) payment only until shortly after its quote expires, and an
// EVM wallet popup never expires, so an EVM payment always starts with plenty of quote left.
const REQUOTE_MS = 2 * 60_000;
const expiringSoon = (q: Quote) => q.expiresAt - Date.now() < REQUOTE_MS;

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

// ── claims: a payment whose rea4u tag the wallet dropped is matched by a signature of the payer ──
type PayingWallet = { chain: 'solana'; wallet: Connected } | { chain: 'robinhood'; wallet: EvmConnected };

async function signClaim(p: PayingWallet, quoteId: string, tx: string): Promise<string> {
  const msg = claimMessage(quoteId, tx);
  const name = p.chain === 'solana' ? p.wallet.wallet.name : p.wallet.info.name;
  if (p.chain === 'solana' && !canSignMessage(p.wallet)) {
    throw friendly(`${PAID}, but your wallet dropped its rea4u tag and ${name} can't sign the claim message. don't pay again: contact support with tx ${tx}.`);
  }
  try {
    return p.chain === 'robinhood' ? await personalSign(p.wallet, msg) : toBase64(await signMessage(p.wallet, new TextEncoder().encode(msg)));
  } catch (e) {
    // A "no" stays a no: the claim can still be signed later. Anything else says the money is safe.
    if (isRejection(e)) throw e;
    const raw = String((e as { message?: string })?.message ?? e);
    if (/modified message/i.test(raw)) {
      throw friendly(`${PAID}, but your wallet dropped its rea4u tag and ${name} signed a modified claim message (hardware wallet?), which the engine can't verify. don't pay again: contact support with tx ${tx}.`);
    }
    throw friendly(`${PAID}, but ${name} couldn't sign the free claim message (${raw.slice(0, 120) || 'unknown error'}). don't pay again: sign it on the project page, or contact support with tx ${tx}.`);
  }
}

/** Asks the paying wallet for the claim at most once per payment; a refusal isn't re-prompted. */
function claimer(p: PayingWallet, quoteId: string, tx: string): () => Promise<string> {
  let once: Promise<string> | null = null;
  return () => (once ??= signClaim(p, quoteId, tx));
}

/** Project page: sign the claim for a saved payment with the connected wallet, which must be the payer. */
export async function claimFor(chain: ChainId, payer: string, quoteId: string, tx: string, handoff: () => string): Promise<string> {
  const p: PayingWallet = chain === 'solana' ? { chain, wallet: await ensureSol(handoff) } : { chain, wallet: await ensureEvm(handoff) };
  if (payer && !sameAddr(chain, p.wallet.address, payer)) throw friendly(`connect the wallet that paid (${short(payer)}) to sign the claim. ${PAID}, no need to pay again.`);
  return signClaim(p, quoteId, tx);
}

const CLAIM_NOTE = `${PAID}, but your wallet dropped its rea4u tag. sign the free claim message so the engine can match it.`;
const CLAIM_LATER = `${PAID}, but your wallet dropped its rea4u tag, so the engine needs a claim signature. sign it on the project page (free, no new payment).`;

// ── registering a paid job ──
function pendingJob(o: OrderInput, quote: Quote, payTx: string, payer: string, blockhash?: string, nonce?: number): PendingJob {
  return {
    req: { quote, payTx, project: { name: o.name }, token: { name: o.name, ticker: o.ticker, pad: o.pad.id }, needs: o.needs },
    payer,
    chain: quote.chain,
    ...(blockhash ? { blockhash } : {}),
    ...(nonce !== undefined ? { nonce } : {}),
    at: Date.now(),
  };
}

/** The account's next nonce, read just before an EVM payment: that's the nonce the payment will use. */
async function nextNonce(address: string): Promise<number | undefined> {
  try {
    return Number(BigInt(await evmRpc<string>('eth_getTransactionCount', [address, 'pending'])));
  } catch {
    return undefined;
  }
}

/** Saved before the payment is even confirmed: a closed tab or a timeout can't lose it. */
function track(p: PendingJob) {
  savePending(p);
  rememberJob({ id: p.req.quote.id, project: p.req.project.name, target: p.req.quote.target.label, at: Date.now() });
}

/** The payment provably never happened. */
export function untrack(id: string) {
  clearPending(id);
  forgetJob(id);
}

// ── payments that never went through after all ──
/** The engine found the payment and it failed on-chain: nothing was charged. */
export function failedOnChain(e: unknown): boolean {
  return e instanceof ApiError && e.status === 402 && /failed on-chain/i.test(e.message);
}

/** The engine looked and the payment isn't on-chain (yet). */
function notOnChainYet(e: unknown): boolean {
  return e instanceof ApiError && e.status === 202;
}

/** 'replaced' is the odd one out: the wallet swapped the tx for another (speed up), which may have charged. */
export type Gone = 'failed' | 'expired' | 'dropped' | 'replaced';

// A transaction the RPCs don't know may still be propagating (or, on Solana, carry a newer blockhash
// than ours if the wallet swapped it), so a fresh one never counts as gone.
const SOL_GONE_AFTER_MS = 3 * 60_000;
const EVM_GONE_AFTER_MS = 10 * 60_000;

/**
 * Whether a saved payment (or Solana launch) provably never went through: 'failed' (failed on-chain / reverted),
 * 'expired' (Solana: its blockhash died and no node has the signature) or 'dropped' (EVM: no RPC
 * knows the hash any more). Null while it could still land, and whenever the chain can't tell.
 */
export async function txGone(chain: ChainId, tx: string, opts: GoneOpts): Promise<Gone | null> {
  try {
    if (chain === 'solana') {
      if (!opts.blockhash || Date.now() - opts.at < SOL_GONE_AFTER_MS) return null;
      const st = await landingNow(tx, opts.blockhash);
      return st === 'failed' || st === 'expired' ? st : null;
    }
    const r = await evmRpc<EvmReceipt | null>('eth_getTransactionReceipt', [tx]);
    if (r) return r.status === '0x1' ? null : 'failed';
    if (Date.now() - opts.at < EVM_GONE_AFTER_MS) return null;
    if ((await txState(tx)) !== 'gone') return null;
    // Unknown hash, but the sender's nonce moved past ours: another tx took its place (speed up / cancel).
    if (opts.from && opts.nonce !== undefined) {
      const used = Number(BigInt(await evmRpc<string>('eth_getTransactionCount', [opts.from, 'latest'])));
      if (used > opts.nonce) return 'replaced';
    }
    return 'dropped';
  } catch {
    return null;
  }
}

export interface GoneOpts {
  blockhash?: string;
  at: number;
  /** EVM: the paying address and the payment's nonce, to tell "replaced" from "dropped". */
  from?: string;
  nonce?: number;
}

export function goneMessage(what: 'payment' | 'top-up', gone: Gone): string {
  if (gone === 'replaced') {
    return `your wallet replaced that ${what} with a new transaction (speed up or cancel), so it has a new hash. if the new one went through, paste its hash on the project page to finish (no new payment). if you cancelled it, nothing was charged.`;
  }
  if (gone === 'failed') return `that ${what} failed on-chain, so nothing was charged (just the network fee).`;
  if (gone === 'expired') return `that ${what} never landed (it expired before it confirmed), so nothing was charged.`;
  return `that ${what} never made it on-chain (dropped, or replaced with speed up / cancel in your wallet), so nothing was charged for it. if your wallet shows a sped-up copy that went through, contact support with that tx instead of paying again.`;
}

/** Checks a payment the engine couldn't register: did it go through at all? */
export async function goneAfter(e: unknown, chain: ChainId, tx: string, opts: GoneOpts): Promise<Gone | null> {
  if (failedOnChain(e)) return 'failed';
  return notOnChainYet(e) ? txGone(chain, tx, opts) : null;
}

/** When a payment was sent, for saved entries from builds that didn't record it: no earlier than its quote. */
export const sentAt = (p: { at?: number; quote: Quote }) => p.at ?? p.quote.issuedAt;

/** What to say when a landed payment isn't registered yet. Never asks for another payment. */
export function setupError(e: unknown, tx: string): string {
  if (failedOnChain(e)) return goneMessage('payment', 'failed');
  if (refused(e)) return `${PAID} (tx ${tx}) but the engine refused it: ${e.message}. don't pay again: contact support with this tx.`;
  if (needsClaim(e) || isRejection(e)) return CLAIM_LATER;
  if ((e as { friendly?: boolean })?.friendly) return withPaid((e as Error).message);
  return `${PAID}. the engine hasn't confirmed it yet; the project page keeps retrying. don't pay again.`;
}

/** A claim signature that didn't happen: the signer's own explanation (it says the payment is safe), or sign it later. */
function claimFailure(e: unknown, later: string): string {
  return !isRejection(e) && (e as { friendly?: boolean })?.friendly ? withPaid((e as Error).message) : later;
}

/** Registers the paid job. Returns null when done, or a message: the project page takes it from there. */
async function register(pending: PendingJob, h: Hooks, claim: () => Promise<string>): Promise<string | null> {
  const { req } = pending;
  h.step('start');
  const wait = () => h.note(`${PAID}. waiting for the engine to see it confirmed...`);
  let claiming = false;
  try {
    try {
      await createJob(req, wait);
    } catch (e) {
      if (!needsClaim(e)) throw e;
      h.note(CLAIM_NOTE);
      claiming = true;
      req.claimSig = await claim();
      claiming = false;
      savePending(pending);
      await createJob(req, wait);
    }
    clearPending(req.quote.id);
    return null;
  } catch (e) {
    if (claiming) return claimFailure(e, CLAIM_LATER);
    const gone = await goneAfter(e, req.quote.chain, req.payTx, { blockhash: pending.blockhash, at: sentAt({ at: pending.at, quote: req.quote }), from: pending.payer, nonce: pending.nonce });
    // Replaced may have charged: keep it; the project page asks for the new hash.
    if (gone === 'replaced') return goneMessage('payment', gone);
    if (gone) {
      untrack(req.quote.id);
      throw notCharged(`${goneMessage('payment', gone)} nothing was launched. hit REA IT again.`);
    }
    return setupError(e, req.payTx);
  }
}

/**
 * The part of an order after the money moved. Never throws, so the user always lands on the project
 * page, unless the payment provably never went through after all.
 */
async function afterPayment(jobId: string, run: () => Promise<OrderResult>): Promise<OrderResult> {
  try {
    return await run();
  } catch (e) {
    if (isNotCharged(e)) throw e;
    return { jobId, launched: false, message: paidError(e) };
  }
}

/** Saves the launch first, so the project page can retry the recording if the engine can't confirm it yet. */
async function tryRecord(jobId: string, proof: TokenProof): Promise<boolean> {
  saveLaunch(jobId, { kind: 'record', ...proof });
  try {
    await recordToken(jobId, proof);
    clearLaunch(jobId);
    return true;
  } catch {
    return false;
  }
}

async function recordLaunch(jobId: string, proof: TokenProof): Promise<OrderResult> {
  if (await tryRecord(jobId, proof)) return { jobId, launched: true };
  return { jobId, launched: true, message: `${PAID} and your token is live. the project page is still recording it.` };
}

/**
 * ETH payments are verified as plain transfers (tx.to = treasury). Smart-contract wallets (Safe,
 * ERC-4337) wrap them in contract calls the public RPCs can't trace, so they're refused up front.
 * EIP-7702 delegated EOAs (code 0xef0100...) still send plain transactions and are fine.
 */
async function assertPlainEvmAccount(address: string) {
  const code = (await evmRpc<string>('eth_getCode', [address, 'latest']).catch(() => '0x')) || '0x';
  if (code !== '0x' && !code.toLowerCase().startsWith('0xef0100')) {
    throw friendly("smart-contract wallets can't pay on Robinhood Chain yet (the payment can't be verified). use a regular account in MetaMask, Rabby or Phantom.");
  }
}

export async function placeOrder(o: OrderInput, h: Hooks): Promise<OrderResult> {
  // The engine would refuse these after the payment: refuse them before any wallet prompt instead.
  const bad = validateOrderNames(o.target, o.name, o.name, o.ticker);
  if (bad) throw friendly(bad.msg);
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

/**
 * A launch that threw while going out. Its saved record is dropped only when it provably can't land
 * (the node refused it, or the launchpad's submit saw it fail or expire): forgetting a launch that
 * lands anyway would invite a second coin. True when it may still land.
 */
function launchMayLand(jobId: string, viaSubmit: boolean, e: unknown): boolean {
  const landing = (e as { landing?: string })?.landing;
  if (viaSubmit && landing !== 'failed' && landing !== 'expired') return true;
  clearLaunch(jobId);
  return false;
}

const SENT_UNCONFIRMED = `${PAID}. the launch was sent but isn't confirmed yet; the project page keeps checking. check your wallet before relaunching.`;

/** Waits for a Solana launch; drops its saved record when it provably failed. False when still unknown. */
async function landLaunch(jobId: string, sig: string, blockhash: string, rebroadcast?: () => Promise<unknown>): Promise<boolean> {
  const st = await waitForLanding(sig, blockhash, { rebroadcast });
  if (st.status === 'failed' || st.status === 'expired') {
    clearLaunch(jobId);
    throw friendly(`the launch ${st.status === 'failed' ? 'failed on-chain' : 'expired before it landed'}, so no token was created. launch again from the project page, no extra charge.`);
  }
  return st.status === 'confirmed';
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
  let pending: PendingJob;
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
    track((pending = pendingJob(o, quote, txSignature(signedPay), wallet.address, payTx.message.recentBlockhash)));
    try {
      await broadcast(signedPay);
    } catch (e) {
      untrack(quote.id);
      throw e;
    }
  } else {
    // Sign-and-send-only wallets: pay now, launch with a second prompt after the payment lands.
    h.step('pay');
    const sig = await signAndSend(wallet, payTx, (b) => sendRaw(b, { preflight: true }));
    track((pending = pendingJob(o, quote, sig, wallet.address, payTx.message.recentBlockhash)));
  }
  const paySig = pending.req.payTx;
  const sp = signedPay;
  const landed = await waitForLanding(paySig, payTx.message.recentBlockhash, { rebroadcast: sp ? () => sendRaw(sp) : undefined });
  if (landed.status === 'failed' || landed.status === 'expired') {
    untrack(quote.id);
    throw friendly(landed.status === 'failed' ? 'the payment failed on-chain. nothing was charged and nothing launched.' : "the payment didn't land before it expired (network busy). nothing was charged and nothing launched. hit REA IT again.");
  }
  h.paid?.(quote.id);

  return afterPayment(quote.id, async () => {
    const setup = await register(pending, h, claimer({ chain: 'solana', wallet }, quote.id, paySig));
    if (setup) return { jobId: quote.id, launched: false, message: setup };

    h.step('launch');
    const blockhash = prepared.tx.message.recentBlockhash;
    const save = (tx: string) => saveLaunch(quote.id, { kind: 'record', mint: prepared.mint, tx, url: prepared.coinUrl, blockhash, at: Date.now() });
    let launchSig: string;
    let confirmed: boolean;
    if (signedLaunch) {
      if (!(await isBlockhashValid(blockhash).catch(() => true))) throw friendly('the launch transaction expired while the payment confirmed. launch it from your project page, no extra charge.');
      const sl = signedLaunch;
      launchSig = txSignature(sl);
      save(launchSig);
      try {
        if (prepared.submit) await prepared.submit(sl);
        else await broadcast(sl);
      } catch (e) {
        if (launchMayLand(quote.id, !!prepared.submit, e)) return { jobId: quote.id, launched: false, message: SENT_UNCONFIRMED };
        throw e;
      }
      confirmed = await landLaunch(quote.id, launchSig, blockhash, prepared.submit ? undefined : () => sendRaw(sl));
    } else {
      launchSig = await signAndSend(wallet, prepared.tx, (b) => sendRaw(b, { preflight: true }));
      save(launchSig);
      confirmed = await landLaunch(quote.id, launchSig, blockhash);
    }
    if (!confirmed) return { jobId: quote.id, launched: false, message: SENT_UNCONFIRMED };
    return recordLaunch(quote.id, { mint: prepared.mint, tx: launchSig, url: prepared.coinUrl });
  });
}

async function evmOrder(o: OrderInput, h: Hooks): Promise<OrderResult> {
  const lp = o.pad.evm!;
  const wallet = await ensureEvm(h.handoff);
  await assertPlainEvmAccount(wallet.address);
  const devBuyEth = lp.devBuy ? o.devBuy : 0;
  const quoteReq: QuoteRequest = { target: o.target.url, tier: o.tier, chain: 'robinhood' };

  h.step('quote');
  const first = await getQuote(quoteReq);
  let quote = first.quote;
  if (first.note) h.note(first.note);
  const bal = await getBalanceEth(wallet.address).catch(() => null);
  const need = Number(quote.amount) / 1e18 + devBuyEth + lp.overheadEth;
  if (bal !== null && bal < need) {
    throw friendly(`need ~${need.toFixed(4)} ETH on Robinhood Chain (${formatUsd(quote.usdCents)} engine budget + launch), wallet has ${bal.toFixed(4)} ETH. bridge some over.`);
  }

  h.step('upload');
  const logo = await uploadImage(o.image);
  h.step('build');
  // Simulated from the user's address before any money moves. The token links to the job's page.
  const build = (q: Quote) => lp.prepare({ name: o.name, ticker: o.ticker, description: tokenDescription(o.name, o.ticker), logo, website: projectUrl(q.id), devBuyEth, creator: wallet.address });
  let prepared = await build(quote);
  if (expiringSoon(quote)) {
    quote = (await getQuote(quoteReq)).quote;
    prepared = await build(quote);
  }

  h.step('pay');
  const nonce = await nextNonce(wallet.address);
  const payHash = await sendEvm(wallet, { to: quote.treasury as `0x${string}`, data: utf8Hex(payMemo(quote.id)), value: BigInt(quote.amount) });
  const pending = pendingJob(o, quote, payHash, wallet.address, undefined, nonce);
  track(pending);
  // A receipt timeout isn't a failure: the engine and the project page keep checking.
  const pr = await waitReceipt(payHash).catch(() => null);
  if (pr && pr.status !== '0x1') {
    untrack(quote.id);
    throw friendly('the payment reverted. nothing was charged and nothing launched.');
  }
  h.paid?.(quote.id);

  const claim = claimer({ chain: 'robinhood', wallet }, quote.id, payHash);
  return afterPayment(quote.id, async () => {
    // The wallet stripped our calldata: the transfer is untagged, so claim it up front.
    if (pr && (await txInput(payHash)) === '0x') {
      h.note(CLAIM_NOTE);
      pending.req.claimSig = await claim().catch(() => undefined);
      savePending(pending);
    }
    const setup = await register(pending, h, claim);
    if (setup) return { jobId: quote.id, launched: false, message: setup };

    h.step('launch');
    return recordLaunch(quote.id, await sendEvmLaunch(quote.id, o.pad, prepared, wallet, h));
  });
}

type PreparedEvm = Awaited<ReturnType<NonNullable<PadInfo['evm']>['prepare']>>;

/**
 * Sends an EVM launch and its follow-ups (StonkLauncher: approve + arm). Progress is saved after
 * every transaction, so the project page can record (or finish) whatever got through.
 */
async function sendEvmLaunch(jobId: string, pad: PadInfo, prepared: PreparedEvm, wallet: EvmConnected, h?: Hooks): Promise<TokenProof> {
  const stonk = pad.id === 'stonk';
  const hash = await sendEvm(wallet, prepared.tx);
  const guess = prepared.predicted;
  if (stonk) saveLaunch(jobId, { kind: 'stonk', createTx: hash, launchId: '', token: guess ?? '' });
  else if (guess) saveLaunch(jobId, { kind: 'record', mint: guess, tx: hash, url: prepared.coinUrl(guess) });
  const rc = await waitReceipt(hash).catch(() => {
    throw friendly("the launch was sent but hasn't confirmed yet. the project page keeps checking; check your wallet before relaunching.");
  });
  if (rc.status !== '0x1') {
    clearLaunch(jobId);
    throw friendly('the launch reverted on-chain, so no token was created. launch again from the project page, no extra charge.');
  }
  const token = prepared.tokenFrom(rc) ?? guess;
  if (!token) throw friendly('launched, but could not read the token address. check the explorer.');
  const url = prepared.coinUrl(token, rc);
  // e.g. StonkLauncher's approve + arm: the token exists but isn't tradeable until these land
  const steps = prepared.followUps?.(rc) ?? [];
  const created = stonk ? launchCreated(rc) : null;
  let unfinished: UnfinishedStonk | null = created ? { kind: 'stonk', createTx: hash, launchId: created.id.toString(), token: created.token, url } : null;
  if (unfinished) saveLaunch(jobId, unfinished);
  let last: string | undefined;
  for (const [i, f] of steps.entries()) {
    h?.note(`launch step ${i + 2} of ${steps.length + 1}: ${f.label} (confirm in your wallet)`);
    try {
      last = await sendEvm(wallet, f.tx);
      if (unfinished && i === steps.length - 1) saveLaunch(jobId, (unfinished = { ...unfinished, armTxs: [...armsOf(unfinished), last] }));
      const r = await waitReceipt(last);
      if (r.status !== '0x1') throw new Error('reverted');
    } catch (e) {
      const what = isRejection(e) ? `you skipped "${f.label}"` : `couldn't ${f.label}`;
      throw friendly(`${what}. the token exists but isn't live yet: ${unfinished ? 'hit "Finish launch" on the project page (no new token, no extra charge)' : "finish it on the launchpad's site"}.`);
    }
  }
  return { mint: token, tx: hash, url, armTx: last };
}

const UNCONFIRMED_HERE = 'sent but not confirmed yet. this page keeps checking; check your wallet before trying again.';

/** Project page: launch (or relaunch) the job's token without paying again. Must be the paying wallet. */
export async function launchForJob(job: JobView, pad: PadInfo, image: Blob, h: Hooks): Promise<void> {
  const page = projectUrl(job.id);
  const t = job.token;
  if (pad.chain === 'solana') {
    const wallet = await ensureSol(h.handoff);
    if (wallet.address !== job.payer) throw friendly(`connect the wallet that paid for this job (${short(job.payer)}).`);
    checkSolWallet(wallet, pad);
    const prepared = await pad.sol!.prepare(
      { name: t.name, ticker: t.ticker, description: tokenDescription(t.name, t.ticker), image, website: page, devBuySol: 0, creator: wallet.address },
      (s) => h.step(s === 'upload' ? 'upload' : 'build'),
      { signMessage: canSignMessage(wallet) ? (m) => signMessage(wallet, m) : undefined },
    );
    h.step('sign');
    const blockhash = prepared.tx.message.recentBlockhash;
    const save = (tx: string) => saveLaunch(job.id, { kind: 'record', mint: prepared.mint, tx, url: prepared.coinUrl, blockhash, at: Date.now() });
    let sig: string;
    let rebroadcast: (() => Promise<unknown>) | undefined;
    if (canSignOnly(wallet)) {
      let [signed] = await signMany(wallet, [prepared.tx]);
      if (messageChanged(prepared.tx, signed)) {
        if (!prepared.resign) throw friendly('your wallet changed the transaction while signing. nothing was sent.');
        signed = prepared.resign(signed);
      }
      h.step('launch');
      const s = signed;
      sig = txSignature(s);
      save(sig);
      try {
        if (prepared.submit) await prepared.submit(s);
        else await broadcast(s);
      } catch (e) {
        if (launchMayLand(job.id, !!prepared.submit, e)) throw friendly(UNCONFIRMED_HERE);
        throw e;
      }
      if (!prepared.submit) rebroadcast = () => sendRaw(s);
    } else {
      h.step('launch');
      sig = await signAndSend(wallet, prepared.tx, (b) => sendRaw(b, { preflight: true }));
      save(sig);
    }
    if (!(await landLaunch(job.id, sig, blockhash, rebroadcast))) throw friendly(UNCONFIRMED_HERE);
    await tryRecord(job.id, { mint: prepared.mint, tx: sig, url: prepared.coinUrl });
    return;
  }
  const wallet = await ensureEvm(h.handoff);
  if (wallet.address !== job.payer.toLowerCase()) throw friendly(`connect the wallet that paid for this job (${short(job.payer)}).`);
  h.step('upload');
  const logo = await uploadImage(image);
  h.step('build');
  const prepared = await pad.evm!.prepare({ name: t.name, ticker: t.ticker, description: tokenDescription(t.name, t.ticker), logo, website: page, devBuyEth: 0, creator: wallet.address });
  h.step('launch');
  await tryRecord(job.id, await sendEvmLaunch(job.id, pad, prepared, wallet, h));
}

async function receiptOk(hash: string): Promise<boolean> {
  const r = await evmRpc<EvmReceipt | null>('eth_getTransactionReceipt', [hash]).catch(() => null);
  return r?.status === '0x1';
}

/** The first of these txs whose receipt says it succeeded. */
async function firstOk(hashes: string[]): Promise<string | undefined> {
  for (const h of hashes) if (await receiptOk(h)) return h;
  return undefined;
}

/**
 * Reads the create receipt of a StonkLauncher launch saved before it was read. A create no RPC knows
 * any more (dropped, or replaced in the wallet) never made a token: the saved entry goes, so the page
 * offers a fresh launch.
 */
async function readCreate(jobId: string, s: UnfinishedStonk): Promise<EvmReceipt> {
  const rc = await waitReceipt(s.createTx, 20_000).catch(() => null);
  if (rc) return rc;
  const state = await txState(s.createTx);
  if (state === 'gone') {
    clearLaunch(jobId);
    throw friendly("that create transaction never confirmed and the chain doesn't know it (dropped, or replaced in your wallet), so no token exists. launch a new one, no extra charge.");
  }
  if (state === 'mined') throw friendly("that create transaction is mined but its receipt isn't readable yet. hit Finish launch again in a minute.");
  throw friendly("that create transaction isn't confirmed yet. check it on the explorer: if it never lands, launch a new one instead (no extra charge).");
}

/** Project page: approve + arm a StonkLauncher launch whose createLaunch is mined, then record it. No new token. */
export async function finishStonkLaunch(job: JobView, saved: UnfinishedStonk, h: Hooks): Promise<void> {
  const wallet = await ensureEvm(h.handoff);
  if (wallet.address !== job.payer.toLowerCase()) throw friendly(`connect the wallet that paid for this job (${short(job.payer)}).`);
  h.step('launch');
  let s = saved;
  if (!s.launchId) {
    const rc = await readCreate(job.id, s);
    if (rc.status !== '0x1') {
      clearLaunch(job.id);
      throw friendly('that create transaction reverted, so no token exists. launch a fresh one, no extra charge.');
    }
    const c = launchCreated(rc);
    if (!c) throw friendly(`couldn't read the launch from tx ${s.createTx}. contact support with it.`);
    saveLaunch(job.id, (s = { ...s, launchId: c.id.toString(), token: c.token, url: stonkCoinUrl(job.token.ticker, c.id) }));
  }
  // Every arm sent so far stays saved until one is known to have landed: a pending or flaky-RPC arm
  // that gets re-sent makes the second one revert ("already armed"), and only the first proves it.
  let armTx = await firstOk(armsOf(s));
  if (!armTx) {
    const steps = await stonkRemainingSteps(BigInt(s.launchId), s.token, wallet.address);
    if (!steps.length) {
      // The supply already left the wallet: one of the saved arms landed, its receipt just isn't readable yet.
      if (!armsOf(s).length) throw friendly(`this launch already looks armed, but we don't have its arm tx. contact support with the create tx ${s.createTx}.`);
      throw friendly("the launch looks armed but its arm tx isn't readable yet. give it a minute and hit Finish launch again (nothing new to sign).");
    }
    for (const [i, f] of steps.entries()) {
      h.note(`step ${i + 1} of ${steps.length}: ${f.label} (confirm in your wallet)`);
      const tx = await sendEvm(wallet, f.tx);
      const arm = i === steps.length - 1;
      if (arm) saveLaunch(job.id, (s = { ...s, armTxs: [...armsOf(s), tx] }));
      const ok = (await waitReceipt(tx)).status === '0x1';
      if (ok && arm) armTx = tx;
      // A re-sent arm reverts when an earlier one landed meanwhile: that earlier one is the proof.
      if (!ok && arm) armTx = await firstOk(armsOf(s));
      if (!ok && !armTx) throw friendly(`couldn't ${f.label}. no new token was created; hit Finish launch to try again.`);
    }
  }
  await tryRecord(job.id, { mint: s.token, tx: s.createTx, url: s.url, armTx });
}

/**
 * Hands a paid top-up to the engine. Clears the saved entry once credited. When the engine wants a
 * claim signature or refuses it, the entry stays (marked) and the error says the payment is safe.
 */
export async function creditTopup(t: PendingTopup, opts: { onWait?: (m: string) => void; claim?: () => Promise<string>; timeoutMs?: number } = {}): Promise<JobView> {
  const send = () => topupJob(t.jobId, t, opts.onWait, opts.timeoutMs);
  let claiming = false;
  try {
    let view: JobView;
    try {
      view = await send();
    } catch (e) {
      if (!needsClaim(e) || !opts.claim) throw e;
      opts.onWait?.(CLAIM_NOTE);
      claiming = true;
      t.claimSig = await opts.claim();
      claiming = false;
      saveTopup(t);
      view = await send();
    }
    clearTopup(t.quote.id);
    return view;
  } catch (e) {
    if (claiming || needsClaim(e)) {
      saveTopup({ ...t, needsClaim: true });
      throw friendly(claimFailure(e, `${PAID}, but your wallet dropped its rea4u tag. sign the free claim message on this page so the engine can credit it.`));
    }
    const gone = await goneAfter(e, t.quote.chain, t.payTx, { blockhash: t.blockhash, at: sentAt(t), from: t.payer, nonce: t.nonce });
    if (gone === 'replaced') {
      saveTopup({ ...t, replaced: true });
      throw friendly(goneMessage('top-up', gone));
    }
    if (gone) {
      clearTopup(t.quote.id);
      throw notCharged(goneMessage('top-up', gone));
    }
    if (refused(e)) {
      saveTopup({ ...t, rejected: e.message });
      throw friendly(`${PAID} (tx ${t.payTx}) but the engine refused the top-up: ${e.message}. don't pay again: contact support with this tx.`);
    }
    if ((e as { friendly?: boolean })?.friendly) throw friendly(withPaid((e as Error).message));
    throw friendly(`${PAID}. the engine hasn't credited the top-up yet; this page keeps retrying. don't pay again.`);
  }
}

/** Project page: pay more to raise a paused job's budget. Anyone can top up a job. */
export async function topUp(job: JobView, usdCents: number, h: Hooks): Promise<JobView> {
  const p: PayingWallet = job.chain === 'solana' ? { chain: 'solana', wallet: await ensureSol(h.handoff) } : { chain: 'robinhood', wallet: await ensureEvm(h.handoff) };
  const quoteReq: QuoteRequest = { target: job.target.url, tier: job.tier, chain: job.chain, topup: job.id, usdCents };
  h.step('quote');
  let { quote } = await getQuote(quoteReq);
  const save = (payTx: string, blockhash?: string, nonce?: number): PendingTopup => {
    const t: PendingTopup = { jobId: job.id, quote, payTx, payer: p.wallet.address, ...(blockhash ? { blockhash } : {}), ...(nonce !== undefined ? { nonce } : {}), at: Date.now() };
    saveTopup(t);
    return t;
  };
  let entry: PendingTopup;
  if (p.chain === 'solana') {
    const payTx = await buildSolPayment(quote, p.wallet.address);
    h.step('pay');
    let rebroadcast: (() => Promise<unknown>) | undefined;
    if (canSignOnly(p.wallet)) {
      const [signed] = await signMany(p.wallet, [payTx]);
      entry = save(txSignature(signed), payTx.message.recentBlockhash);
      try {
        await broadcast(signed);
      } catch (e) {
        clearTopup(quote.id);
        throw e;
      }
      rebroadcast = () => sendRaw(signed);
    } else {
      entry = save(await signAndSend(p.wallet, payTx, (b) => sendRaw(b, { preflight: true })), payTx.message.recentBlockhash);
    }
    const st = await waitForLanding(entry.payTx, payTx.message.recentBlockhash, { rebroadcast });
    if (st.status === 'failed' || st.status === 'expired') {
      clearTopup(quote.id);
      throw friendly(`the top-up ${st.status === 'failed' ? 'failed' : 'expired'}. nothing was charged.`);
    }
  } else {
    await assertPlainEvmAccount(p.wallet.address);
    if (expiringSoon(quote)) quote = (await getQuote(quoteReq)).quote;
    h.step('pay');
    const nonce = await nextNonce(p.wallet.address);
    entry = save(await sendEvm(p.wallet, { to: quote.treasury as `0x${string}`, data: utf8Hex(payMemo(quote.id)), value: BigInt(quote.amount) }), undefined, nonce);
    const r = await waitReceipt(entry.payTx).catch(() => null);
    if (r && r.status !== '0x1') {
      clearTopup(quote.id);
      throw friendly('the top-up reverted. nothing was charged.');
    }
  }
  h.step('start');
  const claim = claimer(p, quote.id, entry.payTx);
  if (p.chain === 'robinhood' && (await txInput(entry.payTx)) === '0x') {
    h.note(CLAIM_NOTE);
    entry.claimSig = await claim().catch(() => undefined);
    saveTopup(entry);
  }
  return creditTopup(entry, { onWait: () => h.note(`${PAID}, waiting for confirmation...`), claim });
}
