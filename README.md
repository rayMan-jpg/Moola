# rea4u

**Reverse engineer anything. For you.**

Paste any GitHub repo, web app or website. rea4u's engine, which runs on Claude and our fork of
[ECC](https://github.com/affaan-m/ECC), rebuilds it as **your** project:

- a working, rebranded clone pushed to a fresh GitHub repo,
- a full `SPEC.md` (features, flows, data model, API, architecture, gaps),
- hosting options ranked for what the clone needs and what you want, with one-click deploys
  (static clones go live on GitHub Pages automatically).

Your project's token launches in the same order, on **pump.fun, Jupiter Studio or Bonk.fun**
(Solana) or **Pons, StonkLauncher or µToken** (Robinhood Chain).

Live: https://rayman-jpg.github.io/Moola/ · Operator setup: [`SETUP.md`](SETUP.md) · Human test script: [`HUMAN_TEST.md`](HUMAN_TEST.md)

## The flow (what a user does)

1. **Paste a target** (or tap a popular pick) and choose the depth: Lite $5, Standard $15 or Deep $40.
2. **Name your version.** A rebranded name, ticker and logo are suggested; edit them if you like.
   Names that reuse the original's brand are refused.
3. **Pick a launchpad** and a hosting vibe (budget, traffic, own domain).
4. **REA IT.** The price is the engine's Claude budget, converted to SOL or ETH at today's price.
   - Solana: **one wallet prompt** signs both the payment and the token launch (Jupiter adds a
     sign-in message first). The launch is only broadcast after the payment lands.
   - Robinhood Chain: pay, then launch (Pons and µToken: 2 prompts; StonkLauncher: 4, because
     its launch is create, approve and arm).
5. You land on the **project page**: a live engine feed and budget bar, then the repo, SPEC.md,
   ranked hosting and the token. The token's website is this page.

## How it works

```
site (GitHub Pages)  ──quote──▶  API worker (Cloudflare)  ──▶  Claude Managed Agents
   │  pay + launch                │ verifies payment on-chain       one budget-capped session per job
   ▼  (user's wallet)             │ creates the clone repo          + rea4u skill + ECC playbooks
Solana / Robinhood Chain ◀────────┘ starts / polls / tops up        → pushes clone, writes rea4u.json + SPEC.md
```

- **Quote** (`POST /api/quote`): tier price → SOL/ETH (median of Coinbase, Kraken and Gemini),
  HMAC-signed and valid for 10 minutes.
- **Payment**: a transfer to the treasury tagged with `rea4u:<quote id>` (a memo on Solana,
  calldata on Robinhood Chain). The worker checks amount, recipient, tag and timing on-chain, and
  a D1 unique key stops replays. If a wallet drops the tag, the worker answers `428 needs_claim`
  and the page asks the paying wallet to sign a free claim message naming the quote and the tx
  (accepted only for a transfer sent while the quote was valid). If a wallet speeds up or replaces
  the payment, the project page asks for the new tx hash. The site refuses quotes naming any
  treasury other than the one pinned in its own `config.json`.
- **Engine** (`worker/src/engine.ts`): one persistent Managed Agents agent (`engine/system.ts`),
  and per job its own sandbox environment (egress limited to GitHub, package registries and the
  target), plus a session with a **hard spend cap equal to the payment minus a small reserve**
  (6%, at least 50¢). The cap is checked before each model request, so the reserve covers the
  last request's overshoot. It mounts the new clone
  repo (writable via a git proxy token that never enters the sandbox) and this repo read-only, for
  the `rea4u-reverse-engineer` skill and the ECC playbooks. It's kicked off with a
  `user.define_outcome` whose rubric (`engine/task.ts`) a separate grader enforces.
- **Results**: `rea4u.json` and `SPEC.md` come back through the Files API. Static clones get
  GitHub Pages switched on. When the budget runs out the session pauses; a paid top-up raises the
  budget and it resumes where it stopped.
- **Guardrails**: public information only, licence-respecting forks or clean-room rebuilds, full
  rebranding, and refusal of clones useful mainly for impersonation or fraud (`engine/system.ts`).

## Launchpads

| Launchpad | Chain | How rea4u launches | Prompts (incl. payment) |
| --- | --- | --- | --- |
| **pump.fun** | Solana | official `@pump-fun/pump-sdk` `create_v2` (PumpPortal fallback) | 1 |
| **Jupiter Studio** | Solana | Jupiter's Studio API (Meteora DBC, USDC curve) | 2 (sign-in + 1) |
| **Bonk.fun** | Solana | bonk.fun's `createMint` builder (Raydium LaunchLab) | 1 |
| **Pons** | Robinhood Chain | Pons v2 factory `launchToken` / `launchAndBuy` | 2 |
| **StonkLauncher** | Robinhood Chain | StonkBrokers Smart Launch V2 pad: `createLaunch`, `approve`, `arm` (degen mode, flat 1%) | 4 |
| **µToken** | Robinhood Chain | utoken.gg `TokenLaunchFactory.prepareAndLaunch`, plain token, metadata on-chain | 2 |

Every Solana launch transaction passes the fail-closed guard in `src/launchpads/guard.ts`
(program and instruction allowlist plus a mainnet simulation of what it spends) before the wallet
sees it. Robinhood Chain launches are simulated from the user's address first: Pons and µToken
with `eth_call`, StonkLauncher with all three steps chained in `eth_simulateV1`. A StonkLauncher
token only counts as launched once its `arm` transaction is confirmed.

Note: **stonk.broker** is the page of a single token (uSTONK) on **µToken** (utoken.gg).
"StonkLauncher" is a different launchpad, StonkBrokers' (stonkbrokers.io/launcher). Both are
integrated.

## Repo layout

| Path | What |
| --- | --- |
| `src/` | The site: order form (`order.ts`), money path (`checkout.ts`), project page (`project.ts`), engine room (`engineRoom.ts`), wallets (`wallet.ts` Solana, `evm/chain.ts` Robinhood Chain), launchpad adapters (`launchpads/`). |
| `shared/` | Types and pure logic used by both site and worker: quotes, targets, brand checks, hosting recommender. |
| `worker/` | Cloudflare Worker API: quotes, payment verification, jobs (D1), Managed Agents engine. |
| `engine/` | The agent's system prompt, the per-job task, and the outcome rubric. |
| `.claude/skills/rea4u-reverse-engineer/` | The method the engine follows, plus schema-checked deploy templates. |
| `ecc/` | Content fork of ECC (agents, skills, commands, rules), pinned upstream; `ecc/INDEX.md` is the engine's map. |
| `tests/unit` | Vitest: contract, quotes, payment verification on real transaction shapes, job lifecycle, SDK request shapes, hosting, and the earlier launch guard tests. |
| `tests/live` | Mainnet simulations: payments, Pons, StonkLauncher, pump.fun, Jupiter, Bonk.fun. Nothing is broadcast. |
| `tests/e2e` | Playwright: the real UI, the real worker code in-process, mock wallets, every transaction simulated on mainnet. |

## Develop

```bash
npm install
npm run dev          # site (engine shows offline unless public/config.json points at an API)
npm run worker:dev   # API worker locally (wrangler dev), then open the site with ?api=http://localhost:8787
npm test             # unit tests (site + worker)
npm run test:sim     # live mainnet simulations (network, no funds needed)
npm run build && npm run test:e2e
```

Deploy: Actions > **Deploy rea4u** (see [`SETUP.md`](SETUP.md)). A site-only redeploy is
`./scripts/deploy-pages.sh`, which keeps the live `config.json`.

## Disclaimer

Clones are for learning, prototyping and building your own take. They're never meant to pass
themselves off as the original. Tokens are extremely risky. rea4u doesn't custody funds; every
transaction is shown and signed in the user's own wallet. Not financial advice.
