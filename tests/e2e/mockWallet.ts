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
    __mockSign: (tx: number[]) => Promise<number[]>;
    __mockSignMessage: (m: number[]) => Promise<number[]>;
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
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) => {
          const out = await w.__mockSign(Array.from(inputs[0].transaction));
          return [{ signedTransaction: new Uint8Array(out) }];
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
