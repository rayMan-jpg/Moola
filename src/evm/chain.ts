// Robinhood Chain (EVM L2, chain 4663) for the browser: CORS-open public RPCs for reads and
// simulation, EIP-6963 wallet discovery, and sending through the user's own wallet.
// Facts verified live 2026-10-18 (see README): official RPC + publicnode + dRPC all send ACAO *.

export const RH_CHAIN_ID = 4663;
export const RH_CHAIN_HEX = '0x1237';
export const RH_RPCS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org'];
export const RH_EXPLORER = 'https://robinhoodchain.blockscout.com';
export const RH_ADD_CHAIN = {
  chainId: RH_CHAIN_HEX,
  chainName: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: [RH_RPCS[0]],
  blockExplorerUrls: [RH_EXPLORER],
};

export type Hex = `0x${string}`;

export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, cb: (...a: unknown[]) => void): void;
  removeListener?(event: string, cb: (...a: unknown[]) => void): void;
}

export interface EvmWalletInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
  provider: Eip1193;
}

export interface EvmConnected {
  info: EvmWalletInfo;
  address: Hex;
}

export class EvmRpcError extends Error {
  constructor(
    message: string,
    public data?: unknown,
  ) {
    super(message);
  }
}

/** JSON-RPC against the public RPCs. Node errors (reverts) throw immediately; network errors fail over. */
export async function evmRpc<T>(method: string, params: unknown[] = [], urls = RH_RPCS): Promise<T> {
  let last: unknown;
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
      const j = (await r.json()) as { result?: T; error?: { message?: string; data?: unknown } };
      if (j.error) throw new EvmRpcError(j.error.message ?? 'rpc error', j.error.data);
      return j.result as T;
    } catch (e) {
      if (e instanceof EvmRpcError) throw e;
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error(`${method} failed`);
}

export async function getBalanceEth(address: string): Promise<number> {
  const wei = BigInt(await evmRpc<string>('eth_getBalance', [address, 'latest']));
  return Number(wei) / 1e18;
}

/** EIP-6963 discovery, falling back to window.ethereum for in-app browsers that don't announce. */
export function discoverEvmWallets(timeoutMs = 350): Promise<EvmWalletInfo[]> {
  return new Promise((resolve) => {
    const found = new Map<string, EvmWalletInfo>();
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<{ info: Omit<EvmWalletInfo, 'provider'>; provider: Eip1193 }>).detail;
      if (d?.info?.uuid && d.provider) found.set(d.info.rdns || d.info.uuid, { ...d.info, provider: d.provider });
    };
    window.addEventListener('eip6963:announceProvider', onAnnounce as EventListener);
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce as EventListener);
      const legacy = (window as unknown as { ethereum?: Eip1193 & Record<string, unknown> }).ethereum;
      if (!found.size && legacy) {
        const name = legacy.isMetaMask ? 'MetaMask' : legacy.isCoinbaseWallet ? 'Coinbase Wallet' : legacy.isRabby ? 'Rabby' : legacy.isPhantom ? 'Phantom' : 'Browser wallet';
        found.set('legacy', { uuid: 'legacy', name, icon: '', rdns: 'legacy', provider: legacy });
      }
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

function errCode(e: unknown): number | undefined {
  const x = e as { code?: number; data?: { originalError?: { code?: number } }; cause?: { code?: number } };
  return x?.code ?? x?.data?.originalError?.code ?? x?.cause?.code;
}

export async function ensureRobinhood(p: Eip1193): Promise<void> {
  const current = (await p.request({ method: 'eth_chainId' })) as string;
  if (parseInt(current, 16) === RH_CHAIN_ID) return;
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: RH_CHAIN_HEX }] });
  } catch (e) {
    const code = errCode(e);
    if (code === 4902 || code === -32603 || /unrecognized|not added|unknown chain/i.test(String((e as Error)?.message))) {
      await p.request({ method: 'wallet_addEthereumChain', params: [RH_ADD_CHAIN] });
    } else {
      throw e;
    }
  }
  const after = (await p.request({ method: 'eth_chainId' })) as string;
  if (parseInt(after, 16) !== RH_CHAIN_ID) throw new Error('switch your wallet to Robinhood Chain and try again');
}

export async function connectEvm(info: EvmWalletInfo): Promise<EvmConnected> {
  const accounts = (await info.provider.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.[0]) throw new Error(`${info.name} did not share an account`);
  await ensureRobinhood(info.provider);
  return { info, address: accounts[0].toLowerCase() as Hex };
}

export interface EvmTx {
  to: Hex;
  data: Hex;
  value: bigint;
}

const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;

/** eth_call from the user: returns the call result (or throws the revert). */
export function simulateEvm(from: string, tx: EvmTx): Promise<Hex> {
  return evmRpc<Hex>('eth_call', [{ from, to: tx.to, data: tx.data, value: hex(tx.value) }, 'latest']);
}

export async function estimateGas(from: string, tx: EvmTx): Promise<bigint> {
  return BigInt(await evmRpc<string>('eth_estimateGas', [{ from, to: tx.to, data: tx.data, value: hex(tx.value) }]));
}

/** Sends through the user's wallet, on Robinhood Chain, with a 25% gas buffer. Returns the tx hash. */
export async function sendEvm(c: EvmConnected, tx: EvmTx): Promise<Hex> {
  await ensureRobinhood(c.info.provider);
  const gas = await estimateGas(c.address, tx).catch(() => null);
  const params: Record<string, string> = { from: c.address, to: tx.to, data: tx.data, value: hex(tx.value) };
  if (gas) params.gas = hex((gas * 125n) / 100n);
  return (await c.info.provider.request({ method: 'eth_sendTransaction', params: [params] })) as Hex;
}

export interface EvmLog {
  address: string;
  topics: Hex[];
  data: Hex;
}

export interface EvmReceipt {
  status: string;
  blockNumber: string;
  logs: EvmLog[];
}

/** Robinhood Chain blocks are ~100 ms; receipts normally show up within a couple of seconds. */
export async function waitReceipt(hash: string, timeoutMs = 90_000): Promise<EvmReceipt> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await evmRpc<EvmReceipt | null>('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) return r;
    if (Date.now() > until) throw new Error('the transaction did not confirm in time. check the explorer before trying again');
    await new Promise((res) => setTimeout(res, 1200));
  }
}

export function utf8Hex(s: string): Hex {
  return `0x${[...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function evmDeeplinks(url: string): { name: string; url: string }[] {
  const enc = encodeURIComponent(url);
  return [
    { name: 'MetaMask', url: `https://metamask.app.link/dapp/${url.replace(/^https?:\/\//, '')}` },
    { name: 'Phantom', url: `https://phantom.app/ul/browse/${enc}?ref=${encodeURIComponent(new URL(url).origin)}` },
    { name: 'Coinbase Wallet', url: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: 'Trust Wallet', url: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
  ];
}
