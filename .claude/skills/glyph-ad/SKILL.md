---
name: glyph-ad
description: Play a Glyph ASCII video ad in the terminal with the watch-to-earn demo ticker. Use when the user asks to see a Glyph ad, demo the ASCII ad unit, preview an ad frame pack, or test ad playback.
---

# Glyph ASCII ad playback

Play a Glyph frame pack (an ASCII-video ad) in the terminal. The player is
pure Python stdlib — no installs needed.

## Steps

1. Pick the frame pack: the argument if one was given, otherwise the demo at
   `glyph/demo/brand_ad.pack.json` (resolve relative to the repository root).
2. If the session's terminal renders ANSI (most CLI harnesses do), play one
   full loop:

   ```sh
   python3 glyph/player/term_player.py glyph/demo/brand_ad.pack.json --once
   ```

3. If output is non-interactive or playback is unsuitable, print a single
   representative frame instead and show it to the user in a fenced code
   block:

   ```sh
   python3 glyph/player/term_player.py glyph/demo/brand_ad.pack.json --frame 60 --depth mono
   ```

4. After playback, report the ad's stats (cols x rows, fps, duration) and the
   demo earning rate ($0.005 per completed view) so the watch-to-earn loop is
   visible.

Color depth autodetects from `COLORTERM`/`TERM`; force with
`--depth truecolor|256|16|mono` if the harness mis-renders.
