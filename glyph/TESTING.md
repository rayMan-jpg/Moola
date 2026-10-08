# Glyph compatibility test report

Goal: verify that (a) the ad unit can be loaded/invoked in the harnesses most
AI users actually use, and (b) the ASCII renders and plays. Branded products
can't be logged into from CI, so tests target the **rendering substrate** each
product uses; products sharing a substrate inherit the result.

## Results — 2026-10-08, all PASS

| Substrate | Products that use it | Test performed | Result |
|---|---|---|---|
| Browser canvas/HTML | Claude.ai artifacts, ChatGPT canvas, Gemini, any web UI, Cursor/Windsurf webviews | Headless Chromium (Playwright): load `demo/demo.html`, pixel-scan canvas, diff screenshots 1.5s apart, read heartbeat ticker | PASS — canvas 860x483, 9.7% lit pixels, animation advanced, 3 heartbeats fired, ticker accrued 0.0019 USDC |
| Terminal ANSI | Claude Code, Codex CLI, Gemini CLI, Aider, any terminal agent | `player/term_player.py` at every depth (truecolor / 256 / 16 / mono); full 96-frame loop timed | PASS — ANSI emitted on all rows at each depth; render cost ~9.7ms/frame (smooth at 12fps) |
| Static monospace code block | Chat replies in ChatGPT, Claude, Gemini, Copilot Chat | 72-col mono pack generated; every line asserted exactly 72 cols (fits 80-col blocks); frame exported to `demo/chat_frame.md` | PASS — 20 lines x 72 cols, wordmark legible |
| Claude Code skill | Claude Code CLI/web/desktop, Claude Agent SDK | Skill at `.claude/skills/glyph-ad/` — frontmatter validated, auto-discovered live by a running session, invoked via the Skill tool, command path executed | PASS — discovered, loaded, invoked, played (player is pure stdlib, zero installs) |
| Claude.ai hosted page | Claude app (clickable link) | Published demo as artifact | PASS — https://claude.ai/artifact/38eiLbPBe37AVvY5nbksZW |

## Caveats (honest limits of this run)

- ChatGPT/Gemini/Cursor were tested at the substrate level, not by logging
  into the branded products. A substrate pass means the content renders in
  the component those products embed; product-specific chrome (e.g. ChatGPT's
  code-block max height) still deserves a manual spot check.
- Chat code blocks are **static** — one frame, no animation. Animated
  playback needs a canvas (browser) or ANSI loop (terminal).
- Terminal playback inside an AI harness transcript plays during command
  execution; the final transcript keeps only the last drawn frame.
- The skill format tested is Claude Code's (`SKILL.md`). Codex/Gemini CLI
  equivalents (custom commands / extensions) would be thin wrappers around
  the same `term_player.py` and are not yet written.

## Reproduce

```sh
pip install opencv-python-headless numpy          # converter only; player is stdlib
python3 converter/ascii_convert.py demo/brand_ad.mp4 --cols 72 --fps 12 --mode mono \
  --out demo/brand_ad.chat.pack.json              # chat-block variant
python3 player/term_player.py demo/brand_ad.pack.json --once          # terminal
node <playwright script> demo/demo.html           # browser (see session scratchpad)
```
