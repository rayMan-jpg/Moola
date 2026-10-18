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
const SIGN_MESSAGE = 'solana:signMessage';
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

// ── legacy injected providers (wallets that never adopted Wallet Standard) ──
interface LegacyKey {
  toBase58(): string;
  toBytes(): Uint8Array;
}
interface LegacyProvider {
  publicKey?: LegacyKey | null;
  isPhantom?: boolean;
  isSolflare?: boolean;
  isBackpack?: boolean;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: LegacyKey } | void>;
  disconnect?(): Promise<void>;
  signTransaction?(tx: VersionedTransaction): Promise<VersionedTransaction>;
  signMessage?(message: Uint8Array, display?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
}

const LEGACY_SOURCES: [string, () => LegacyProvider | undefined][] = [
  ['Trust Wallet', () => (window as unknown as { trustwallet?: { solana?: LegacyProvider } }).trustwallet?.solana],
  ['Coinbase Wallet', () => (window as unknown as { coinbaseSolana?: LegacyProvider }).coinbaseSolana],
  ['Exodus', () => (window as unknown as { exodus?: { solana?: LegacyProvider } }).exodus?.solana],
  ['Solana wallet', () => (window as unknown as { solana?: LegacyProvider }).solana],
];
const LEGACY_ICON =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzlkNGRmZiIvPjx0ZXh0IHg9IjE2IiB5PSIyMiIgZm9udC1zaXplPSIxNiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZmlsbD0iI2ZmZiI+JDwvdGV4dD48L3N2Zz4=';
const legacyCache = new Map<LegacyProvider, Wallet>();

/** Wraps a legacy window provider in the Wallet Standard shape the rest of the app uses. */
function legacyWallet(name: string, p: LegacyProvider): Wallet {
  const cached = legacyCache.get(p);
  if (cached) return cached;
  let accounts: WalletAccount[] = [];
  const features: Record<string, unknown> = {
    [CONNECT]: {
      version: '1.0.0',
      connect: async (input?: { silent?: boolean }) => {
        const r = await p.connect(input?.silent ? { onlyIfTrusted: true } : undefined);
        const pk = (r && r.publicKey) || p.publicKey;
        if (!pk) throw new Error(`${name} did not share an account`);
        accounts = [{ address: pk.toBase58(), publicKey: pk.toBytes(), chains: [CHAIN], features: [] }];
        return { accounts };
      },
    },
    [DISCONNECT]: { version: '1.0.0', disconnect: async () => p.disconnect?.() },
  };
  if (p.signTransaction) {
    features[SIGN] = {
      version: '1.0.0',
      supportedTransactionVersions: ['legacy', 0],
      signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
        const signed = await p.signTransaction!(VersionedTransaction.deserialize(inputs[0].transaction));
        return [{ signedTransaction: signed.serialize() }];
      },
    };
  }
  if (p.signMessage) {
    features[SIGN_MESSAGE] = {
      version: '1.0.0',
      signMessage: async (...inputs: { message: Uint8Array }[]) => {
        const r = await p.signMessage!(inputs[0].message, 'utf8');
        return [{ signedMessage: inputs[0].message, signature: r instanceof Uint8Array ? r : r.signature }];
      },
    };
  }
  const w = {
    version: '1.0.0' as const,
    name,
    icon: LEGACY_ICON as Wallet['icon'],
    chains: [CHAIN] as Wallet['chains'],
    get accounts() {
      return accounts;
    },
    features: features as Wallet['features'],
  };
  legacyCache.set(p, w);
  return w;
}

export function listWallets(): Wallet[] {
  const standard = getWallets().get().filter(isSolanaWallet);
  const seen = new Set<LegacyProvider>();
  const legacy: Wallet[] = [];
  for (const [name, get] of LEGACY_SOURCES) {
    let p: LegacyProvider | undefined;
    try {
      p = get();
    } catch {
      continue;
    }
    // Phantom, Solflare and Backpack register through Wallet Standard; their window objects are duplicates.
    if (!p || typeof p.connect !== 'function' || seen.has(p) || p.isPhantom || p.isSolflare || p.isBackpack) continue;
    seen.add(p);
    if (standard.some((w) => w.name.toLowerCase().includes(name.split(' ')[0].toLowerCase()))) continue;
    legacy.push(legacyWallet(name, p));
  }
  return [...standard, ...legacy];
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

const EVENTS = 'standard:events';

/** Notifies when the wallet's authorized accounts change (account switch, site disconnected). */
export function onAccountsChanged(c: Connected, cb: (accounts: readonly WalletAccount[]) => void): () => void {
  type On = (event: 'change', listener: (p: { accounts?: readonly WalletAccount[] }) => void) => () => void;
  const feature = (c.wallet.features as Feature<{ on?: On }>)[EVENTS];
  if (!feature?.on) return () => {};
  return feature.on('change', (p) => {
    if (p.accounts) cb(p.accounts);
  });
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

export function canSignMessage(c: Connected): boolean {
  return SIGN_MESSAGE in (c.wallet.features as Feature);
}

export async function signMessage(c: Connected, message: Uint8Array): Promise<Uint8Array> {
  const feature = (c.wallet.features as Feature)[SIGN_MESSAGE] as
    | { signMessage: (...inputs: unknown[]) => Promise<readonly { signature: Uint8Array; signedMessage?: Uint8Array }[]> }
    | undefined;
  if (!feature) throw new Error(`${c.wallet.name} cannot sign messages. Use Phantom, Solflare or Backpack for this launchpad.`);
  const [out] = await feature.signMessage({ account: c.account, message });
  // Wallets may sign a prefixed/wrapped message (e.g. Ledger off-chain format); APIs that verify the raw
  // bytes would then reject it, so stop here with a clear message.
  const sm = out.signedMessage;
  if (sm && (sm.length !== message.length || sm.some((b, i) => b !== message[i]))) {
    throw Object.assign(new Error(`${c.wallet.name} signed a modified message (hardware wallet?). use a hot wallet for this launchpad.`), { friendly: true });
  }
  return out.signature;
}

export function canSignOnly(c: Connected): boolean {
  return SIGN in (c.wallet.features as Feature);
}

/** First signature of a serialized transaction (the fee payer's), base58. That is the tx id. */
export function txSignature(signed: Uint8Array): string {
  return bs58.encode(VersionedTransaction.deserialize(signed).signatures[0]);
}

export function isMobile(ua = navigator.userAgent): boolean {
  // iPadOS reports a desktop Safari UA; touch points give it away.
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export const INSTALL_LINKS = [
  { name: 'Phantom', url: 'https://phantom.com/download' },
  { name: 'Solflare', url: 'https://solflare.com/download/' },
  { name: 'Backpack', url: 'https://backpack.app/downloads' },
];

/** Deeplinks that reopen this page inside a wallet's in-app browser (where the wallet is injected). */
export function walletDeeplinks(pageUrl: string): { name: string; url: string }[] {
  const u = encodeURIComponent(pageUrl);
  const ref = encodeURIComponent(new URL(pageUrl).origin);
  return [
    { name: 'Phantom', url: `https://phantom.com/ul/browse/${u}?ref=${ref}` },
    { name: 'Solflare', url: `https://solflare.com/ul/v1/browse/${u}?ref=${ref}` },
    { name: 'Backpack', url: `https://backpack.app/ul/v1/browse/${u}?ref=${ref}` },
  ];
}

export function shortAddr(a: string): string {
  return a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}
