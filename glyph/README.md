# Glyph — ASCII video ad platform (Phase 1: creative pipeline)

Watch-to-earn platform where users are paid a share of ad revenue in USDC for
verified attention on ASCII-video ads. This directory is **Phase 1** of the
plan: prove the ASCII ad unit itself — converter, playback, and a
sponsor-ready demo — before building the earnings ledger, wallets, and payout
rails.

## What's here

```
converter/ascii_convert.py   video (MP4 etc.) -> ASCII "frame pack" JSON
converter/build_demo.py      frame pack -> single-file sponsor preview HTML
player/glyph-player.js       dependency-free <canvas> player + watch heartbeats
demo/brand_ad.mp4            synthetic 8s brand ad (ffmpeg-generated stand-in)
demo/brand_ad.pack.json      the converted frame pack
demo/demo.html               self-contained preview — open in any browser
```

All original MIT-clean code. No ASCILINE dependency (its license forbids
advertising use).

## Pipeline

```
advertiser MP4
  └─ ascii_convert.py     ffmpeg/OpenCV decode -> per-cell luminance -> charset
     │                    map + k-means 16-color adaptive palette
  frame pack (JSON)       pre-rendered text frames; client does zero conversion
  └─ glyph-player.js      canvas playback @ target fps, same-color run batching
     │                    emits per-second watch heartbeats; auto-pauses on
     │                    tab blur (hidden tabs never accrue watch time)
  └─ build_demo.py        embeds pack + player into one shareable HTML file
```

## Usage

```sh
pip install opencv-python-headless numpy
python3 converter/ascii_convert.py ad.mp4 --cols 96 --fps 12 --mode color --out ad.pack.json
python3 converter/build_demo.py ad.pack.json --out preview.html
```

Options: `--mode mono` (single accent color), `--palette ansi16` (fixed
palette), `--charset`, `--max-seconds`.

## Why this might actually work (measured, not vibes)

- **Legibility:** brand wordmarks render clearly at 96 cols (see
  `demo/demo.html`). Adaptive palette preserves brand colors.
- **Bandwidth:** the 8s demo pack is 497KB raw, **38KB gzipped (~4.9KB/s)** —
  ~4x lighter than the already-small source MP4. ASCII ads are viable on 2G/3G
  connections in the target markets.
- **Verification hook:** the player emits per-second heartbeats only while
  playing and focused — the primitive the earnings ledger consumes.

## Roadmap (from the project plan)

1. ✅ **Creative pipeline** (this directory)
2. Core loop: PWA ad feed, watch verification service, off-chain earnings
   ledger, Privy embedded wallets (non-custodial — avoids MSB/MTL licensing),
   testnet USDC settlement on Base
3. First revenue: 2–3 hand-sold brand sponsorships (flat pilot packages)
4. Mainnet USDC + licensed fiat off-ramp partner (Transak) + single-market
   launch

Guardrail: payout per view ≤ 50% of sponsor revenue per view, post-fraud.
Kill criteria: demo fails with brands, or <$1k pilot revenue after 4 weeks of
selling.
