/**
 * The terminal player. Renders a FrameAsset in place using cursor-reset
 * (never a screen clear) so the host CLI's scrollback survives.
 * Used by both `moola-transcode --play` and the publisher SDK.
 */
import type { FrameAsset } from './frame-format.ts';
import { cursorUpLines, ERASE_DOWN, HIDE_CURSOR, RESET, SHOW_CURSOR } from './ansi.ts';

export interface PlayOptions {
  out?: NodeJS.WriteStream;
  /** Extra line under the video (already ANSI/OSC8-formatted by the caller). */
  footer?: string;
  /** Any keypress stops playback (requires a TTY stdin). Default true. */
  allowSkip?: boolean;
  /** Line to leave behind after the ad block is erased (e.g. a clickable "Ad: …"). */
  leaveBehind?: string;
  /** Center horizontally in the terminal. Default true. */
  center?: boolean;
}

export type PlayResult = 'finished' | 'skipped';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function playAsset(asset: FrameAsset, opts: PlayOptions = {}): Promise<PlayResult> {
  const out = opts.out ?? process.stdout;
  const allowSkip = opts.allowSkip ?? true;
  const center = opts.center ?? true;

  const termCols = out.columns ?? asset.cols;
  const pad = center ? ' '.repeat(Math.max(0, Math.floor((termCols - asset.cols) / 2))) : '';
  const footer = opts.footer !== undefined ? pad + opts.footer : undefined;
  const blockLines = asset.rows + (footer !== undefined ? 1 : 0);

  // Pre-pad frames once so the render loop is just a write.
  const frames = pad
    ? asset.frames.map((f) => f.split('\n').map((l) => pad + l).join('\n'))
    : asset.frames;

  let skipped = false;
  const stdin = process.stdin;
  const canSkip = allowSkip && stdin.isTTY;
  const onKey = (buf: Buffer) => {
    if (buf[0] === 0x03) {
      // Ctrl-C: restore the terminal, then behave like a real SIGINT.
      cleanup();
      out.write(`${cursorUpLines(blockLines)}${ERASE_DOWN}${RESET}${SHOW_CURSOR}`);
      process.kill(process.pid, 'SIGINT');
      return;
    }
    skipped = true;
  };
  const cleanup = () => {
    if (canSkip) {
      stdin.off('data', onKey);
      stdin.setRawMode(false);
      stdin.pause();
    }
  };
  if (canSkip) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onKey);
  }

  out.write(HIDE_CURSOR);
  const frameMs = 1000 / asset.fps;
  const start = Date.now();
  let drawn = -1;
  let firstDraw = true;

  try {
    while (!skipped) {
      const idx = Math.floor((Date.now() - start) / frameMs);
      if (idx >= frames.length) break;
      if (idx !== drawn) {
        const block = footer !== undefined ? `${frames[idx]}\n${footer}` : frames[idx];
        out.write((firstDraw ? '' : cursorUpLines(blockLines)) + block + '\n');
        drawn = idx;
        firstDraw = false;
      }
      await sleep(Math.max(4, frameMs / 3));
    }
  } finally {
    cleanup();
    if (!firstDraw) out.write(`${cursorUpLines(blockLines)}${ERASE_DOWN}`);
    out.write(RESET + SHOW_CURSOR);
    if (opts.leaveBehind) out.write(opts.leaveBehind + '\n');
  }
  return skipped ? 'skipped' : 'finished';
}
