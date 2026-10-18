# MOOLA

**Any AI agent. One click. Now it's a coin.**

MOOLA is a degen fork of [ECC](https://github.com/affaan-m/ECC) (the agent harness by affaan-m, MIT).
It takes ECC's whole arsenal (71 agents, 311 skills, 97 commands, 22 rule sets), re-skins ECC's
browser dashboard as a neon meme casino, and turns every item into a ready-to-launch Solana coin:
name, ticker, logo and lore are generated for you, and you launch on an existing launchpad with
**one wallet signature**.

Live: https://rayman-jpg.github.io/Moola/

## The flow (what a user does)

1. Click **Meme it** on any agent (or keep the default, or type your own name + ticker).
2. Pick a launchpad (pump.fun is the default) and an optional dev buy.
3. Hit **SEND IT**: connect wallet (first time only) and approve **one** transaction.

The logo is drawn on a canvas (no upload needed), metadata is pinned for you, the transaction is
built against the launchpad's own on-chain program, and your wallet signs it. MOOLA has no backend
and never sees keys or funds.

## Launchpads

| Launchpad | How MOOLA builds the launch | Wallet prompts | Dev buy | Approx. cost |
| --- | --- | --- | --- | --- |
| **pump.fun** (default, ~97% of Solana launches) | Official `@pump-fun/pump-sdk` `create_v2` (+ `buy_v2`) built in the browser; PumpPortal's builder as fallback | 1 | yes | ~0.006 SOL + dev buy |
| **Jupiter Studio** | Jupiter's keyless Studio API (Meteora DBC, USDC curve, "Meme" preset); Jupiter broadcasts and publishes the metadata | 2 (auth message + tx) | no | ~0.028 SOL |
| **Bonk.fun** | bonk.fun's own `createMint` builder (Raydium LaunchLab, vanity `...bonk` mint) | 1 | yes | ~0.021 SOL + dev buy |

Logo + metadata are pinned to Arweave through ArDrive Turbo's free tier using a throwaway signing key,
so there's no API key, account or extra wallet prompt. Every transaction is checked before the wallet
sees it: right fee payer and signers, a per-launchpad **program allowlist** (`src/launchpads/guard.ts`),
and a mainnet simulation (so empty wallets get "not enough SOL" instead of a failing transaction).

Not integrated: Bags (its API blocks browser origins), StonkFun (closed backend), Believe, Boop,
Heaven and Moonit (inactive as of Oct 2026).

Human test checklist: [`HUMAN_TEST.md`](HUMAN_TEST.md).

## Repo layout

| Path | What |
| --- | --- |
| `ecc/` | Content fork of ECC (agents, skills, commands, rules, hooks, MCP configs) pinned to an upstream commit. See `ecc/UPSTREAM.md`. |
| `ecc/upstream/dashboard-web.js` | ECC's original dashboard, kept for reference. |
| `scripts/build-catalog.mjs` | Ports ECC's dashboard loaders and emits `public/catalog.json`. |
| `scripts/sync-ecc.sh` | Re-sync the fork from upstream ECC. |
| `src/` | The site: catalog browser (degen dashboard), launcher, wallet layer, launchpad adapters. |
| `tests/unit` | Vitest unit tests. |
| `tests/live` | Mainnet *simulation* tests: real uploads and real builder transactions, run through `simulateTransaction` with a funded payer and `sigVerify:false`. Nothing is broadcast. |
| `tests/e2e` | Playwright end-to-end tests with a mock Wallet Standard wallet that simulates instead of sending. |

## Develop

```bash
npm install
npm run dev        # builds the catalog, starts Vite
npm test           # unit tests
npm run test:sim   # live mainnet simulations (network, no SOL needed)
npm run build && npm run test:e2e
```

Deploy: `./scripts/deploy-pages.sh` (builds and force-pushes `dist/` to the `gh-pages` branch).

## Disclaimer

Memecoins are extremely risky. MOOLA is an interface to third-party launchpads; it does not custody
funds, and every transaction is shown and signed in the user's own wallet. Not financial advice.
