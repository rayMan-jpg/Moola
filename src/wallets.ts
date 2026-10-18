// App-level wallet state for both chains: a Solana wallet (Wallet Standard) for pump.fun,
// Jupiter Studio and Bonk.fun, and an EVM wallet (EIP-6963) for Robinhood Chain launchpads.

import type { Wallet } from '@wallet-standard/base';
import { connectEvm, discoverEvmWallets, evmDeeplinks, getBalanceEth, type EvmConnected, type EvmWalletInfo } from './evm/chain';
import { getBalanceSol } from './rpc';
import { $, esc, hideModal, openModal, toast } from './ui';
import { connect, disconnect, INSTALL_LINKS, isMobile, listWallets, onAccountsChanged, onWalletsChanged, shortAddr, walletDeeplinks, type Connected } from './wallet';

export const wallets = { sol: null as Connected | null, evm: null as EvmConnected | null };

const listeners = new Set<() => void>();
export function onWalletChange(cb: () => void) {
  listeners.add(cb);
}
function changed() {
  for (const cb of listeners) cb();
}

const LAST_SOL = 'rea4u.wallet.sol';
const LAST_EVM = 'rea4u.wallet.evm';
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k) ?? '';
    } catch {
      return '';
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

const icon = (src?: string) => (src && /^data:image\/|^https:\/\//.test(src) ? `<img src="${esc(src)}" alt="" />` : '');

// ── Solana ──
let stopSolWatch = () => {};

async function doConnectSol(w: Wallet, silent = false): Promise<Connected> {
  const c = await connect(w, silent);
  wallets.sol = c;
  stopSolWatch();
  stopSolWatch = onAccountsChanged(c, (accounts) => {
    if (!wallets.sol || wallets.sol.wallet !== w) return;
    const sol = accounts.filter((a) => a.chains.some((ch) => ch.startsWith('solana:')));
    if (!sol.length) {
      wallets.sol = null;
      toast('wallet disconnected');
    } else if (!sol.some((a) => a.address === wallets.sol!.address)) {
      wallets.sol = { wallet: w, account: sol[0], address: sol[0].address };
      toast(`switched to ${shortAddr(sol[0].address)}`);
    }
    changed();
  });
  store.set(LAST_SOL, w.name);
  changed();
  return c;
}

let pendingSol: { resolve: (c: Connected) => void; reject: (e: Error) => void } | null = null;

function solPicker(handoff: () => string) {
  const list = listWallets();
  const cancel = () => {
    pendingSol?.reject(new Error('cancelled'));
    pendingSol = null;
  };
  if (list.length) {
    openModal(
      'PICK YOUR SOLANA WALLET',
      `<div class="wallets">${list.map((w, i) => `<button class="wallet-btn" type="button" data-wallet="${i}">${icon(w.icon)}${esc(w.name)}</button>`).join('')}</div>`,
      cancel,
    );
    $('modal-content')
      .querySelectorAll<HTMLElement>('[data-wallet]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          const p = pendingSol;
          pendingSol = null;
          hideModal();
          try {
            p?.resolve(await doConnectSol(list[Number(b.dataset.wallet)]));
          } catch (e) {
            p?.reject(e as Error);
          }
        }),
      );
    return;
  }
  const phone = `<div class="wallets">${walletDeeplinks(handoff())
    .map((l) => `<a class="wallet-btn" href="${esc(l.url)}">Open in ${esc(l.name)}</a>`)
    .join('')}</div><p class="art__hint">your order comes along (re-upload a custom logo there).</p>`;
  openModal(
    'NO SOLANA WALLET',
    isMobile()
      ? `<p>Open rea4u inside your wallet app, then hit REA IT again:</p>${phone}`
      : `<p>Install a Solana wallet extension, refresh, and hit REA IT again:</p>
         <div class="wallets">${INSTALL_LINKS.map((l) => `<a class="wallet-btn" href="${esc(l.url)}" target="_blank" rel="noopener">Get ${esc(l.name)}</a>`).join('')}</div>
         <h3 class="field__label" style="margin-top:16px">On your phone?</h3>${phone}`,
    cancel,
  );
}

export function ensureSol(handoff: () => string): Promise<Connected> {
  if (wallets.sol) return Promise.resolve(wallets.sol);
  const list = listWallets();
  if (list.length === 1) return doConnectSol(list[0]);
  return new Promise<Connected>((resolve, reject) => {
    pendingSol = { resolve, reject };
    solPicker(handoff);
  });
}

onWalletsChanged(() => {
  if (pendingSol) solPicker(() => location.href);
});

// ── EVM (Robinhood Chain) ──
let stopEvmWatch = () => {};

async function doConnectEvm(info: EvmWalletInfo): Promise<EvmConnected> {
  const c = await connectEvm(info);
  wallets.evm = c;
  stopEvmWatch();
  const onAccounts = (...a: unknown[]) => {
    const accounts = (a[0] as string[]) ?? [];
    if (!wallets.evm || wallets.evm.info !== info) return;
    if (!accounts.length) {
      wallets.evm = null;
      toast('wallet disconnected');
    } else if (accounts[0].toLowerCase() !== wallets.evm.address) {
      wallets.evm = { info, address: accounts[0].toLowerCase() as EvmConnected['address'] };
      toast(`switched to ${shortAddr(accounts[0])}`);
    }
    changed();
  };
  info.provider.on?.('accountsChanged', onAccounts);
  stopEvmWatch = () => info.provider.removeListener?.('accountsChanged', onAccounts);
  store.set(LAST_EVM, info.rdns || info.name);
  changed();
  return c;
}

export async function ensureEvm(handoff: () => string): Promise<EvmConnected> {
  if (wallets.evm) return wallets.evm;
  const list = await discoverEvmWallets();
  if (list.length === 1) return doConnectEvm(list[0]);
  return new Promise<EvmConnected>((resolve, reject) => {
    const cancel = () => reject(new Error('cancelled'));
    if (!list.length) {
      const links = `<div class="wallets">${evmDeeplinks(handoff())
        .map((l) => `<a class="wallet-btn" href="${esc(l.url)}">Open in ${esc(l.name)}</a>`)
        .join('')}</div>`;
      openModal(
        'NO EVM WALLET',
        isMobile()
          ? `<p>Robinhood Chain launches need an EVM wallet. Open rea4u inside one:</p>${links}<p class="art__hint">Robinhood Wallet: open it, tap the Web3 globe, paste this page's link.</p>`
          : `<p>Robinhood Chain launches need an EVM wallet (MetaMask, Rabby, Phantom, Coinbase Wallet...). Install one, refresh, and hit REA IT again.</p>
             <div class="wallets"><a class="wallet-btn" href="https://metamask.io/download/" target="_blank" rel="noopener">Get MetaMask</a><a class="wallet-btn" href="https://rabby.io/" target="_blank" rel="noopener">Get Rabby</a></div>
             <h3 class="field__label" style="margin-top:16px">On your phone?</h3>${links}`,
        cancel,
      );
      return;
    }
    openModal(
      'PICK YOUR EVM WALLET',
      `<div class="wallets">${list.map((w, i) => `<button class="wallet-btn" type="button" data-evm="${i}">${icon(w.icon)}${esc(w.name)}</button>`).join('')}</div>
       <p class="art__hint">We'll switch it to Robinhood Chain (adds the network if needed).</p>`,
      cancel,
    );
    $('modal-content')
      .querySelectorAll<HTMLElement>('[data-evm]')
      .forEach((b) =>
        b.addEventListener('click', async () => {
          hideModal();
          try {
            resolve(await doConnectEvm(list[Number(b.dataset.evm)]));
          } catch (e) {
            reject(e as Error);
          }
        }),
      );
  });
}

export async function forget(kind: 'sol' | 'evm') {
  if (kind === 'sol') {
    await disconnect(wallets.sol);
    stopSolWatch();
    wallets.sol = null;
    store.set(LAST_SOL, null);
  } else {
    stopEvmWatch();
    wallets.evm = null;
    store.set(LAST_EVM, null);
  }
  changed();
}

export async function balanceText(): Promise<string> {
  const parts: string[] = [];
  if (wallets.sol) parts.push(await getBalanceSol(wallets.sol.address).then((b) => `${b.toFixed(3)} SOL`).catch(() => ''));
  if (wallets.evm) parts.push(await getBalanceEth(wallets.evm.address).then((b) => `${b.toFixed(4)} ETH`).catch(() => ''));
  return parts.filter(Boolean).join(' · ');
}

/** Reconnects silently to wallets this browser used before; never pops a prompt on load. */
export async function silentReconnect() {
  const lastSol = store.get(LAST_SOL);
  const w = lastSol && listWallets().find((x) => x.name === lastSol);
  if (w) await doConnectSol(w, true).catch(() => undefined);
  const lastEvm = store.get(LAST_EVM);
  if (lastEvm) {
    const list = await discoverEvmWallets();
    const info = list.find((x) => (x.rdns || x.name) === lastEvm);
    if (info) {
      const accounts = (await info.provider.request({ method: 'eth_accounts' }).catch(() => [])) as string[];
      if (accounts?.[0]) {
        wallets.evm = { info, address: accounts[0].toLowerCase() as EvmConnected['address'] };
        changed();
      }
    }
  }
}

export function walletMenu() {
  const rows: string[] = [];
  if (wallets.sol) rows.push(`<p class="mono" style="word-break:break-all">Solana: ${esc(wallets.sol.address)}</p><div class="wallets"><button class="wallet-btn" type="button" data-copy-addr="${esc(wallets.sol.address)}">Copy Solana address</button><button class="wallet-btn" type="button" data-off="sol">Disconnect ${esc(wallets.sol.wallet.name)}</button></div>`);
  if (wallets.evm) rows.push(`<p class="mono" style="word-break:break-all">Robinhood Chain: ${esc(wallets.evm.address)}</p><div class="wallets"><button class="wallet-btn" type="button" data-copy-addr="${esc(wallets.evm.address)}">Copy EVM address</button><button class="wallet-btn" type="button" data-off="evm">Disconnect ${esc(wallets.evm.info.name)}</button></div>`);
  openModal('YOUR WALLETS', rows.join('<hr />') || '<p>No wallet connected. Hit REA IT and we connect the right one for your launchpad.</p>');
  $('modal-content')
    .querySelectorAll<HTMLElement>('[data-copy-addr]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        navigator.clipboard?.writeText(b.dataset.copyAddr!).then(() => toast('address copied'));
        hideModal();
      }),
    );
  $('modal-content')
    .querySelectorAll<HTMLElement>('[data-off]')
    .forEach((b) =>
      b.addEventListener('click', async () => {
        hideModal();
        await forget(b.dataset.off as 'sol' | 'evm');
        toast('disconnected');
      }),
    );
}

export function walletLabel(): string {
  const parts = [wallets.sol && shortAddr(wallets.sol.address), wallets.evm && shortAddr(wallets.evm.address)].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'Connect wallet';
}
