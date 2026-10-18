// Image shrinking + metadata JSON, both pinned to Arweave via Turbo's free tier.
import { turboUpload, TURBO_MAX_PAYLOAD } from './turbo';
import type { LaunchInput } from './launchpads/types';

/** Re-encode any image to fit the size limit. Animated GIFs become a still frame when not allowed. */
export async function fitImage(blob: Blob, maxBytes = TURBO_MAX_PAYLOAD, allowGif = true): Promise<{ bytes: Uint8Array; type: string }> {
  const ok = allowGif ? /^image\/(jpeg|png|webp|gif)$/ : /^image\/(jpeg|png|webp)$/;
  if (blob.size <= maxBytes && ok.test(blob.type)) {
    return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
  }
  const bmp = await createImageBitmap(blob);
  for (const side of [512, 400, 320]) {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    for (const q of [0.9, 0.8, 0.7, 0.6]) {
      const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', q));
      if (out && out.size <= maxBytes) return { bytes: new Uint8Array(await out.arrayBuffer()), type: 'image/jpeg' };
    }
  }
  throw new Error('could not shrink that image enough. try a simpler one.');
}

/**
 * Re-encode a user-picked image through a canvas so EXIF/GPS and other metadata never get published.
 * GIFs pass through untouched (no EXIF, and re-encoding would kill the animation).
 */
export async function stripImageMetadata(file: Blob, maxSide = 1024): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, type, 0.92));
  if (!out) throw new Error('could not read that image');
  return out;
}

export interface MetadataOptions {
  /** Launchpad site, written into the metadata the way that launchpad's own UI does. */
  createdOn: string;
  extra?: Record<string, unknown>;
}

export function metadataJson(input: LaunchInput, image: string, opts: MetadataOptions): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: input.name,
    symbol: input.ticker,
    description: input.description,
    image,
    showName: true,
    createdOn: opts.createdOn,
    ...opts.extra,
  };
  if (input.twitter) json.twitter = input.twitter;
  if (input.telegram) json.telegram = input.telegram;
  if (input.website) json.website = input.website;
  return json;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Uploads are permanent; a retry after a rejected or expired signature reuses them instead of re-pinning.
const uploaded = new Map<string, string>();

async function uploadOnce(bytes: Uint8Array, type: string, fetchImpl: typeof fetch): Promise<string> {
  const k = `${type}:${await sha256Hex(bytes)}`;
  const hit = uploaded.get(k);
  if (hit) return hit;
  const uri = await turboUpload(bytes, type, fetchImpl);
  uploaded.set(k, uri);
  return uri;
}

/** Uploads just the logo (Robinhood Chain launchpads keep metadata on-chain). Returns its https URL. */
export async function uploadImage(image: Blob, fetchImpl: typeof fetch = fetch): Promise<string> {
  const img = await fitImage(image);
  return uploadOnce(img.bytes, img.type, fetchImpl);
}

/** Uploads image then metadata. Returns the metadata URI that goes on-chain. */
export async function uploadMetadata(
  input: LaunchInput,
  opts: MetadataOptions,
  fetchImpl: typeof fetch = fetch,
): Promise<{ uri: string; image: string }> {
  const img = await fitImage(input.image);
  const image = await uploadOnce(img.bytes, img.type, fetchImpl);
  const body = new TextEncoder().encode(JSON.stringify(metadataJson(input, image, opts)));
  const uri = await uploadOnce(body, 'application/json', fetchImpl);
  return { uri, image };
}
