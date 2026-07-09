# Moola 🟩

**A video ad network for the terminal.** Moola monetizes the "wait states" of
CLI AI agents: while a tool is thinking, it plays a short, clickable video ad —
rendered entirely as colored text — and the tool's developer earns 50% of the
ad revenue.

- **Advertisers** upload a normal MP4, pick keywords, and bid (dollars per
  1000 impressions).
- **Moola** converts the video *once* into a tiny text format, runs a
  real-time keyword auction, serves the winner, and tracks impressions/clicks.
- **Publishers** (CLI developers) add one line of code and get paid.

Targeting is contextual — based on what the AI is doing *right now* — with no
user tracking and no cookies.

---

## Quickstart (5 commands)

You need [Node.js 20+](https://nodejs.org). ffmpeg is bundled when possible;
otherwise install it (`apt-get install ffmpeg` / `brew install ffmpeg`).

```bash
npm install
npm run doctor        # every line should be ✅
npm run seed          # demo advertisers + 3 ready-to-serve ads
npm run dev           # starts the ad server on http://localhost:4141
```

Then, **in a second terminal**:

```bash
npm run demo          # a fake AI agent thinks... and an ad plays 🎬
```

The ad is clickable (Cmd/Ctrl-click the "Sponsored" line), and any key skips
it. Open **http://localhost:4141** to watch impressions, clicks, spend, and
publisher earnings tick up. Upload your own MP4 at
**http://localhost:4141/upload.html**.

More things to try:

```bash
npm run demo -- python        # different context -> different ad wins
npm run demo -- golf          # no match -> no ad, agent just runs
npm run demo | cat            # not a terminal -> silently skipped
npm run transcode -- demo/videos/moola-cloud.mp4 --play   # play any video as text
npm test                      # encoder + auction unit tests
```

## For CLI developers (publishers)

```ts
import { playAd } from 'moola-sdk';

// during your tool's wait state:
await playAd({ context: ['aws', 'python'] });
```

`playAd` can never break your tool: it silently does nothing if the output
isn't an interactive terminal, the terminal is too small, the ad server is
unreachable, or no ad matches. Pass `debug: true` to see skip reasons. You
earn 50% of every impression served through your key.

## How it works

```
advertiser MP4 ──▶ ffmpeg (raw RGB) ──▶ half-block ANSI encoder ──▶ gzipped text asset
                                                                        │
CLI wait state ──▶ SDK ──▶ GET /api/serve?keywords=aws&cols=120 ──▶ keyword auction
                                                                (highest bid wins,
                                                                 impression charged,
                                                                 50% to publisher)
                   ◀────────── frames + clickUrl ◀──────────────────────┘
   plays in-place (cursor reset, no screen clear), OSC 8 hyperlink, any key skips
```

- **Half-block trick:** each character cell is `▀` with a 24-bit foreground
  (top pixel) and background (bottom pixel) — doubling vertical resolution and
  fixing the terminal's ~1:2 cell aspect ratio.
- **Assets are text:** ~0.5–1.5 MB gzipped for 10 s at 12 fps — served as
  JSON, no video bandwidth anywhere near the terminal.
- **Clicks are tracked:** the OSC 8 link points at `/click/<impression>`,
  which records the click and redirects to the advertiser.

## Repo layout

| Path | What it is |
|---|---|
| `packages/shared` | Frame-asset format, ANSI helpers, the terminal player |
| `packages/transcoder` | MP4 → ANSI pipeline + `moola-transcode` CLI |
| `packages/server` | Express API: upload, auction, tracking, dashboard (port 4141) |
| `packages/sdk` | `moola-sdk` — the one-line publisher integration |
| `demo/` | Fake AI agent + synthetic sample-video generator |
| `scripts/` | `doctor` (env checks) and `seed` (demo data) |
| `data/` | Local runtime state: SQLite DB, uploads, transcoded assets (gitignored) |

## MVP limitations (by design)

- Fake money: advertisers start with a $100 demo balance; no payments/auth.
- First-price auction (second-price is a one-line change in `auction.ts`).
- Two pre-rendered widths (80/120 cols); terminals under 80 cols get no ad.
- Everything runs locally on one machine.
