// Tiny raw-transaction helpers for the test harness (avoids loading @solana/web3.js in Playwright).
import { ed25519 } from '@noble/curves/ed25519.js';

function shortVec(b: Uint8Array, off: number): [number, number] {
  let len = 0;
  let size = 0;
  for (;;) {
    const byte = b[off + size];
    len |= (byte & 0x7f) << (7 * size);
    size++;
    if (!(byte & 0x80)) return [len, size];
  }
}

export function layout(tx: Uint8Array) {
  const [sigCount, sz] = shortVec(tx, 0);
  const sigStart = sz;
  const msgStart = sigStart + 64 * sigCount;
  const versioned = (tx[msgStart] & 0x80) !== 0;
  const headerAt = msgStart + (versioned ? 1 : 0);
  const [, keysSz] = shortVec(tx, headerAt + 3);
  const key0 = headerAt + 3 + keysSz;
  return { sigCount, sigStart, msgStart, key0 };
}

export function payer(tx: Uint8Array): Uint8Array {
  const { key0 } = layout(tx);
  return tx.slice(key0, key0 + 32);
}

export function withPayer(tx: Uint8Array, pubkey: Uint8Array): Uint8Array {
  const out = Uint8Array.from(tx);
  out.set(pubkey, layout(tx).key0);
  return out;
}

export function signPayer(tx: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const { sigStart, msgStart } = layout(tx);
  const out = Uint8Array.from(tx);
  out.set(ed25519.sign(tx.slice(msgStart), secretKey), sigStart);
  return out;
}

export function newKey() {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}
