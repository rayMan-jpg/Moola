/**
 * moola-transcode — convert a video into Moola's terminal-video format.
 *
 *   npm run transcode -- <video.mp4> [--play] [--out <dir>]
 *   npx moola-transcode <video.mp4> --play
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pickWidth, playAsset } from '@moola/shared';
import { readAsset, transcode } from './index.ts';

const args = process.argv.slice(2);
const play = args.includes('--play');
const outFlag = args.indexOf('--out');
const outDir = outFlag !== -1 ? args[outFlag + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith('--') && (outFlag === -1 || i !== outFlag + 1));
const videoPath = positional[0];

if (!videoPath) {
  console.log('Usage: moola-transcode <video.mp4> [--play] [--out <dir>]');
  console.log('  Converts a video to Moola terminal-video assets (80 and 120 columns wide).');
  console.log('  --play  play the result in this terminal right away');
  console.log('  --out   output directory (default: next to the video)');
  process.exit(1);
}
if (!existsSync(videoPath)) {
  console.error(`File not found: ${videoPath}`);
  process.exit(1);
}

const baseName = path.basename(videoPath).replace(/\.[^.]+$/, '');
const dir = outDir ?? path.dirname(path.resolve(videoPath));

console.log(`Transcoding ${videoPath} ...`);
const results = await transcode(videoPath, dir, baseName);
for (const r of results) {
  console.log(
    `  ${r.cols}x${r.rows} chars @ ${r.fps}fps, ${r.frameCount} frames, ${(r.bytes / 1024).toFixed(0)} KB -> ${r.filePath}`
  );
}

if (play) {
  const termCols = process.stdout.columns ?? 80;
  const width = pickWidth(termCols, results.map((r) => r.cols));
  if (!width) {
    console.error(`Terminal too narrow (${termCols} cols; need at least ${Math.min(...results.map((r) => r.cols))}).`);
    process.exit(1);
  }
  const asset = readAsset(results.find((r) => r.cols === width)!.filePath);
  console.log('');
  const result = await playAsset(asset, { footer: '(press any key to stop)' });
  console.log(result === 'skipped' ? 'Stopped.' : 'Done.');
}
