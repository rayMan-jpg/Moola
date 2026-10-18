// Keyless Arweave uploads through ArDrive Turbo's free tier (items up to 107,520 bytes).
// Each upload is an ANS-104 data item signed by a throwaway ed25519 key made right here:
// no account, no API key, no SOL, no wallet popup. Files are permanent and served instantly
// from turbo-gateway.com. Format follows @dha-team/arbundles (sig type 2 = ED25519).
import { ed25519 } from '@noble/curves/ed25519.js';

export const TURBO_UPLOAD = 'https://upload.ardrive.io/v1/tx';
export const TURBO_GATEWAY = 'https://turbo-gateway.com';
export const TURBO_FREE_LIMIT = 107_520;
/** Header overhead of a data item with our two tags is ~160 bytes; keep payloads under this. */
export const TURBO_MAX_PAYLOAD = 100_000;

const te = new TextEncoder();
const SIG_TYPE_ED25519 = 2;

function concat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

async function digest(alg: 'SHA-384' | 'SHA-256', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, data as BufferSource));
}

type DeepHashChunk = Uint8Array | DeepHashChunk[];

export async function deepHash(x: DeepHashChunk): Promise<Uint8Array> {
  if (Array.isArray(x)) {
    let acc = await digest('SHA-384', te.encode(`list${x.length}`));
    for (const c of x) acc = await digest('SHA-384', concat(acc, await deepHash(c)));
    return acc;
  }
  const tag = await digest('SHA-384', te.encode(`blob${x.byteLength}`));
  return digest('SHA-384', concat(tag, await digest('SHA-384', x)));
}

/** Avro zig-zag varint, as used by arbundles for tag serialization. */
export function avroLong(n: number): Uint8Array {
  let v = BigInt(n);
  v = (v << 1n) ^ (v >> 63n);
  const out: number[] = [];
  while (v > 127n) {
    out.push(Number((v & 127n) | 128n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Uint8Array.from(out);
}

export function serializeTags(tags: { name: string; value: string }[]): Uint8Array {
  if (!tags.length) return new Uint8Array(0);
  const parts: Uint8Array[] = [avroLong(tags.length)];
  for (const { name, value } of tags) {
    const n = te.encode(name);
    const v = te.encode(value);
    parts.push(avroLong(n.length), n, avroLong(v.length), v);
  }
  parts.push(Uint8Array.of(0));
  return concat(...parts);
}

function u64le(n: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}

function b64url(u8: Uint8Array): string {
  let s = '';
  for (const c of u8) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function buildDataItem(
  data: Uint8Array,
  tags: { name: string; value: string }[],
  secretKey: Uint8Array = ed25519.utils.randomSecretKey(),
): Promise<{ item: Uint8Array; id: string }> {
  const owner = ed25519.getPublicKey(secretKey);
  const tagBytes = serializeTags(tags);
  const empty = new Uint8Array(0);
  const msg = await deepHash([te.encode('dataitem'), te.encode('1'), te.encode(String(SIG_TYPE_ED25519)), owner, empty, empty, tagBytes, data]);
  const sig = ed25519.sign(msg, secretKey);
  const item = concat(
    Uint8Array.of(SIG_TYPE_ED25519 & 0xff, SIG_TYPE_ED25519 >> 8),
    sig,
    owner,
    Uint8Array.of(0), // no target
    Uint8Array.of(0), // no anchor
    u64le(tags.length),
    u64le(tagBytes.length),
    tagBytes,
    data,
  );
  return { item, id: b64url(await digest('SHA-256', sig)) };
}

export async function turboUpload(data: Uint8Array, contentType: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { item, id } = await buildDataItem(data, [
    { name: 'Content-Type', value: contentType },
    { name: 'App-Name', value: 'Moola' },
  ]);
  if (item.length > TURBO_FREE_LIMIT) throw new Error(`file too big for free upload (${item.length} bytes). use a smaller image.`);
  const res = await fetchImpl(TURBO_UPLOAD, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: item as BodyInit });
  const j = (await res.json().catch(() => ({}))) as { id?: string };
  if (!res.ok) throw new Error(`metadata upload failed (${res.status}). try again in a sec.`);
  if (j.id && j.id !== id) throw new Error('upload service returned an unexpected id');
  return `${TURBO_GATEWAY}/${id}`;
}
