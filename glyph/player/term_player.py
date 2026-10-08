#!/usr/bin/env python3
"""Glyph terminal player — plays a frame pack as ANSI in any terminal.

This is the display path for CLI AI harnesses (Claude Code, Codex CLI,
Gemini CLI, Aider): they all render tool/script output in a terminal
emulator, so ANSI escape support is the compatibility target.

Color depth autodetects (truecolor -> 256 -> 16 -> mono) and can be forced
with --depth. `--frame N` prints a single frame and exits (non-interactive
harness test); `--once` plays one loop then exits.
"""

import argparse
import json
import os
import sys
import time

RESET = "\x1b[0m"


def detect_depth() -> str:
    if os.environ.get("COLORTERM", "") in ("truecolor", "24bit"):
        return "truecolor"
    term = os.environ.get("TERM", "")
    if "256" in term:
        return "256"
    if term in ("", "dumb"):
        return "mono"
    return "16"


def hex_to_rgb(h: str) -> tuple[int, int, int]:
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def rgb_to_256(r: int, g: int, b: int) -> int:
    # Map into the 6x6x6 color cube (indices 16..231).
    return 16 + 36 * round(r / 51) + 6 * round(g / 51) + round(b / 51)


def rgb_to_16(r: int, g: int, b: int) -> int:
    bright = 60 if max(r, g, b) > 170 else 0
    code = 30 + (1 if r > 85 else 0) + (2 if g > 85 else 0) * 1 + (4 if b > 85 else 0)
    # Compose standard fg code: red=31 green=32 yellow=33 blue=34 ...
    idx = (4 if b > 85 else 0) | (2 if g > 85 else 0) | (1 if r > 85 else 0)
    return 30 + idx + bright


def palette_codes(palette: list[str], depth: str) -> list[str]:
    codes = []
    for h in palette:
        r, g, b = hex_to_rgb(h)
        if depth == "truecolor":
            codes.append(f"\x1b[38;2;{r};{g};{b}m")
        elif depth == "256":
            codes.append(f"\x1b[38;5;{rgb_to_256(r, g, b)}m")
        elif depth == "16":
            codes.append(f"\x1b[{rgb_to_16(r, g, b)}m")
        else:
            codes.append("")
    return codes


def render_frame(pack: dict, i: int, codes: list[str] | None) -> str:
    text = pack["frames"][i].split("\n")
    if codes is None or pack.get("mode") != "color":
        return "\n".join(text)
    colors = pack["colors"][i].split("\n")
    out = []
    for line, cline in zip(text, colors):
        parts, start = [], 0
        for c in range(1, len(line) + 1):
            if c == len(line) or cline[c] != cline[start]:
                parts.append(codes[int(cline[start], 16)] + line[start:c])
                start = c
        out.append("".join(parts))
    return "\n".join(out) + RESET


def main() -> None:
    p = argparse.ArgumentParser(description="Play a Glyph frame pack in the terminal")
    p.add_argument("pack")
    p.add_argument("--depth", choices=["truecolor", "256", "16", "mono"], default=None)
    p.add_argument("--frame", type=int, default=None, help="print one frame and exit")
    p.add_argument("--once", action="store_true", help="play one loop then exit")
    p.add_argument("--fps", type=float, default=None, help="override pack fps")
    args = p.parse_args()

    with open(args.pack) as f:
        pack = json.load(f)
    depth = args.depth or detect_depth()
    codes = palette_codes(pack["palette"], depth) if pack.get("mode") == "color" and depth != "mono" else None

    if args.frame is not None:
        print(render_frame(pack, args.frame % len(pack["frames"]), codes))
        return

    fps = args.fps or pack["fps"]
    n = len(pack["frames"])
    hide, show = "\x1b[?25l", "\x1b[?25h"
    home = f"\x1b[{pack['rows']}A"  # cursor up to redraw in place
    sys.stdout.write(hide)
    try:
        i = 0
        while True:
            sys.stdout.write(render_frame(pack, i, codes) + "\n")
            sys.stdout.flush()
            time.sleep(1 / fps)
            i += 1
            if i >= n:
                if args.once:
                    break
                i = 0
            sys.stdout.write(home)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write(show + RESET + "\n")


if __name__ == "__main__":
    main()
