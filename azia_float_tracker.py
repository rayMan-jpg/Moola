#!/usr/bin/env python3
"""
Track the AZIA outside float - every address that has ever held AZIA and is
not one of our 226 wallets, the V4 pool, or the LP seeder.

Reconstructs each wallet's realised trades against the pool (tokens and the
exact USDC leg, read from Arc's native-USDC system emitter), writes a
timestamped snapshot, and diffs against the previous snapshot so repeat runs
answer one question: who sold, how much, and at what price.

Read-only. No transactions, no keys.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
from datetime import datetime, timezone
from decimal import Decimal as D, getcontext

import requests

getcontext().prec = 50
E = D(10) ** 18

RPC = os.environ.get("ARC_RPC_URL", "https://rpc.mainnet.arc.io")
EXPLORER = "https://arcexplorer.org/api/v1"
CHAIN_ID = 5042

TOKEN = "0x4b919197c5570dbb14527049d42636dfcf659901"
POOL = "0x8366a39cc670b4001a1121b8f6a443a643e40951"      # UniV4-style PoolManager
SEEDER = "0x20eead6db6b3d0a4491e9073119dd0ebff166acc"     # initial LP provider
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
USDC_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe"  # Arc logs native USDC here
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

HERE = os.path.dirname(os.path.abspath(__file__))
SNAP_DIR = os.path.join(HERE, "float_snapshots")
CACHE = os.path.join(HERE, ".azia_receipt_cache.json")
RETRYABLE = {-32005}
MAX_RETRIES = 6


def log(m=""):
    print(m, flush=True)


# ------------------------------------------------------------------ rpc / codec

S = requests.Session()
S.headers.update({"content-type": "application/json"})


def rpc(method, params):
    for attempt in range(MAX_RETRIES):
        try:
            r = S.post(RPC, data=json.dumps(
                {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}),
                timeout=60)
            if r.status_code in (429, 500, 502, 503, 504):
                raise RuntimeError(f"HTTP {r.status_code}")
            j = r.json()
            if "error" not in j:
                return j["result"]
            if j["error"].get("code") not in RETRYABLE:
                raise RuntimeError(f"{method}: {j['error']}")
        except requests.RequestException as exc:
            log(f"    ! {exc}")
        time.sleep(0.4 * (attempt + 1))
    raise RuntimeError(f"{method} failed after {MAX_RETRIES} attempts")


def enc_addr(a):
    return bytes(12) + bytes.fromhex(a[2:])


def multicall_balances(addrs, block_hex, chunk=50):
    """balanceOf for many addresses at one block via Multicall3.aggregate3."""
    out = {}
    for i in range(0, len(addrs), chunk):
        part = addrs[i:i + chunk]
        els = []
        for a in part:
            cd = bytes.fromhex("70a08231") + enc_addr(a)
            els.append(enc_addr(TOKEN)[12:].rjust(32, b"\0") + (1).to_bytes(32, "big")
                       + (0x60).to_bytes(32, "big")
                       + len(cd).to_bytes(32, "big") + cd + bytes((-len(cd)) % 32))
        offs, cur = [], 32 * len(els)
        for el in els:
            offs.append(cur.to_bytes(32, "big"))
            cur += len(el)
        body = ((0x20).to_bytes(32, "big") + len(els).to_bytes(32, "big")
                + b"".join(offs) + b"".join(els))
        res = rpc("eth_call", [{"to": MULTICALL3, "data": "0x82ad56cb" + body.hex()},
                               block_hex])
        raw = bytes.fromhex(res[2:])
        n = int.from_bytes(raw[32:64], "big")
        base = 64
        for k in range(n):
            off = int.from_bytes(raw[base + 32 * k:base + 32 * k + 32], "big")
            p = base + off
            ok = int.from_bytes(raw[p:p + 32], "big") == 1
            bo = int.from_bytes(raw[p + 32:p + 64], "big")
            bp = p + bo
            bl = int.from_bytes(raw[bp:bp + 32], "big")
            if not ok or bl < 32:
                raise RuntimeError(f"balanceOf failed for {part[k]}")
            out[part[k].lower()] = int.from_bytes(raw[bp + 32:bp + 64], "big")
        log(f"  balances {min(i + chunk, len(addrs))}/{len(addrs)}")
        time.sleep(0.12)
    return out


# ---------------------------------------------------------------- explorer data

def all_transfers():
    items, off = [], 0
    while True:
        r = S.get(f"{EXPLORER}/tokens/{TOKEN}/transfers",
                  params={"limit": 100, "offset": off},
                  headers={"accept": "application/json"}, timeout=45)
        r.raise_for_status()
        j = r.json()
        it = j.get("items", [])
        items.extend(it)
        nxt = j.get("nextOffset")
        if not it or nxt is None or nxt == off:
            break
        off = nxt
        time.sleep(0.2)
    return items


def usdc_legs(tx_hash, cache):
    """(from, to, amount) for every native-USDC transfer inside a tx."""
    if tx_hash in cache:
        return [tuple(x) for x in cache[tx_hash]]
    rec = rpc("eth_getTransactionReceipt", [tx_hash])
    legs = []
    for lg in (rec or {}).get("logs", []):
        if (lg["address"].lower() == USDC_EMITTER and lg["topics"]
                and lg["topics"][0].lower() == TRANSFER_TOPIC):
            legs.append(("0x" + lg["topics"][1][-40:].lower(),
                         "0x" + lg["topics"][2][-40:].lower(),
                         int(lg["data"], 16)))
    cache[tx_hash] = legs
    time.sleep(0.07)
    return legs


# --------------------------------------------------------------------- reporting

def fmt(x, dp=2):
    return f"{x:,.{dp}f}"


def main():
    if not os.path.exists(os.path.join(HERE, "float_wallets.txt")):
        raise SystemExit("float_wallets.txt missing - run the audit first")
    tracked = [l.strip().lower() for l in open(os.path.join(HERE, "float_wallets.txt"))
               if l.strip()]

    cid = int(rpc("eth_chainId", []), 16)
    if cid != CHAIN_ID:
        raise SystemExit(f"FATAL: chain {cid} is not Arc mainnet ({CHAIN_ID})")
    block = int(rpc("eth_blockNumber", []), 16)
    supply = int(rpc("eth_call", [{"to": TOKEN, "data": "0x18160ddd"}, hex(block)]), 16)
    pool_azia = int(rpc("eth_call", [{"to": TOKEN,
                    "data": "0x70a08231" + enc_addr(POOL).hex()}, hex(block)]), 16)
    log(f"chain {cid} | block {block} | tracking {len(tracked)} addresses")
    log(f"pool AZIA reserve: {fmt(D(pool_azia)/E)}")

    log("\nreading balances...")
    bal = multicall_balances(tracked, hex(block))

    log("\nreading transfers...")
    tr = all_transfers()
    log(f"  {len(tr)} AZIA transfers")

    cache = json.load(open(CACHE)) if os.path.exists(CACHE) else {}
    tset = set(tracked)
    trades = [t for t in tr
              if (t["fromAddress"].lower() == POOL and t["toAddress"].lower() in tset)
              or (t["toAddress"].lower() == POOL and t["fromAddress"].lower() in tset)]
    log(f"  {len(trades)} pool trades by tracked addresses; "
        f"{len({t['transactionHash'] for t in trades}) - len(cache)} new receipts to fetch")

    per = {a: {"buy_tok": 0, "buy_usd": 0, "sell_tok": 0, "sell_usd": 0,
               "n_buy": 0, "n_sell": 0, "last": None, "first": None} for a in tracked}
    for i, t in enumerate(trades, 1):
        h = t["transactionHash"]
        legs = usdc_legs(h, cache)
        val = int(t["value"])
        if t["fromAddress"].lower() == POOL:            # tracked addr BOUGHT
            a = t["toAddress"].lower()
            paid = sum(v for f, x, v in legs if f == a) or \
                   sum(v for f, x, v in legs if x == POOL)
            per[a]["buy_tok"] += val
            per[a]["buy_usd"] += paid
            per[a]["n_buy"] += 1
        else:                                            # tracked addr SOLD
            a = t["fromAddress"].lower()
            got = sum(v for f, x, v in legs if x == a) or \
                  sum(v for f, x, v in legs if f == POOL)
            per[a]["sell_tok"] += val
            per[a]["sell_usd"] += got
            per[a]["n_sell"] += 1
        ts = t["timestamp"]
        per[a]["last"] = max(per[a]["last"] or ts, ts)
        per[a]["first"] = min(per[a]["first"] or ts, ts)
        if i % 50 == 0:
            log(f"  trades {i}/{len(trades)}")
    json.dump(cache, open(CACHE, "w"))

    price = (D(pool_azia) and D(0))  # placeholder, priced below from the quote side
    snap = {"block": block, "at": datetime.now(timezone.utc).isoformat(),
            "supply": str(supply), "pool_azia": str(pool_azia),
            "balances": {a: str(bal[a]) for a in tracked},
            "trades": {a: {k: str(v) for k, v in per[a].items() if v is not None}
                       for a in tracked}}
    os.makedirs(SNAP_DIR, exist_ok=True)
    path = os.path.join(SNAP_DIR, f"{block}.json")
    json.dump(snap, open(path, "w"), indent=1)

    prev = None
    old = sorted(f for f in os.listdir(SNAP_DIR)
                 if f.endswith(".json") and f != f"{block}.json")
    if old:
        prev = json.load(open(os.path.join(SNAP_DIR, old[-1])))

    # ---------------------------------------------------------------- summary
    holders = [a for a in tracked if bal[a] > 0]
    total = sum(bal[a] for a in tracked)
    log("\n" + "=" * 78)
    log(f"OUTSIDE FLOAT at block {block}")
    log("=" * 78)
    log(f"  addresses tracked      : {len(tracked)}")
    log(f"  still holding          : {len(holders)}")
    log(f"  fully exited (zero)    : {len(tracked) - len(holders)}")
    log(f"  float remaining        : {fmt(D(total)/E)} AZIA "
        f"({D(total)/D(supply)*100:.4f}% of supply)")

    tb = sum(per[a]["buy_tok"] for a in tracked)
    tu = sum(per[a]["buy_usd"] for a in tracked)
    ts_ = sum(per[a]["sell_tok"] for a in tracked)
    tsu = sum(per[a]["sell_usd"] for a in tracked)
    log(f"\n  bought from pool       : {fmt(D(tb)/E)} AZIA for ${fmt(D(tu)/E)}")
    if tb:
        log(f"  avg entry              : ${D(tu)/D(tb):.10f}  "
            f"(mcap ${D(tu)/D(tb)*D(10)**9:,.0f})")
    log(f"  SOLD to pool           : {fmt(D(ts_)/E)} AZIA for ${fmt(D(tsu)/E)}")
    if ts_:
        log(f"  avg exit               : ${D(tsu)/D(ts_):.10f}  "
            f"(mcap ${D(tsu)/D(ts_)*D(10)**9:,.0f})")
    log(f"  net cash extracted     : ${fmt(D(tsu-tu)/E)}")

    sellers = [a for a in tracked if per[a]["sell_tok"] > 0]
    log(f"\n  addresses that HAVE sold: {len(sellers)} of {len(tracked)}")

    # --------------------------------------------------------------- the diff
    if prev:
        log("\n" + "=" * 78)
        log(f"CHANGES since block {prev['block']} ({prev['at'][:19]}Z)")
        log("=" * 78)
        pb = prev["balances"]
        pt = prev.get("trades", {})
        moved = []
        for a in tracked:
            before = int(pb.get(a, "0"))
            now = bal[a]
            sold_before = int(pt.get(a, {}).get("sell_tok", "0") or 0)
            sold_now = per[a]["sell_tok"]
            if now != before or sold_now != sold_before:
                moved.append((a, before, now, sold_now - sold_before,
                              per[a]["sell_usd"] - int(pt.get(a, {}).get("sell_usd", "0") or 0)))
        if not moved:
            log("  no balance or trade changes - nobody sold")
        else:
            newly_sold = [m for m in moved if m[3] > 0]
            log(f"  {len(moved)} address(es) changed; {len(newly_sold)} sold into the pool")
            log(f"\n  {'address':<44}{'before':>14}{'now':>14}{'sold':>14}{'USDC out':>11}")
            log("  " + "-" * 95)
            for a, before, now, dsold, dusd in sorted(moved, key=lambda m: -m[3]):
                log(f"  {a:<44}{D(before)/E:>14,.0f}{D(now)/E:>14,.0f}"
                    f"{D(dsold)/E:>14,.0f}{D(dusd)/E:>11,.2f}")
            log(f"\n  float change: {D(sum(int(pb.get(a,'0')) for a in tracked))/E:,.0f}"
                f" -> {D(total)/E:,.0f} AZIA "
                f"({D(total - sum(int(pb.get(a,'0')) for a in tracked))/E:+,.0f})")
    else:
        log("\n  (baseline snapshot - re-run to see changes)")

    # ------------------------------------------------------------------- csv
    out = os.path.join(HERE, "azia_float_status.csv")
    with open(out, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["address", "balance", "pct_of_supply", "bought_azia", "usdc_paid",
                    "avg_entry_usd", "sold_azia", "usdc_received", "avg_exit_usd",
                    "n_buys", "n_sells", "has_sold", "fully_exited",
                    "net_usdc", "first_trade", "last_trade"])
        for a in sorted(tracked, key=lambda x: -bal[x]):
            p = per[a]
            w.writerow([a, f"{D(bal[a])/E:.18f}", f"{D(bal[a])/D(supply)*100:.10f}",
                        f"{D(p['buy_tok'])/E:.6f}", f"{D(p['buy_usd'])/E:.6f}",
                        f"{D(p['buy_usd'])/D(p['buy_tok']):.12f}" if p["buy_tok"] else "",
                        f"{D(p['sell_tok'])/E:.6f}", f"{D(p['sell_usd'])/E:.6f}",
                        f"{D(p['sell_usd'])/D(p['sell_tok']):.12f}" if p["sell_tok"] else "",
                        p["n_buy"], p["n_sell"],
                        "yes" if p["sell_tok"] > 0 else "no",
                        "yes" if bal[a] == 0 else "no",
                        f"{D(p['sell_usd']-p['buy_usd'])/E:.6f}",
                        p["first"] or "", p["last"] or ""])
    log(f"\nwrote {out}")
    log(f"wrote {path}")
    log("\nRead-only: no transactions, no keys.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
