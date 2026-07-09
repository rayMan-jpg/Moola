/**
 * Locates ffmpeg/ffprobe binaries. Resolution order:
 *   1. MOOLA_FFMPEG / MOOLA_FFPROBE environment variables
 *   2. the bundled ffmpeg-static / ffprobe-static binaries (optional deps —
 *      their postinstall download can be blocked by firewalls/proxies)
 *   3. a system-installed binary on PATH
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function onPath(bin: string): string | null {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return bin;
  } catch {
    return null;
  }
}

export function ffmpegPath(): string {
  const env = process.env.MOOLA_FFMPEG;
  if (env) return env;
  try {
    const p = require('ffmpeg-static') as string | null;
    if (p && existsSync(p)) return p;
  } catch {
    /* optional dep not installed */
  }
  const sys = onPath('ffmpeg');
  if (sys) return sys;
  throw new Error(
    'ffmpeg not found. Install it (e.g. `apt-get install ffmpeg` / `brew install ffmpeg`) or set MOOLA_FFMPEG to its path.'
  );
}

export function ffprobePath(): string {
  const env = process.env.MOOLA_FFPROBE;
  if (env) return env;
  try {
    const p = (require('ffprobe-static') as { path: string }).path;
    if (p && existsSync(p)) return p;
  } catch {
    /* optional dep not installed */
  }
  const sys = onPath('ffprobe');
  if (sys) return sys;
  throw new Error(
    'ffprobe not found. Install ffmpeg (which includes ffprobe) or set MOOLA_FFPROBE to its path.'
  );
}
