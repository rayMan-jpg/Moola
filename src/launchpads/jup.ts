// Jupiter Studio (Meteora Dynamic Bonding Curve) through Jupiter's public Studio API, keyless.
// The API wants a wallet-signed auth message, builds a transaction it has already signed for the
// vanity mint, the curve config and its co-signer, and broadcasts the user-signed result itself
// (submitting is also what publishes the logo + metadata). So: 2 wallet prompts, no dev buy.
import { VersionedTransaction } from '@solana/web3.js';
import type { Launchpad, LaunchInput, PreparedLaunch, PrepareContext, StepId } from './types';
import { fitImage } from '../metadata';
import { simulateTx, simError, toBase64 } from '../rpc';
import { txSignature } from '../wallet';
import { guardTx, PROGRAMS } from './guard';

export const STUDIO_API = 'https://api.jup.ag/studio/v1';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const RESERVED_TICKERS = new Set(['JUP', 'JUPSOL', 'JLP', 'SOL', 'USDC', 'USDT', 'WBTC', 'WETH', 'BTC', 'ETH']);
const LOGO_MAX = 2 * 1024 * 1024;

/** studio.jup.ag's "Meme" preset: 5K -> 75K USDC market cap, no vesting, 1% fee, LP locked. */
export function createTxBody(input: { creator: string; name: string; ticker: string; website?: string; twitter?: string; telegram?: string }, logoType: string, auth: { message: string; signature: string; timestamp: number; nonce: string }) {
  return {
    buildCurveByMarketCapParam: {
      quoteMint: USDC,
      initialMarketCap: 5000,
      migrationMarketCap: 75000,
      tokenQuoteDecimal: 6,
      lockedVestingParam: { totalLockedVestingAmount: 0, cliffUnlockAmount: 0, numberOfVestingPeriod: 0, totalVestingDuration: 0, cliffDurationFromMigrationTime: 0 },
    },
    antiSniping: false,
    fee: { feeBps: 100 },
    isLpLocked: true,
    tokenName: input.name,
    tokenSymbol: input.ticker,
    tokenImageContentType: logoType,
    creator: input.creator,
    website: input.website ?? '',
    twitter: input.twitter ?? '',
    telegram: input.telegram ?? '',
    wallet: input.creator,
    message: auth.message,
    signature: auth.signature,
    timestamp: auth.timestamp,
    nonce: auth.nonce,
    type: 'msg',
  };
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** The user must be the fee payer and the only missing signature; everything else comes pre-signed. */
export function assertStudioTx(tx: VersionedTransaction, creator: string, mint: string): void {
  const m = tx.message;
  const signers = m.staticAccountKeys.slice(0, m.header.numRequiredSignatures).map((k) => k.toBase58());
  if (signers[0] !== creator) throw new Error('Jupiter returned a transaction with a different fee payer. Aborting.');
  if (!signers.includes(mint)) throw new Error('Jupiter returned a transaction that does not create the promised mint. Aborting.');
  signers.forEach((s, i) => {
    if (i > 0 && !tx.signatures[i].some((b) => b !== 0)) throw new Error(`Jupiter left signer ${s} unsigned. Aborting.`);
  });
}

async function jupJson(res: Response): Promise<Record<string, unknown>> {
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || j.success === false) {
    const msg = (j.error as string) || (j.message as string) || JSON.stringify(j.errors ?? j);
    throw new Error(`Jupiter Studio ${res.status}: ${String(msg).slice(0, 200)}`);
  }
  return j;
}

export const jup: Launchpad = {
  id: 'jup',
  name: 'Jupiter Studio',
  tagline: 'jup.ag curve, USDC pair',
  costHint: '~0.028 SOL rent, no launch fee, 2 wallet prompts',
  signatures: 2,
  devBuy: false,
  overheadSol: 0.03,
  stepLabels: {
    upload: 'Prove it is your wallet (prompt 1 of 2)',
    build: 'Jupiter cooks the transaction',
    sign: 'Sign the launch (prompt 2 of 2)',
    confirm: 'Jupiter is sending it to the chain',
  },
  async prepare(input: LaunchInput, onStep: (s: StepId) => void, ctx: PrepareContext = {}): Promise<PreparedLaunch> {
    const fetchImpl = ctx.fetchImpl ?? fetch;
    if (RESERVED_TICKERS.has(input.ticker)) throw Object.assign(new Error(`$${input.ticker} is reserved on Jupiter. pick another ticker.`), { friendly: true });
    if (!ctx.signMessage) throw new Error('Jupiter Studio needs a wallet that can sign messages (Phantom, Solflare, Backpack).');
    const logo = await fitImage(input.image, LOGO_MAX, false);

    onStep('upload');
    const timestamp = Date.now();
    const nonce = crypto.randomUUID();
    const message = `${timestamp}:${nonce}`;
    const signature = toBase64(await ctx.signMessage(new TextEncoder().encode(message)));

    onStep('build');
    const res = await jupJson(
      await fetchImpl(`${STUDIO_API}/dbc-pool/create-tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(createTxBody(input, logo.type, { message, signature, timestamp, nonce })),
      }),
    );
    const mint = String(res.mint ?? '');
    const tx = VersionedTransaction.deserialize(fromBase64(String(res.transaction ?? '')));
    assertStudioTx(tx, input.creator, mint);
    guardTx(tx, { creator: input.creator, allow: [PROGRAMS.dbc, PROGRAMS.jupStudio] });
    const sim = await simulateTx(tx.serialize()).catch(() => null);
    const err = sim && simError(sim);
    if (err) throw err;

    return {
      mint,
      tx,
      coinUrl: `https://jup.ag/tokens/${mint}`,
      via: 'jup-studio',
      async submit(signed: Uint8Array) {
        const form = new FormData();
        form.append('transaction', toBase64(signed));
        form.append('owner', input.creator);
        if (input.description) form.append('content', input.description);
        form.append('headerImage', new Blob([logo.bytes as BlobPart], { type: logo.type }), `logo.${logo.type.split('/')[1]}`);
        await jupJson(await fetchImpl(`${STUDIO_API}/dbc-pool/submit`, { method: 'POST', body: form }));
        return txSignature(signed);
      },
    };
  },
};
