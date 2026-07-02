#!/usr/bin/env python3
"""Build a self-contained sponsor-preview HTML from a frame pack.

Embeds the pack JSON and the player inline so the result is a single file
you can email to an advertiser or open from disk — no server needed.
The page includes a mock earnings ticker to communicate the watch-to-earn
loop alongside the creative itself.
"""

import argparse
import json
import pathlib

TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glyph — ASCII ad preview</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{
    margin: 0; background: #0a0a0a; color: #e8e8e8; min-height: 100vh;
    font-family: 'Courier New', monospace;
    display: flex; flex-direction: column; align-items: center; gap: 16px;
    padding: 32px 16px;
  }}
  h1 {{ font-size: 15px; letter-spacing: 3px; color: #3ddc84; margin: 0; }}
  .stage {{ width: min(92vw, 860px); border: 1px solid #222; border-radius: 8px;
           overflow: hidden; background: #0a0a0a; }}
  canvas {{ display: block; width: 100%; }}
  .bar {{
    width: min(92vw, 860px); display: flex; justify-content: space-between;
    align-items: center; font-size: 13px; color: #999;
  }}
  .earn {{ color: #3ddc84; font-weight: bold; }}
  .note {{ max-width: 640px; font-size: 12px; color: #666; text-align: center; line-height: 1.6; }}
  button {{
    background: none; border: 1px solid #3ddc84; color: #3ddc84; padding: 6px 18px;
    font-family: inherit; font-size: 13px; cursor: pointer; border-radius: 4px;
  }}
</style>
</head>
<body>
<h1>▚ GLYPH · SPONSOR PREVIEW</h1>
<div class="stage"><canvas id="c"></canvas></div>
<div class="bar">
  <span id="meta"></span>
  <span>watched <span id="secs">0</span>s · earned <span class="earn" id="usdc">0.0000</span> USDC</span>
  <button id="toggle">pause</button>
</div>
<p class="note">Pre-rendered ASCII frame pack streamed as text — this whole ad is
{pack_kb} KB. Earnings tick only while the tab is focused and the ad is playing
(the same heartbeat the ledger will consume). Demo rate: $0.005 per completed view,
prorated per second.</p>
<script>{player_js}</script>
<script>
const pack = {pack_json};
const RATE_PER_SECOND = 0.005 / (pack.frames.length / pack.fps);
const secsEl = document.getElementById("secs");
const usdcEl = document.getElementById("usdc");
document.getElementById("meta").textContent =
  `${{pack.cols}}x${{pack.rows}} @ ${{pack.fps}}fps · ${{pack.mode}}`;

const player = new GlyphPlayer(document.getElementById("c"), pack, {{
  loop: true,
  onHeartbeat: (s) => {{
    secsEl.textContent = s;
    usdcEl.textContent = (s * RATE_PER_SECOND).toFixed(4);
  }},
}});
player.play();

const btn = document.getElementById("toggle");
btn.onclick = () => {{
  if (player.playing) {{ player.pause(); player._wasPlaying = false; btn.textContent = "play"; }}
  else {{ player.play(); btn.textContent = "pause"; }}
}};
</script>
</body>
</html>
"""


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("pack")
    p.add_argument("--out", default="demo.html")
    args = p.parse_args()

    pack_text = pathlib.Path(args.pack).read_text()
    player_js = (pathlib.Path(__file__).parent.parent / "player" / "glyph-player.js").read_text()
    html = TEMPLATE.format(
        pack_json=pack_text,
        player_js=player_js,
        pack_kb=round(len(pack_text) / 1024),
    )
    pathlib.Path(args.out).write_text(html)
    print(f"wrote {args.out} ({len(html) / 1024:.0f} KB, self-contained)")


if __name__ == "__main__":
    main()
