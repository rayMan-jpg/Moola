# rea4u human test script

**URL:** https://rayman-jpg.github.io/Moola/

Already tested automatically, with nothing broadcast:
- the payment and launch transactions for all five launchpads, simulated on Solana and Robinhood
  Chain mainnet;
- the full order flow in a real browser, with the API's own code checking each payment;
- the engine's calls to Claude Managed Agents, checked request by request against the SDK.

A human needs to cover the parts that use a real wallet, real money and a real engine run.

## Part A: before the engine is connected (no money)

Until the operator finishes `SETUP.md`, the site shows **Engine offline** and the button reads
ENGINE OFFLINE. Check:

1. The page loads on desktop and phone, with the target prefilled as `affaan-m/ECC` and a
   suggested name, ticker and logo.
2. Tapping a popular pick (Excalidraw, Calendly...) changes the target and the info line. GitHub
   repos show stars, licence and either "license-respecting fork" or "clean-room rebuild".
3. **Reroll name + logo** gives a new suggestion. Typing your own name stops suggestions from
   overwriting it.
4. Type a name containing the original's brand (for `affaan-m/ECC`, try `ECC Pro`) and hit the
   button: you get an inline error under the name.
5. Type `localhost:3000` as the target: you get an inline error saying it's not public.
6. Switching launchpads updates the summary: the currency (SOL or ETH), the cost hint and the
   number of wallet prompts (1 / 2 / 1 / 2 / 4 / 2).
7. The engine room at the bottom lists the ECC agents, with those "used every job" first, and
   **Read playbook** opens one.

## Part B: real orders (after `SETUP.md`)

Use **burner wallets** and the **Lite** tier ($5 job budget).
- Solana: Phantom (or Solflare or Backpack) with about $5 of SOL for the job plus ~0.03 SOL for
  launch costs.
- Robinhood Chain: MetaMask, Rabby or Phantom with about $5 of ETH plus ~0.001 ETH.

### Test 1: pump.fun, the main path

1. Keep `affaan-m/ECC`, pick **Lite**, keep the suggested name and ticker, and leave pump.fun and
   no dev buy selected.
2. Hit **REA IT**, connect the wallet, and approve **one** prompt that contains **two**
   transactions. Before approving, check the preview: one SOL transfer to the rea4u treasury for
   the quoted amount, plus the pump.fun launch (~0.006 SOL).
3. The steps run through. You land on the **project page** (`#/p/q_...`):
   - The badge says BOOTING, then REA-ING.
   - The engine feed starts filling within a minute or two.
   - The budget bar starts moving.
   - **$TICKER is live**, with an "Open on pump.fun" link. On pump.fun, the coin's website is this
     project page.
4. Keep the page open, or come back to it later; it keeps updating. A Lite job usually takes
   10 to 40 minutes. When it's done:
   - The badge says DONE.
   - "What you got" lists the stack, the features and the build status.
   - The SPEC.md section renders.
   - **Hosting, ranked for you** shows deploy buttons. For a static clone, GitHub Pages shows
     "Open live site".
   - **Open the repo** shows the clone with SPEC.md, README.md and rea4u.json.
5. Try one deploy button (Netlify or Cloudflare for a static clone, Render for a server) and note
   whether it deployed.

### Test 2: Robinhood Chain on Pons

Pick **Pons** and run a Lite order on any small target. Expect prompt 1, the payment (an ETH
transfer to the treasury; the wallet may show "hex data"), then prompt 2, the launch (0.0005 ETH
fee). "Open on Pons" should open `ponsfamily.com/launchpad/<token>`.

### Test 3: StonkLauncher

Pick **StonkLauncher**. Expect 4 prompts: the payment, then create, approve and arm. The project
page should link `stonkbrokers.io/safe-launch/token/weth2-<ticker>-<id>`.

### Test 3b: µToken (the launchpad behind stonk.broker)

Pick **µToken**. Expect 2 prompts: the payment, then one launch transaction (~$0.40 gas). "Open on
µToken" should open `utoken.gg/token/<token>`. Report whether the token shows up on utoken.gg:
tokens created this way should be indexed, but nobody has seen it happen yet.

### Test 4: Jupiter Studio and Bonk.fun (optional)

Jupiter: prompt 1 is a free sign-in message, then one prompt with two transactions.
Bonk.fun: one prompt.

### Test 5: unhappy paths

- **Reject** the wallet prompt. You should see "nothing was paid or launched", and the button
  should work again.
- Use an **empty wallet**. You should get "need ~X SOL" **before** any prompt.
- Use a **smart-contract wallet** on Robinhood Chain (e.g. Coinbase Smart Wallet). It should be
  refused before payment.
- On a **phone without a wallet**, hit REA IT. You should get "Open in Phantom/Solflare/Backpack"
  (or MetaMask etc. for Robinhood Chain), and the order should reopen inside the wallet with your
  choices filled in.
- **My reas** (header) should list your orders. Opening one goes to its project page.
- If a job runs out of budget (OUT OF BUDGET), top up **+$5** from the project page. The badge
  should go back to REA-ING.
- If the token launch failed or you closed the tab mid-launch, the project page offers
  **Launch $TICKER now** at no extra charge. Use the wallet that paid.

## What to report

For each test: pass or fail, wallet and browser (or phone), launchpad, the project page link, the
token link, and a screenshot of any error or of anything in the wallet preview that looked off.
For finished jobs, also say how good the clone and SPEC.md are, and whether a deploy button worked.
