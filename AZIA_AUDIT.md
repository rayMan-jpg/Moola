# AZIA supply audit — Arc mainnet

Read-only snapshot of AZIA token holdings across two known wallet clusters.
No transactions were sent and no private keys were used or stored.

## Chain and token, verified on-chain

| Fact | Value | How verified |
|---|---|---|
| Network | Arc mainnet (Circle L1) | `eth_chainId` = `0x13b2` = **5042** |
| RPC | `https://rpc.mainnet.arc.io` | from docs.arc.io `connect-to-arc` |
| Token | `0x4b919197c5570dbb14527049d42636dfcf659901` | `eth_getCode` → 4,724 bytes |
| Name / symbol | `Arcenzia` / `AZIA` | `name()` / `symbol()` |
| Decimals | **18** | `decimals()` — matches expectation |
| Total supply | **1,000,000,000** (1e27 wei) | `totalSupply()` — matches expectation |
| Snapshot block | **21232614** | `eth_blockNumber`, pinned for all reads |
| Multicall3 | deployed at `0xcA11bde05977b3631167028862bE2a173976CA11` | `eth_getCode` |

Chain ID was checked on all four documented public endpoints
(`rpc.mainnet`, `rpc.drpc.mainnet`, `rpc.blockdaemon.mainnet`,
`rpc.quicknode.mainnet`) and all returned 5042.

## Results at block 21232614

```
200 generated wallets hold 809,424,376.06 tokens = 80.94% of total supply at block 21232614
 26 ops wallets       hold   4,600,280.50 tokens =  0.46% of total supply at block 21232614
--------------------------------------------------------------------------------------------
226 wallets combined  hold 814,024,656.56 tokens = 81.40% of total supply at block 21232614
```

Remainder outside both clusters: **185,975,343.44 AZIA (18.60%)**, of which
`0x8366a39cc670b4001a1121b8f6a443a643e40951` alone holds ~171.97M (17.20%).

### Distribution — 200 generated wallets

All 200 are funded; **zero wallets hold a zero balance**.

| Stat | Tokens | Address |
|---|---|---|
| Largest | 42,604,375.5773 | `0x9230C0E59643Cd6d136F206C8Ec6048C3356Db69` |
| Smallest | 272,864.3686 | `0xB8223242294A21d032063C80be1e72ab2FCcf3C9` |
| Median | 1,302,389.9548 | — |
| Mean | 4,047,121.8803 | — |

### Distribution — 26 ops wallets

**22 of 26 are drained to zero**; only 4 remain funded.

| Stat | Tokens | Address |
|---|---|---|
| Largest | 1,528,831.5416 | `0x34aEdAE9FC7FFC600CD2fE300e7f0880cB403311` |
| Smallest (funded) | 522,896.0037 | `0x2C16F999e45727333BD3A75e660e563F1D6E13B3` |
| Median (funded only) | 1,274,276.4777 | — |
| Median (incl. zeros) | 0 | — |

## Cross-checks

1. **Explorer agreement** — all 226 wallets' balances matched the
   arcexplorer.org holders API exactly. **Zero mismatches.**
2. **Supply reconciliation** — the explorer's full holder set (269 non-zero
   holders, paginated) sums to exactly 1e27 wei, matching `totalSupply()` with
   0 wei delta. The `holderCount` of 281 includes ~12 zero-balance historical
   holders, which the holders endpoint omits.
3. **Codec verification** — 8 wallets were re-read with plain single
   `eth_call`s at the same pinned block, bypassing the hand-rolled Multicall3
   ABI encoding entirely. All 8 matched to the wei.

### Caveat on the explorer cross-check

The explorer API serves *live* balances, not balances at the pinned block, so
it is a same-value comparison only for wallets that did not move during the
sweep. All 226 audited wallets were static. The largest overall holder was
*not* static — it read 172,006,768.64 at first contact and 171,970,534.32
minutes later — so treat the 18.60% remainder as a moving figure. The 81.40%
cluster total is exact as of block 21232614.

## Reproducing

```bash
python3 azia_supply_audit.py    # requires only `requests`
```

The script pins `latest` at start, verifies chain ID / decimals / total supply
before trusting any of them, uses Multicall3 `aggregate3` in chunks of 50 with
automatic fallback to JSON-RPC batching then sequential calls, retries with
exponential backoff, and rate-limits between chunks. The whole 226-wallet
sweep costs 14 RPC requests.

Inputs: `generated_wallets.txt` (200), `launchpad_ops_wallets.txt` (26).
Outputs: `azia_generated_balances.csv`, `azia_ops_balances.csv`.

## Verification of the 81.40% figure

The headline was independently re-derived by two paths that share no code:

| Path | Method | Generated 200 | Ops 26 | Combined |
|---|---|---|---|---|
| A | 226 plain single `eth_call`s — no Multicall3, no hand-rolled ABI codec | 80.942438% | 0.460028% | **81.402466%** |
| B | arcexplorer.org holders API only — zero RPC involvement | 80.942438% | 0.460028% | **81.402466%** |

Per-wallet disagreement between A and B: **0 of 226**.

### Closure test (the decisive check)

Double-counting and missed holders are the two ways a share-of-supply number
goes wrong. Both are ruled out by closing the books against total supply:

```
input integrity : 200 unique + 26 unique, intersection EMPTY (no double counting)
audited non-zero:  204 holders   814,024,656.56  =  81.402466%
non-audited     :   65 holders   185,975,343.44  =  18.597534%
                   ---------- -----------------    -----------
total           :  269 holders 1,000,000,000.00  = 100.000000%
closure delta   :  0 wei
```

269 non-zero holders is the complete holder set, and it sums to `totalSupply()`
exactly. So the 81.40% is not an estimate over a partial holder list — the
complement is fully enumerated.

### Why 81% is the expected shape

The concentration is explained by the **liquidity pool**, which sits outside both
clusters (see the correction below - this address is the AMM, not a holder):

| Rank | Address | Tokens | Share |
|---|---|---|---|
| 1 | `0x8366a39cc670b4001a1121b8f6a443a643e40951` **(V4 PoolManager)** | ~171.97M | 17.20% |
| 2 | `0x8f5f726e22d6aac6e04eebd35121fa49b4116067` | ~6.41M | 0.64% |
| 3 | `0xcbdd38195130eea6b04af3a5cca56670a7c4c92a` | ~4.25M | 0.43% |
| 4–65 | 62 further holders | ~3.35M | 0.34% |

The 200 generated wallets average 4,047,121.88 tokens each; 200 × 4.047M =
809.42M, which is the reported total. One ~17.2% treasury-shaped holder plus a
long tail of 64 small holders accounts for the entire 18.60% remainder.

## Two RPC limitations found while verifying

Neither affects the numbers above, but both matter for re-running:

1. **Per-element rate limiting.** `https://rpc.mainnet.arc.io` rejects
   individual elements inside a JSON-RPC batch with `-32005 rate limit
   exceeded` — a 25-element batch came back with 11 rejected. The Multicall3
   path never hits this (5 requests for 226 wallets), but the batched fallback
   did. `Rpc.batch()` and `Rpc.call()` now retry rate-limited elements with
   backoff instead of dropping them.
2. **No archive state.** State is pruned: `eth_call` at `block-30000` returns
   `0x` while `block-2000` and `block-10000` still resolve. The pinned-block
   snapshot is therefore only valid inside the retention window, so the script
   now probes retention and warns. Re-run it rather than reusing an old block
   number.

---

## CORRECTION: the 17.2% holder is the liquidity pool

An earlier revision of this document described
`0x8366a39cc670b4001a1121b8f6a443a643e40951` as a treasury/fee sink and
concluded AZIA had no liquidity. **Both conclusions were wrong.** It is a
**Uniswap V4-style singleton PoolManager**, and its AZIA balance is the AMM's
token-side reserve.

### Why the first pass missed it

A V4 singleton holds every pool's tokens in one contract, keyed internally by
pool id. It therefore exposes **no** `token0()`, `token1()`, `getReserves()`,
`slot0()` or `factory()` — the V2/V3 pair probes all revert, which reads as
"not a pool" if those are the only interfaces tested. Compounding it,
arcexplorer.org's DEX indexer returns **0 matching pools** for AZIA out of
21,785 indexed, and reports `priceUsd`, `liquidityUsd` and
`pricingPoolAddress` as `null`. Two independent sources agreeing on "no
market" were both simply blind to this venue.

### What identifies it

| Probe | Result |
|---|---|
| `extsload(bytes32)` slot 0 | returns `0xbca30b54…` (owner) — V4 PoolManager hallmark |
| `protocolFeeController()` | resolves (zero) |
| `protocolFeesAccrued(address)` | resolves (zero) |
| `owner()` | `0xbca30b5429935205037069cf5b8a165f55d05a75` |
| Balancer `getPoolTokens` / `getVault` | revert (not Balancer) |
| Bytecode | 24,009 bytes; holds 46,322 distinct tokens; 0 outbound txs |

### Reserve arithmetic closes

At a market price of $0.0001366 (mcap $136.6K, supply 1.00B):

```
vault AZIA balance      171,969,865.50
x price                 $23,491.08
reported TVL / 2        $23,400.00      (venue shows Liquidity $46.8K)
ratio                   1.0039          -> the vault's AZIA IS the pool reserve
```

### Consequence: the float, and the realizable ceiling

The 18.60% "non-audited remainder" is 17.20% pool reserve plus a **1.40% real
float** across 64 EOAs. Dumping that float into the pool
(constant-product, 0.30% fee):

| Scenario | Tokens | Mcap after | Change | Realized USD |
|---|---|---|---|---|
| Outside float only | 14,005,478 | $116,374 | −14.48% | $1,757 |
| Float + 10% of the 226 | 95,407,944 | $56,349 | −58.59% | $8,334 |
| Float + 25% of the 226 | 217,511,642 | $26,572 | −80.47% | $13,051 |
| Float + 50% of the 226 | 421,017,806 | $11,468 | −91.57% | $16,599 |
| Float + all 226 | 828,030,134 | $4,034 | −97.04% | $19,366 |

The realized column converges on the pool's quote depth: **no sequence of
sales can extract more than the ~$23.4K of USDC in the pool.** An 81.40%
position marked at $111.2K has a realizable value near $19K. Market cap here
is price x supply, not a redeemable quantity.

Both figures are best cases. The model assumes full-range constant product; V4
concentrated liquidity produces sharper impact once price leaves the active
range, and the 17 pools fragment depth further.

### Third-party confirmation of the audit

The Chipper terminal independently reports **Holders 269** and **Holding
81.4%** for this wallet set — matching this audit's 269 non-zero holders and
81.40% exactly, from a separate data pipeline.
