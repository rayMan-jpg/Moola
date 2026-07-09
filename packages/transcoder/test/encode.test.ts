import { describe, expect, it } from 'vitest';
import { encodeFrame } from '../src/encode.ts';

const E = '\x1b';

describe('encodeFrame', () => {
  it('encodes a 2x2 frame to the exact expected ANSI string', () => {
    // 2x2 pixels: top row [red, green], bottom row [blue, white]
    const rgb = Buffer.from([
      255, 0, 0,   0, 255, 0,
      0, 0, 255,   255, 255, 255,
    ]);
    // 255 quantizes to 248 (multiples of 8)
    const expected =
      `${E}[38;2;248;0;0m${E}[48;2;0;0;248m▀` +
      `${E}[38;2;0;248;0m${E}[48;2;248;248;248m▀` +
      `${E}[0m`;
    expect(encodeFrame(rgb, 2, 2)).toBe(expected);
  });

  it('emits SGR codes only when colors change (run-length)', () => {
    // 3x2 pixels, all cells identical: red over blue
    const px = [255, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255];
    const rgb = Buffer.from(px);
    const expected = `${E}[38;2;248;0;0m${E}[48;2;0;0;248m▀▀▀${E}[0m`;
    expect(encodeFrame(rgb, 3, 2)).toBe(expected);
  });

  it('produces one text row per two pixel rows, joined by newline', () => {
    const rgb = Buffer.alloc(1 * 4 * 3); // 1x4 black pixels -> 2 rows
    const out = encodeFrame(rgb, 1, 4);
    expect(out.split('\n')).toHaveLength(2);
  });
});
