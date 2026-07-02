#!/usr/bin/env python3
"""Glyph video -> ASCII frame-pack converter.

Converts an advertiser MP4 (or any video OpenCV can read) into a compact
"frame pack": a JSON document of pre-rendered ASCII frames the web player
can play back on a <canvas> with zero client-side conversion work.

Pack format (v1):
{
  "v": 1,
  "cols": 96, "rows": 36, "fps": 12,
  "charset": " .:-=+*#%@",
  "mode": "mono" | "color",
  "palette": ["#rrggbb", ...],        # color mode only, max 16 entries
  "frames": ["<rows joined by \\n>", ...],
  "colors": ["<hex digit per cell, rows joined by \\n>", ...]  # color mode only
}

License: MIT. This is original code — no ASCILINE dependency (its license
forbids advertising use).
"""

import argparse
import json
import sys

import cv2
import numpy as np

# Ordered light -> dark ink coverage. Rendered light-on-dark, so index 0
# (space) maps to black and the last char maps to the brightest pixel.
DEFAULT_CHARSET = " .:-=+*#%@"

# Terminal-ish 16 color palette used when --palette adaptive is off.
ANSI16 = [
    (0, 0, 0), (170, 0, 0), (0, 170, 0), (170, 85, 0),
    (0, 0, 170), (170, 0, 170), (0, 170, 170), (170, 170, 170),
    (85, 85, 85), (255, 85, 85), (85, 255, 85), (255, 255, 85),
    (85, 85, 255), (255, 85, 255), (85, 255, 255), (255, 255, 255),
]

# A monospace glyph cell is roughly twice as tall as it is wide.
CHAR_ASPECT = 0.5


def adaptive_palette(samples: list[np.ndarray], n: int = 16) -> list[tuple[int, int, int]]:
    """K-means a 16-color palette from sampled frames (BGR uint8 in, RGB out)."""
    pixels = np.concatenate([s.reshape(-1, 3) for s in samples]).astype(np.float32)
    if len(pixels) > 50_000:
        idx = np.random.default_rng(0).choice(len(pixels), 50_000, replace=False)
        pixels = pixels[idx]
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, _, centers = cv2.kmeans(pixels, n, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    return [(int(c[2]), int(c[1]), int(c[0])) for c in centers]  # BGR -> RGB


def frame_to_ascii(frame: np.ndarray, cols: int, rows: int, charset: str,
                   palette_arr: np.ndarray | None):
    """Return (text, colorline) for one video frame."""
    cell = cv2.resize(frame, (cols, rows), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(cell, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
    # Mild gamma lift keeps midtones readable in ASCII.
    gray = np.power(gray, 0.9)
    indices = np.clip((gray * (len(charset) - 1)).round().astype(int), 0, len(charset) - 1)
    lut = np.array(list(charset))
    text = "\n".join("".join(row) for row in lut[indices])

    colorline = None
    if palette_arr is not None:
        rgb = cv2.cvtColor(cell, cv2.COLOR_BGR2RGB).astype(np.int32)
        # Nearest palette entry per cell.
        dists = ((rgb[:, :, None, :] - palette_arr[None, None, :, :]) ** 2).sum(axis=3)
        pidx = dists.argmin(axis=2)
        hexdigits = np.array(list("0123456789abcdef"))
        colorline = "\n".join("".join(row) for row in hexdigits[pidx])
    return text, colorline


def convert(path: str, cols: int, fps: int, charset: str, mode: str,
            palette_mode: str, max_seconds: float | None) -> dict:
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"error: cannot open video {path!r}")

    src_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    rows = max(4, round(cols * (h / w) * CHAR_ASPECT))
    step = max(1, round(src_fps / fps))

    # First pass for adaptive palette: sample up to 24 frames.
    palette = None
    palette_arr = None
    if mode == "color":
        if palette_mode == "adaptive":
            total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
            sample_at = set(np.linspace(0, max(total - 1, 0), 24, dtype=int).tolist())
            samples, i = [], 0
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                if i in sample_at:
                    samples.append(cv2.resize(frame, (cols, rows), interpolation=cv2.INTER_AREA))
                i += 1
            cap.release()
            cap = cv2.VideoCapture(path)
            rgb_palette = adaptive_palette(samples) if samples else ANSI16
        else:
            rgb_palette = ANSI16
        palette = ["#%02x%02x%02x" % c for c in rgb_palette]
        palette_arr = np.array(rgb_palette, dtype=np.int32)

    frames, colors = [], []
    i = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if i % step == 0:
            if max_seconds is not None and len(frames) >= max_seconds * fps:
                break
            text, colorline = frame_to_ascii(frame, cols, rows, charset, palette_arr)
            frames.append(text)
            if colorline is not None:
                colors.append(colorline)
        i += 1
    cap.release()

    if not frames:
        sys.exit("error: no frames decoded")

    pack = {
        "v": 1, "cols": cols, "rows": rows, "fps": fps,
        "charset": charset, "mode": mode, "frames": frames,
    }
    if mode == "color":
        pack["palette"] = palette
        pack["colors"] = colors
    return pack


def main() -> None:
    p = argparse.ArgumentParser(description="Convert video to a Glyph ASCII frame pack")
    p.add_argument("video")
    p.add_argument("--cols", type=int, default=96)
    p.add_argument("--fps", type=int, default=12)
    p.add_argument("--charset", default=DEFAULT_CHARSET)
    p.add_argument("--mode", choices=["mono", "color"], default="color")
    p.add_argument("--palette", choices=["adaptive", "ansi16"], default="adaptive")
    p.add_argument("--max-seconds", type=float, default=None)
    p.add_argument("--out", default="pack.json")
    args = p.parse_args()

    pack = convert(args.video, args.cols, args.fps, args.charset, args.mode,
                   args.palette, args.max_seconds)
    with open(args.out, "w") as f:
        json.dump(pack, f, separators=(",", ":"))
    raw = len(json.dumps(pack))
    secs = len(pack["frames"]) / pack["fps"]
    print(f"wrote {args.out}: {pack['cols']}x{pack['rows']} @ {pack['fps']}fps, "
          f"{len(pack['frames'])} frames ({secs:.1f}s), {raw / 1024:.0f} KB raw")


if __name__ == "__main__":
    main()
