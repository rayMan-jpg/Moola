// A Wallet Standard wallet injected into the page. It never holds a private key: "signing" returns
// the transaction untouched and "sending" hands the bytes to the test, which simulates them on
// mainnet with sigVerify=false. That proves the exact transaction the UI built would execute.
export const MOCK_WALLET_SCRIPT = ({ address, publicKey }: { address: string; publicKey: number[] }) => {
  const account = {
    address,
    publicKey: new Uint8Array(publicKey),
    chains: ['solana:mainnet'],
    features: ['solana:signAndSendTransaction', 'solana:signTransaction', 'solana:signMessage'],
  };
  const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
  const w = window as unknown as {
    __mockSend: (tx: number[]) => Promise<number[]>;
    __mockSign: (txs: number[][]) => Promise<number[][]>;
    __mockSignMessage: (m: number[]) => Promise<number[]>;
    /** Connect prompts the page opened (silent reconnects don't count). */
    __connects?: number;
  };
  const wallet = {
    version: '1.0.0',
    name: 'Mock Degen Wallet',
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMzOWZmMTQiLz48L3N2Zz4=',
    chains: ['solana:mainnet', 'solana:devnet'],
    accounts: [] as (typeof account)[],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async (input?: { silent?: boolean }) => {
          if (!input?.silent) w.__connects = (w.__connects ?? 0) + 1;
          if (input?.silent && !wallet.accounts.length) return { accounts: [] };
          wallet.accounts = [account];
          (listeners.change || []).forEach((l) => l({ accounts: wallet.accounts }));
          return { accounts: wallet.accounts };
        },
      },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { wallet.accounts = []; } },
      'standard:events': {
        version: '1.0.0',
        on: (ev: string, l: (...a: unknown[]) => void) => {
          (listeners[ev] ||= []).push(l);
          return () => { listeners[ev] = listeners[ev].filter((x) => x !== l); };
        },
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          const sig = await w.__mockSend(Array.from(inputs[0].transaction));
          return [{ signature: new Uint8Array(sig) }];
        },
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs: { message: Uint8Array }[]) => {
          const sig = await w.__mockSignMessage(Array.from(inputs[0].message));
          return [{ signedMessage: inputs[0].message, signature: new Uint8Array(sig) }];
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        // One call = one wallet prompt, however many transactions it carries.
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          const out = await w.__mockSign(inputs.map((i) => Array.from(i.transaction)));
          return out.map((o) => ({ signedTransaction: new Uint8Array(o) }));
        },
      },
    },
  };
  const register = ({ register }: { register: (w: unknown) => void }) => register(wallet);
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }));
  } catch (e) {
    console.error('mock wallet register failed', e);
  }
  window.addEventListener('wallet-standard:app-ready', (e) => register((e as CustomEvent).detail));
};

// An EIP-6963 EVM wallet already on Robinhood Chain. Transactions go to the test, which simulates
// them against the live chain and returns a fake hash; nothing is ever signed or broadcast.
export const MOCK_EVM_SCRIPT = ({ address }: { address: string }) => {
  const w = window as unknown as {
    __mockEvmSend: (tx: Record<string, string>) => Promise<string>;
    __mockEvmSign: (messageHex: string, account: string) => Promise<string>;
    /** Connect prompts the page opened (eth_accounts reconnects don't count). */
    __connects?: number;
  };
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      switch (method) {
        case 'eth_requestAccounts':
          w.__connects = (w.__connects ?? 0) + 1;
          return [address];
        case 'eth_accounts':
          return [address];
        case 'eth_chainId':
          return '0x1237';
        case 'wallet_switchEthereumChain':
        case 'wallet_addEthereumChain':
          return null;
        case 'eth_sendTransaction':
          return w.__mockEvmSend((params as Record<string, string>[])[0]);
        case 'personal_sign': {
          const [message, account] = params as string[];
          return w.__mockEvmSign(message, account);
        }
        default:
          throw Object.assign(new Error(`mock evm wallet: ${method} not supported`), { code: 4200 });
      }
    },
    on: () => {},
    removeListener: () => {},
  };
  const info = { uuid: 'mock-evm', name: 'Mock Hood Wallet', icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PGNpcmNsZSBjeD0iMTYiIGN5PSIxNiIgcj0iMTYiIGZpbGw9IiMwMGYwZmYiLz48L3N2Zz4=', rdns: 'test.mock.evm' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
};
