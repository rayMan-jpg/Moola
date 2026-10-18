// Generates a meme-coin logo on a canvas so nobody has to upload an image to launch.
// Deterministic per seed, so the same agent always gets the same logo.

export const PALETTES: [string, string, string][] = [
  ['#39ff14', '#0a0a0a', '#ff2e97'],
  ['#ff2e97', '#ffe600', '#0a0a0a'],
  ['#00f0ff', '#7c3aed', '#ffe600'],
  ['#ffe600', '#ff5f1f', '#0a0a0a'],
  ['#9d4dff', '#39ff14', '#0a0a0a'],
  ['#ff3131', '#ffe600', '#0a0a0a'],
  ['#00ff9d', '#00a3ff', '#0a0a0a'],
];

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function rng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ArtInput {
  ticker: string;
  emoji: string;
  seed: string;
}

export async function drawCoinArt(canvas: HTMLCanvasElement, input: ArtInput, size = 512): Promise<void> {
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not supported');
  const rand = rng(hashSeed(input.seed));
  const [a, b, c] = PALETTES[Math.floor(rand() * PALETTES.length)];
  const cx = size / 2;
  const cy = size / 2;

  // sunburst
  const rays = 18 + Math.floor(rand() * 10);
  const spin = rand() * Math.PI;
  for (let i = 0; i < rays; i++) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const a0 = spin + (i / rays) * Math.PI * 2;
    const a1 = spin + ((i + 1) / rays) * Math.PI * 2;
    ctx.arc(cx, cy, size, a0, a1);
    ctx.closePath();
    ctx.fillStyle = i % 2 ? a : b;
    ctx.fill();
  }

  // halftone dots
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let y = 8; y < size; y += 16) {
    for (let x = 8 + ((y / 16) % 2) * 8; x < size; x += 16) {
      const d = Math.hypot(x - cx, y - cy) / size;
      ctx.beginPath();
      ctx.arc(x, y, 1 + d * 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // emoji with a hard drop shadow
  try {
    await document.fonts?.load?.(`120px Bangers`);
  } catch {
    /* font loading is best effort */
  }
  ctx.save();
  ctx.translate(cx, cy - size * 0.06);
  ctx.rotate((rand() - 0.5) * 0.5);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${Math.round(size * 0.46)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillText(input.emoji, size * 0.025, size * 0.025);
  ctx.fillStyle = '#fff';
  ctx.fillText(input.emoji, 0, 0);
  ctx.restore();

  // $TICKER banner
  const label = `$${input.ticker.toUpperCase()}`.slice(0, 11);
  let fontSize = Math.round(size * 0.2);
  ctx.font = `${fontSize}px Bangers, Impact, sans-serif`;
  while (ctx.measureText(label).width > size * 0.86 && fontSize > 24) {
    fontSize -= 4;
    ctx.font = `${fontSize}px Bangers, Impact, sans-serif`;
  }
  ctx.save();
  ctx.translate(cx, size * 0.83);
  ctx.rotate(-0.06 + rand() * 0.04);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(8, fontSize * 0.16);
  ctx.strokeStyle = '#0a0a0a';
  ctx.strokeText(label, 0, 0);
  ctx.fillStyle = c === '#0a0a0a' ? '#ffffff' : c;
  ctx.fillText(label, 0, 0);
  ctx.restore();

  // sticker border
  ctx.lineWidth = size * 0.035;
  ctx.strokeStyle = '#0a0a0a';
  ctx.strokeRect(0, 0, size, size);
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg'): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not render image'))), type, 0.88),
  );
}
