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
