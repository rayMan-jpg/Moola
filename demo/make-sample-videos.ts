/**
 * Generates sample "advertiser" MP4s using ffmpeg's built-in synthetic
 * sources — nothing is downloaded. Output: demo/videos/*.mp4
 */
import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ffmpegPath } from '../packages/transcoder/src/ffbin.ts';

const execFileP = promisify(execFile);
const outDir = path.resolve(import.meta.dirname, 'videos');
mkdirSync(outDir, { recursive: true });

interface Sample {
  file: string;
  label: string;
  /** lavfi filtergraph for the video source */
  filter: string;
}

// drawtext uses fontconfig's default sans font; every desktop Linux/macOS has one.
const text = (t: string, size = 34, extra = '') =>
  `drawtext=text='${t}':fontcolor=white:fontsize=${size}:x=(w-text_w)/2:y=(h-text_h)/2${extra}`;

const samples: Sample[] = [
  {
    file: 'moola-cloud.mp4',
    label: 'MOOLA CLOUD — cloud hosting ad (keywords: aws, cloud)',
    filter:
      `gradients=size=320x180:rate=12:c0=0x0b3d91:c1=0x00b4d8:duration=8[bg];` +
      `[bg]${text('MOOLA CLOUD', 40)},${text('deploy faster', 20, ':y=(h/2)+40')}`,
  },
  {
    file: 'pytools-pro.mp4',
    label: 'PyTools Pro — python tooling ad (keywords: python, pip)',
    filter:
      `gradients=size=320x180:rate=12:c0=0x1d3557:c1=0x2a9d8f:duration=8[bg];` +
      `[bg]${text('PyTools Pro', 40)},${text('ship python 10x faster', 18, ':y=(h/2)+40')}`,
  },
  {
    file: 'test-pattern.mp4',
    label: 'Colorful moving test pattern (keywords: test)',
    filter: `testsrc2=size=320x180:rate=12:duration=8`,
  },
];

for (const s of samples) {
  const out = path.join(outDir, s.file);
  try {
    await execFileP(ffmpegPath(), [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', s.filter,
      '-pix_fmt', 'yuv420p',
      out,
    ]);
    console.log(`✅ ${s.file} — ${s.label}`);
  } catch (err) {
    // drawtext needs freetype/fontconfig; fall back to the pattern-only source.
    const msg = err instanceof Error ? err.message : String(err);
    if (s.filter.includes('drawtext')) {
      console.log(`⚠️  ${s.file}: drawtext unavailable (${msg.split('\n')[0]}); using plain gradient`);
      await execFileP(ffmpegPath(), [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', s.filter.replace(/\[bg\].*$/, '').replace(/\[bg\];?$/, ''),
        '-pix_fmt', 'yuv420p',
        out,
      ]);
      console.log(`✅ ${s.file} — gradient fallback`);
    } else {
      throw err;
    }
  }
}

console.log(`\nCreated ${samples.length} sample videos in demo/videos/`);
console.log('Try one:  npm run transcode -- demo/videos/moola-cloud.mp4 --play');
