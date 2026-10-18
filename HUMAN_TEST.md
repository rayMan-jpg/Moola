# MOOLA human test script

**URL:** https://rayman-jpg.github.io/Moola/

Everything up to the wallet signature has been tested automatically against live Solana mainnet:
the metadata uploads, each launchpad's real transaction builder, and a mainnet simulation of the
exact signed transaction. What's left for a human is the part that needs a real wallet and real SOL.

## What you need

- Desktop Chrome or Brave with **Phantom** (and if you can, also Solflare or Backpack), or the Phantom mobile app.
- A **fresh wallet** holding about **0.1 SOL**. Use a burner, not your main wallet.
- About 10 minutes.

Approximate cost per launch, with no dev buy:

| Launchpad | Cost | Wallet prompts |
| --- | --- | --- |
| pump.fun | ~0.006 SOL (rent + fee) | 1 |
| Jupiter Studio | ~0.028 SOL (rent) | 2 (message, then tx) |
| Bonk.fun | ~0.021 SOL (rent + Metaplex fee) | 1 |

## Test 1: happy path on pump.fun (the main one)

1. Open the URL. You should see a default coin already filled in (Code Reviewer / $CODE) with a generated logo.
2. In **The Arsenal**, click **Meme it** on any agent. The name, ticker, logo and lore should change, and the page should scroll to the launch pad.
3. Leave **pump.fun** selected and set the dev buy to **none**.
4. Click **CONNECT + SEND IT** (on a phone it's also pinned to the bottom of the screen).
   - With one wallet installed, its connect popup opens straight away. With several, a picker shows first.
5. Approve the connection, then approve **one** transaction. Before approving, check what the wallet shows: roughly 0.006 SOL leaving, and no unknown programs or transfers to strangers. Sign within about 30 seconds, because the transaction expires.
6. The progress steps should complete and you should see **"$TICKER IS LIVE"** with the contract address.
   - **"IS SENT"** means it was broadcast but the public RPC hasn't confirmed it yet. Check the tx link before launching again.
7. Click **Open on pump.fun**. The coin page should load with the right name, ticker and logo. The logo can take up to a minute to appear on pump.fun.
8. Note the contract address and the transaction link.

## Test 2: dev buy

Repeat Test 1 with a **0.01** custom dev buy. In the wallet preview, you should be buying the coin in the same transaction. After the launch, the wallet should hold the new token.

## Test 3: Jupiter Studio

1. Select **Jupiter Studio**. The dev buy chips should be disabled, with a note saying Jupiter has no dev buy.
2. Click **SEND IT**. Expect prompt 1, **Sign message** (free, it proves you own the wallet), then prompt 2, the transaction (~0.028 SOL).
3. You should land on the success screen. **Open on Jupiter Studio** should open `jup.ag/tokens/<mint>`; it can take a minute for it to show up there.

## Test 4: Bonk.fun

Select **Bonk.fun** and launch. Expect 1 prompt costing ~0.021 SOL. The mint address usually ends in `bonk`, and **Open on Bonk.fun** goes to `bonk.fun/token/<mint>`.

## Test 5: unhappy paths (no SOL needed)

- **Reject** the wallet prompt. The page should say you rejected it, no SOL should move, and the button should work again.
- Use an **empty wallet**. The page should say "not enough SOL" **before** any transaction prompt.
- **Clear the name** and hit SEND IT. You should get an inline error and no prompts.
- On a **phone browser without a wallet**, type a custom name and ticker and hit SEND IT. You should get "Open in Phantom / Solflare / Backpack" buttons. They should reopen MOOLA inside that wallet's browser **with your coin details already filled in** (an uploaded picture needs re-uploading), and the launch should work from there.
- **Take longer than about a minute** in the wallet prompt before approving. You should get "expired while it waited in your wallet. nothing was sent", and nothing should be charged.
- **Switch accounts** in the wallet while MOOLA is open. The header should update to the new address.
- Click your **wallet address** in the header. You should get Copy address / Disconnect options.
- **Upload your own picture** (png/jpg/gif/webp under 4 MB). It should replace the generated logo and show up on the launchpad after launch.

## Known things to expect

- Your wallet might show a "new or unknown site" warning, because the domain is new. Read the transaction preview, then decide.
- Ledger and other hardware wallets can't do the Jupiter Studio sign-in message. Use a hot wallet for Jupiter.
- If anything looks off before the wallet prompt, MOOLA blocks it on purpose with "Aborted before your wallet saw it". MOOLA checks every launch transaction against an allowlist, plus a mainnet simulation of what it spends. Screenshot that error if you see it.

## What to report

For each test, report: pass or fail, the wallet and browser (or phone), the launchpad, the contract address,
the transaction link, and a screenshot of any error message or anything in the wallet preview that looked off.
