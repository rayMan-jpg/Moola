# Switching on the rea4u engine

The site at https://rayman-jpg.github.io/Moola/ is already live. Until the engine is connected it
shows "Engine offline" and won't take payments. To connect it, add the secrets and variables below
to this GitHub repo, then run one workflow. It takes about 15 minutes, and none of it means pasting
keys into a chat.

## 1. What you need

| What | Where to get it | Store it as |
| --- | --- | --- |
| Claude API key with Managed Agents access | console.anthropic.com > API keys | repo **secret** `ANTHROPIC_API_KEY` |
| Cloudflare account ID | dash.cloudflare.com, right sidebar | repo **secret** `CLOUDFLARE_ACCOUNT_ID` |
| Cloudflare API token | My Profile > API Tokens > "Edit Cloudflare Workers" template, plus D1 Edit | repo **secret** `CLOUDFLARE_API_TOKEN` |
| GitHub org or user that will own the clone repos (e.g. a new org `rea4u-builds`) | github.com/organizations/new | repo **variable** `REA4U_GITHUB_OWNER` |
| GitHub token for that owner (see below) | github.com/settings/personal-access-tokens | repo **secret** `REA4U_GITHUB_TOKEN` |
| Solana wallet that receives payments | any wallet address you control | repo **variable** `TREASURY_SOLANA` |
| EVM wallet that receives Robinhood Chain payments: a plain account, not a Safe or smart wallet | any address you control | repo **variable** `TREASURY_EVM` |
| Optional: a keyed Solana RPC URL (Helius, QuickNode...) | your RPC provider | repo **secret** `SOLANA_RPC` |

You can skip one of the two treasuries. Launchpads on a chain without a treasury just won't take orders.

**GitHub token.** Create a fine-grained token with resource owner = `REA4U_GITHUB_OWNER` and access
to "All repositories". Give it these repository permissions: Administration (read/write, to create
the clone repos), Contents (read/write), Pages (read/write), Workflows (read/write) and Metadata
(read). A classic token with the `repo` and `workflow` scopes also works. This token never enters
the engine's sandbox: Anthropic's git proxy injects it outside the sandbox, and only for that job's repo.

Add these under **Settings > Secrets and variables > Actions** (one tab for secrets, one for variables).

## 2. Make the workflow visible

GitHub only lists manually-run workflows that exist on the repo's **default branch**, and that
branch is currently `claude/install-ui-ux-pro-max-3plqP`. So do one of these:
- **Settings > General > Default branch**: switch it to `claude/moola-degen-launcher`, or
- merge `claude/moola-degen-launcher` into the default branch.

## 3. Deploy

Go to **Actions > Deploy rea4u > Run workflow**, choose the `claude/moola-degen-launcher` branch,
and run it. It will:
1. run the test suite,
2. deploy the API worker to Cloudflare (the D1 database is created automatically) and set its
   secrets (`QUOTE_SECRET` is generated once and then kept),
3. wait for `/api/config` to report `ok: true`,
4. republish the site with `config.json` pointing at the API and pinning your treasury addresses.

The run summary prints the site and API URLs. Reload the site: the "Engine offline" banner is gone
and REA IT takes orders.

## 4. Where the money goes

- **Users pay exactly the Claude budget** for their tier (Lite $5, Standard $15, Deep $40, tunable
  in `shared/contract.ts`), converted to SOL or ETH at the median of the Coinbase, Kraken and Gemini
  prices. To add a markup, set the worker variable `MARGIN_PCT` (default 0); the job budget stays
  the same and the extra stays with you.
- The Claude Managed Agents session gets a **hard cap** of the payment minus a reserve (worker
  variable `RESERVE_PCT`, default 6%, minimum 50¢). The cap is checked before each model request,
  so the last request can overshoot it; the reserve keeps that inside what the user paid. When the
  cap is reached the session pauses, and the user can top up from the project page.
- Payments land directly in your treasury wallets. You pay Anthropic for the Claude usage on your
  API key, and Cloudflare/GitHub stay on their free tiers at small scale.
- **Refunds** are manual. If a job fails to start after payment, its project page says so and the
  payment is recorded in the worker's D1 database (`payments` and `jobs` tables).

## 5. Operating it

- **Watch jobs:** every job is a Managed Agents session titled `rea4u <job id>: <target>`.
  Open it at platform.claude.com > Sessions to follow the trace.
- **Change the engine:** edit `engine/system.ts`, `engine/task.ts` or the
  `.claude/skills/rea4u-reverse-engineer` skill, then push. The worker notices the config change
  and updates the agent in place on the next job. Skill and ECC playbook changes are picked up by
  the next session, because each session mounts this repo read-only.
- **Network policy:** each job gets its own sandbox environment that can reach GitHub, package
  registries and the target site (plus its subdomains), and nothing else.
- **Logs:** Cloudflare dashboard > Workers > rea4u-api > Logs.
