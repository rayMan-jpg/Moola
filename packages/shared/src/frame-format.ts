/**
 * The frame-asset format — the central contract between the transcoder
 * (writer), the server (metadata + delivery), and the SDK/dashboard (players).
 *
 * A frame is one string: rows of half-block (▀) cells joined by '\n'.
 * Colors are 24-bit SGR codes; the top pixel of a cell is the foreground,
 * the bottom pixel is the background, which corrects the ~1:2 aspect ratio
 * of terminal character cells.
 */
export interface FrameAsset {
  v: 1;
  /** character columns */
  cols: number;
  /** character rows (= pixel height / 2) */
  rows: number;
  fps: number;
  durationMs: number;
  /** one ANSI-encoded string per frame */
  frames: string[];
}

/** Widths every ad is pre-rendered at. The SDK picks the largest that fits. */
export const ASSET_WIDTHS = [80, 120] as const;

/** Terminals narrower than this never get an ad. */
export const MIN_COLS = 80;

export const TARGET_FPS = 12;

/** Ads are hard-capped at this length during transcode. */
export const MAX_AD_SECONDS = 10;

export function assetFileName(baseName: string, cols: number): string {
  return `${baseName}-${cols}.json.gz`;
}

/** Largest pre-rendered width that fits in a terminal, or null if none do. */
export function pickWidth(terminalCols: number, available: readonly number[] = ASSET_WIDTHS): number | null {
  const fitting = available.filter((w) => w <= terminalCols);
  return fitting.length ? Math.max(...fitting) : null;
}
