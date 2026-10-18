// Wallet layer: Wallet Standard discovery (Phantom, Solflare, Backpack, ...) plus
// mobile deeplinks for browsers that have no wallet injected.
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

const CONNECT = 'standard:connect';
const DISCONNECT = 'standard:disconnect';
const SIGN_AND_SEND = 'solana:signAndSendTransaction';
const SIGN = 'solana:signTransaction';
export const CHAIN = 'solana:mainnet';

export interface Connected {
  wallet: Wallet;
  account: WalletAccount;
  address: string;
}

type Feature<T = unknown> = Record<string, T>;

export function isSolanaWallet(w: Wallet): boolean {
  const f = w.features as Feature;
  return (
    w.chains.some((c) => c.startsWith('solana:')) &&
    CONNECT in f &&
    (SIGN_AND_SEND in f || SIGN in f)
  );
}

export function listWallets(): Wallet[] {
  return getWallets().get().filter(isSolanaWallet);
}

export function onWalletsChanged(cb: () => void): () => void {
  const api = getWallets();
  const offA = api.on('register', cb);
  const offB = api.on('unregister', cb);
  return () => {
    offA();
    offB();
  };
}

export async function connect(wallet: Wallet, silent = false): Promise<Connected> {
  const feature = (wallet.features as Feature<{ connect: (i?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }> }>)[CONNECT];
  const { accounts } = await feature.connect(silent ? { silent: true } : undefined);
  const account = accounts.find((a) => a.chains.some((c) => c.startsWith('solana:'))) ?? accounts[0];
  if (!account) throw new Error('Wallet returned no accounts. Unlock it and try again.');
  return { wallet, account, address: account.address };
}

export async function disconnect(c: Connected | null): Promise<void> {
  if (!c) return;
  const feature = (c.wallet.features as Feature<{ disconnect?: () => Promise<void> }>)[DISCONNECT];
  try {
    await feature?.disconnect?.();
  } catch {
    /* some wallets throw if already disconnected */
  }
}

/**
 * Ask the wallet to sign (and, when supported, broadcast) a transaction that may already carry
 * other signatures (e.g. the fresh mint keypair). Returns the base58 signature.
 * `send` is used only when the wallet can sign but not broadcast.
 */
export async function signAndSend(
  c: Connected,
  tx: VersionedTransaction,
  send: (signed: Uint8Array) => Promise<string>,
): Promise<string> {
  const f = c.wallet.features as Feature;
  const bytes = tx.serialize();
  if (SIGN_AND_SEND in f) {
    const feature = f[SIGN_AND_SEND] as {
      signAndSendTransaction: (...inputs: unknown[]) => Promise<readonly { signature: Uint8Array }[]>;
    };
    const [out] = await feature.signAndSendTransaction({
      account: c.account,
      chain: CHAIN,
      transaction: bytes,
      options: { preflightCommitment: 'confirmed', maxRetries: 5 },
    });
    return bs58.encode(out.signature);
  }
  const feature = f[SIGN] as {
    signTransaction: (...inputs: unknown[]) => Promise<readonly { signedTransaction: Uint8Array }[]>;
  };
  const [out] = await feature.signTransaction({ account: c.account, chain: CHAIN, transaction: bytes });
  return send(out.signedTransaction);
}

/** Wallet signs only; the caller broadcasts (used when a launchpad API wants the signed tx). */
export async function signOnly(c: Connected, tx: VersionedTransaction): Promise<Uint8Array> {
  const f = c.wallet.features as Feature;
  if (!(SIGN in f)) throw new Error(`${c.wallet.name} cannot sign without sending. Try Phantom, Solflare or Backpack.`);
  const feature = f[SIGN] as {
    signTransaction: (...inputs: unknown[]) => Promise<readonly { signedTransaction: Uint8Array }[]>;
  };
  const [out] = await feature.signTransaction({ account: c.account, chain: CHAIN, transaction: tx.serialize() });
  return out.signedTransaction;
}

export function canSignOnly(c: Connected): boolean {
  return SIGN in (c.wallet.features as Feature);
}

/** First signature of a serialized transaction (the fee payer's), base58. That is the tx id. */
export function txSignature(signed: Uint8Array): string {
  return bs58.encode(VersionedTransaction.deserialize(signed).signatures[0]);
}

export function isMobile(ua = navigator.userAgent): boolean {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
}

/** Deeplinks that reopen this page inside a wallet's in-app browser (where the wallet is injected). */
export function walletDeeplinks(pageUrl: string): { name: string; url: string }[] {
  const u = encodeURIComponent(pageUrl);
  const ref = encodeURIComponent(new URL(pageUrl).origin);
  return [
    { name: 'Phantom', url: `https://phantom.app/ul/browse/${u}?ref=${ref}` },
    { name: 'Solflare', url: `https://solflare.com/ul/v1/browse/${u}?ref=${ref}` },
    { name: 'Backpack', url: `https://backpack.app/ul/v1/browse/${u}?ref=${ref}` },
  ];
}

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
