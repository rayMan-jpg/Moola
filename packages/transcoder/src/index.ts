import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  ASSET_WIDTHS,
  assetFileName,
  MAX_AD_SECONDS,
  TARGET_FPS,
  type FrameAsset,
} from '@moola/shared';
import { encodeFrame } from './encode.ts';
import { extractFrames } from './extract.ts';
import { probe } from './probe.ts';

export { probe } from './probe.ts';
export { encodeFrame } from './encode.ts';
export { ffmpegPath, ffprobePath } from './ffbin.ts';

export interface TranscodedAsset {
  cols: number;
  rows: number;
  fps: number;
  frameCount: number;
  durationMs: number;
  filePath: string;
  bytes: number;
}

/**
 * Transcode a video into ANSI frame assets, one per target width.
 * Writes gzipped JSON files named `<baseName>-<cols>.json.gz` into outDir.
 */
export async function transcode(
  videoPath: string,
  outDir: string,
  baseName: string,
  widths: readonly number[] = ASSET_WIDTHS
): Promise<TranscodedAsset[]> {
  const info = await probe(videoPath);
  mkdirSync(outDir, { recursive: true });

  const results: TranscodedAsset[] = [];
  for (const cols of widths) {
    const pxW = cols;
    // Round pixel height to an even number: each character row consumes two pixel rows.
    const pxH = Math.max(2, 2 * Math.round((pxW * info.height) / info.width / 2));
    const rows = pxH / 2;

    const rawFrames = await extractFrames(videoPath, pxW, pxH, TARGET_FPS, MAX_AD_SECONDS);
    const frames = rawFrames.map((buf) => encodeFrame(buf, pxW, pxH));
    const durationMs = Math.round((frames.length / TARGET_FPS) * 1000);

    const asset: FrameAsset = { v: 1, cols, rows, fps: TARGET_FPS, durationMs, frames };
    const filePath = path.join(outDir, assetFileName(baseName, cols));
    const gz = gzipSync(Buffer.from(JSON.stringify(asset)), { level: 9 });
    writeFileSync(filePath, gz);

    results.push({ cols, rows, fps: TARGET_FPS, frameCount: frames.length, durationMs, filePath, bytes: gz.length });
  }
  return results;
}

/** Read a gzipped frame asset back from disk. */
export function readAsset(filePath: string): FrameAsset {
  return JSON.parse(gunzipSync(readFileSync(filePath)).toString('utf8')) as FrameAsset;
}
