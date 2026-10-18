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

<!-- LAUNCHPADS -->

## Repo layout

| Path | What |
| --- | --- |
| `ecc/` | Content fork of ECC (agents, skills, commands, rules, hooks, MCP configs) pinned to an upstream commit. See `ecc/UPSTREAM.md`. |
| `ecc/upstream/dashboard-web.js` | ECC's original dashboard, kept for reference. |
| `scripts/build-catalog.mjs` | Ports ECC's dashboard loaders and emits `public/catalog.json`. |
| `scripts/sync-ecc.sh` | Re-sync the fork from upstream ECC. |
| `src/` | The site: catalog browser (degen dashboard), launcher, wallet layer, launchpad adapters. |
| `tests/unit` | Vitest unit tests. |
| `tests/sim` | Mainnet *simulation* tests: build real launch transactions and run `simulateTransaction` with a funded payer and `sigVerify:false`. Nothing is broadcast. |
| `tests/e2e` | Playwright end-to-end tests with a mock Wallet Standard wallet that simulates instead of sending. |

## Develop

```bash
npm install
npm run dev        # builds the catalog, starts Vite
npm test           # unit tests
npm run test:sim   # live mainnet simulations (network, no SOL needed)
npm run build && npm run test:e2e
```

Deploys are a static `dist/` pushed to the `gh-pages` branch.

## Disclaimer

Memecoins are extremely risky. MOOLA is an interface to third-party launchpads; it does not custody
funds, and every transaction is shown and signed in the user's own wallet. Not financial advice.
