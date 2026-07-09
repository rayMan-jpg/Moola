import { bg, fg, HALF_BLOCK, RESET } from '@moola/shared';

/**
 * Quantize a channel to a multiple of 8. Visually invisible, but it makes
 * adjacent pixels identical far more often, which lengthens the SGR runs
 * and dramatically improves gzip compression.
 */
function q(v: number): number {
  return v & ~7;
}

/**
 * Encode one raw RGB frame into an ANSI half-block string.
 * Each character cell covers two vertically stacked pixels: the top pixel is
 * the foreground color of a ▀, the bottom pixel its background. SGR codes are
 * emitted only when a color differs from the previous cell's (run-length).
 */
export function encodeFrame(rgb: Buffer, pxW: number, pxH: number): string {
  const rows: string[] = [];
  for (let y = 0; y + 1 < pxH; y += 2) {
    let row = '';
    let lastFg = '';
    let lastBg = '';
    for (let x = 0; x < pxW; x++) {
      const t = (y * pxW + x) * 3;
      const b = ((y + 1) * pxW + x) * 3;
      const fgCode = fg(q(rgb[t]), q(rgb[t + 1]), q(rgb[t + 2]));
      const bgCode = bg(q(rgb[b]), q(rgb[b + 1]), q(rgb[b + 2]));
      if (fgCode !== lastFg) {
        row += fgCode;
        lastFg = fgCode;
      }
      if (bgCode !== lastBg) {
        row += bgCode;
        lastBg = bgCode;
      }
      row += HALF_BLOCK;
    }
    rows.push(row + RESET);
  }
  return rows.join('\n');
}
