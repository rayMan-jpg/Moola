#!/usr/bin/env python3
"""
AZIA (Arcenzia) token supply audit on Arc mainnet (Circle's L1, chain 5042).

Read-only. Computes exact balanceOf for a set of wallets at a single pinned
snapshot block, via Multicall3 when available, and cross-checks against the
arcexplorer.org token-holders API.

No private keys, no transactions, no signing. Only eth_call / eth_chainId /
eth_blockNumber / eth_getCode are ever issued.
"""

from __future__ import annotations

import csv
import json
import os
import statistics
import sys
import time
from decimal import Decimal, getcontext

import requests

getcontext().prec = 60

# ---------------------------------------------------------------- configuration

TOKEN = "0x4b919197c5570dbb14527049d42636dfcf659901"
EXPECTED_CHAIN_ID = 5042          # Arc mainnet
EXPECTED_DECIMALS = 18
EXPECTED_TOTAL_SUPPLY_UNITS = 1_000_000_000
MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"

EXPLORER_API = "https://arcexplorer.org/api/v1"

# Public Arc mainnet endpoints, per docs.arc.io/arc/references/connect-to-arc
FALLBACK_RPCS = [
    "https://rpc.mainnet.arc.io",
    "https://rpc.drpc.mainnet.arc.io",
    "https://rpc.blockdaemon.mainnet.arc.io",
    "https://rpc.quicknode.mainnet.arc.io",
]

MULTICALL_CHUNK = 50      # calls per aggregate3
BATCH_CHUNK = 25          # eth_calls per JSON-RPC batch (fallback)
SLEEP_BETWEEN = 0.15      # polite rate limiting
MAX_RETRIES = 5
RETRYABLE_RPC_CODES = {-32005}   # "rate limit exceeded"

# selectors
SEL_BALANCE_OF = "70a08231"
SEL_DECIMALS = "313ce567"
SEL_TOTAL_SUPPLY = "18160ddd"
SEL_NAME = "06fdde03"
SEL_SYMBOL = "95d89b41"
SEL_AGGREGATE3 = "82ad56cb"


def log(msg: str) -> None:
    print(msg, flush=True)


# ------------------------------------------------------------- minimal ABI codec

def enc_uint(n: int) -> bytes:
    return int(n).to_bytes(32, "big")


def enc_addr(a: str) -> bytes:
    return bytes(12) + bytes.fromhex(a[2:])


def pad32(b: bytes) -> bytes:
    rem = len(b) % 32
    return b + bytes((32 - rem) % 32)


def enc_bytes(b: bytes) -> bytes:
    return enc_uint(len(b)) + pad32(b)


def encode_aggregate3(calls: list[tuple[str, bool, bytes]]) -> str:
    """aggregate3((address target, bool allowFailure, bytes callData)[])"""
    elements = [
        enc_addr(t) + enc_uint(1 if allow else 0) + enc_uint(0x60) + enc_bytes(cd)
        for t, allow, cd in calls
    ]
    offsets, cursor = [], 32 * len(elements)
    for el in elements:
        offsets.append(enc_uint(cursor))
        cursor += len(el)
    body = enc_uint(0x20) + enc_uint(len(elements)) + b"".join(offsets) + b"".join(elements)
    return "0x" + SEL_AGGREGATE3 + body.hex()


def decode_aggregate3(hexdata: str) -> list[tuple[bool, bytes]]:
    """Decode (bool success, bytes returnData)[]"""
    raw = bytes.fromhex(hexdata[2:])
    n = int.from_bytes(raw[32:64], "big")
    base = 64
    out = []
    for i in range(n):
        off = int.from_bytes(raw[base + 32 * i: base + 32 * i + 32], "big")
        p = base + off
        success = int.from_bytes(raw[p:p + 32], "big") == 1
        boff = int.from_bytes(raw[p + 32:p + 64], "big")
        bp = p + boff
        blen = int.from_bytes(raw[bp:bp + 32], "big")
        out.append((success, raw[bp + 32: bp + 32 + blen]))
    return out


def decode_string(hexdata: str) -> str:
    raw = bytes.fromhex(hexdata[2:])
    if len(raw) < 64:
        return raw.rstrip(b"\x00").decode("utf-8", "replace")
    length = int.from_bytes(raw[32:64], "big")
    return raw[64:64 + length].decode("utf-8", "replace")


def balance_of_calldata(addr: str) -> bytes:
    return bytes.fromhex(SEL_BALANCE_OF) + enc_addr(addr)


# ------------------------------------------------------------------- RPC client

class Rpc:
    def __init__(self, url: str):
        self.url = url
        self.session = requests.Session()
        self.session.headers.update({"content-type": "application/json"})
        self._id = 0
        self.calls = 0

    def _next_id(self) -> int:
        self._id += 1
        return self._id

    def _post(self, payload):
        last = None
        for attempt in range(MAX_RETRIES):
            try:
                r = self.session.post(self.url, data=json.dumps(payload), timeout=60)
                if r.status_code in (429, 500, 502, 503, 504):
                    raise RuntimeError(f"HTTP {r.status_code}")
                r.raise_for_status()
                self.calls += 1
                return r.json()
            except Exception as exc:                      # noqa: BLE001
                last = exc
                wait = 2 ** attempt
                log(f"    ! RPC error ({exc}); retry {attempt + 1}/{MAX_RETRIES} in {wait}s")
                time.sleep(wait)
        raise RuntimeError(f"RPC failed after {MAX_RETRIES} attempts: {last}")

    def call(self, method: str, params: list):
        for attempt in range(MAX_RETRIES):
            res = self._post({"jsonrpc": "2.0", "id": self._next_id(),
                              "method": method, "params": params})
            if "error" not in res:
                return res["result"]
            if res["error"].get("code") not in RETRYABLE_RPC_CODES:
                raise RuntimeError(f"{method} -> {res['error']}")
            wait = 0.5 * (attempt + 1)
            log(f"    ~ {method} rate-limited; retrying in {wait:.1f}s")
            time.sleep(wait)
        raise RuntimeError(f"{method} -> rate-limited after {MAX_RETRIES} attempts")

    def batch(self, reqs: list[tuple[str, list]]):
        """Batched call. Elements rejected for rate limiting are retried.

        Public Arc endpoints rate-limit *per element* (JSON-RPC -32005), so a
        batch can come back part-filled. Those elements are re-sent with
        backoff rather than reported as missing.
        """
        out: list = [None] * len(reqs)
        pending = list(range(len(reqs)))
        for attempt in range(MAX_RETRIES):
            payload = [{"jsonrpc": "2.0", "id": i,
                        "method": reqs[i][0], "params": reqs[i][1]}
                       for i in pending]
            res = self._post(payload)
            if isinstance(res, dict):
                raise RuntimeError(f"batch rejected: {res.get('error')}")
            by_id = {item["id"]: item for item in res}
            retry = []
            for i in pending:
                item = by_id.get(i)
                if item is None:
                    retry.append(i)
                elif "error" in item:
                    if item["error"].get("code") in RETRYABLE_RPC_CODES:
                        retry.append(i)
                    else:
                        log(f"    ! element {i}: {item['error']}")
                else:
                    out[i] = item["result"]
            pending = retry
            if not pending:
                return out
            wait = 0.5 * (attempt + 1)
            log(f"    ~ {len(pending)} batch element(s) rate-limited; "
                f"retrying in {wait:.1f}s")
            time.sleep(wait)
        log(f"    ! {len(pending)} element(s) unresolved after retries")
        return out

    def eth_call(self, to: str, data: str, block: str):
        return self.call("eth_call", [{"to": to, "data": data}, block])


def pick_rpc() -> Rpc:
    """Honour env vars first, then fall back to documented public endpoints."""
    candidates = []
    if os.environ.get("ARC_RPC_URL"):
        candidates.append(os.environ["ARC_RPC_URL"])
        log("  using ARC_RPC_URL from environment")
    if os.environ.get("ALCHEMY_API_KEY"):
        candidates.append(
            f"https://arc-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY']}")
        log("  using ALCHEMY_API_KEY from environment")
    if not candidates:
        log("  no ARC_RPC_URL / ALCHEMY_API_KEY in env; using public Arc endpoints")
    candidates += FALLBACK_RPCS

    for url in candidates:
        shown = url.split("/v2/")[0] + "/v2/***" if "/v2/" in url else url
        try:
            rpc = Rpc(url)
            cid = int(rpc.call("eth_chainId", []), 16)
            log(f"  {shown}  ->  eth_chainId = {cid}")
            if cid != EXPECTED_CHAIN_ID:
                log(f"  ! chain {cid} is not Arc mainnet ({EXPECTED_CHAIN_ID}); skipping")
                continue
            return rpc
        except Exception as exc:                          # noqa: BLE001
            log(f"  {shown}  ->  unreachable ({exc})")
    raise SystemExit("FATAL: no reachable Arc mainnet RPC (chain 5042). Stopping.")


# ----------------------------------------------------------------- wallet input

def read_wallets(path: str) -> list[str]:
    seen, out = set(), []
    with open(path) as fh:
        for lineno, line in enumerate(fh, 1):
            a = line.strip()
            if not a or a.startswith("#"):
                continue
            if not (a.startswith("0x") and len(a) == 42):
                raise SystemExit(f"{path}:{lineno}: malformed address {a!r}")
            try:
                int(a[2:], 16)
            except ValueError:
                raise SystemExit(f"{path}:{lineno}: non-hex address {a!r}")
            if a.lower() in seen:
                log(f"  ! {path}:{lineno}: duplicate {a}, keeping first occurrence")
                continue
            seen.add(a.lower())
            out.append(a)
    return out


# ------------------------------------------------------------- balance fetching

def fetch_balances(rpc: Rpc, addrs: list[str], block_hex: str,
                   use_multicall: bool) -> dict[str, int]:
    balances: dict[str, int] = {}

    if use_multicall:
        total = (len(addrs) + MULTICALL_CHUNK - 1) // MULTICALL_CHUNK
        for ci in range(total):
            chunk = addrs[ci * MULTICALL_CHUNK:(ci + 1) * MULTICALL_CHUNK]
            calls = [(TOKEN, True, balance_of_calldata(a)) for a in chunk]
            data = encode_aggregate3(calls)
            try:
                ret = rpc.eth_call(MULTICALL3, data, block_hex)
                results = decode_aggregate3(ret)
                if len(results) != len(chunk):
                    raise RuntimeError("length mismatch")
                for addr, (ok, rd) in zip(chunk, results):
                    if not ok or len(rd) < 32:
                        raise RuntimeError(f"sub-call failed for {addr}")
                    balances[addr.lower()] = int.from_bytes(rd[:32], "big")
                log(f"  multicall chunk {ci + 1}/{total}: {len(chunk)} balances "
                    f"({len(balances)}/{len(addrs)} done)")
            except Exception as exc:                      # noqa: BLE001
                log(f"  ! multicall chunk {ci + 1} failed ({exc}); "
                    f"falling back to batched eth_call for this chunk")
                balances.update(_fetch_batched(rpc, chunk, block_hex))
            time.sleep(SLEEP_BETWEEN)
    else:
        balances.update(_fetch_batched(rpc, addrs, block_hex))

    missing = [a for a in addrs if a.lower() not in balances]
    if missing:
        raise SystemExit(f"FATAL: {len(missing)} balances never resolved: {missing[:5]}")
    return balances


def _fetch_batched(rpc: Rpc, addrs: list[str], block_hex: str) -> dict[str, int]:
    out: dict[str, int] = {}
    total = (len(addrs) + BATCH_CHUNK - 1) // BATCH_CHUNK
    for ci in range(total):
        chunk = addrs[ci * BATCH_CHUNK:(ci + 1) * BATCH_CHUNK]
        reqs = [("eth_call",
                 [{"to": TOKEN, "data": "0x" + balance_of_calldata(a).hex()}, block_hex])
                for a in chunk]
        try:
            results = rpc.batch(reqs)
        except Exception as exc:                          # noqa: BLE001
            log(f"    ! batch failed ({exc}); going sequential")
            results = []
            for a in chunk:
                try:
                    results.append(rpc.eth_call(
                        TOKEN, "0x" + balance_of_calldata(a).hex(), block_hex))
                except Exception as exc2:                 # noqa: BLE001
                    log(f"    ! {a}: {exc2}")
                    results.append(None)
                time.sleep(SLEEP_BETWEEN)
        for addr, res in zip(chunk, results):
            if res is None or res == "0x":
                log(f"    ! no result for {addr}")
                continue
            out[addr.lower()] = int(res, 16)
        log(f"  batch chunk {ci + 1}/{total}: {len(out)}/{len(addrs)} done")
        time.sleep(SLEEP_BETWEEN)
    return out


# -------------------------------------------------------------- explorer holders

def fetch_explorer_holders() -> dict[str, int] | None:
    holders: dict[str, int] = {}
    offset, limit = 0, 100
    try:
        while True:
            r = requests.get(f"{EXPLORER_API}/tokens/{TOKEN}/holders",
                             params={"limit": limit, "offset": offset},
                             headers={"accept": "application/json"}, timeout=45)
            r.raise_for_status()
            payload = r.json()
            items = payload.get("items", [])
            for it in items:
                holders[it["address"].lower()] = int(it["balance"])
            log(f"  explorer holders: offset={offset} got={len(items)} "
                f"total={payload.get('total')}")
            nxt = payload.get("nextOffset")
            if not items or nxt is None or nxt == offset:
                break
            offset = nxt
            time.sleep(0.3)
        return holders
    except Exception as exc:                              # noqa: BLE001
        log(f"  ! explorer holder sweep failed ({exc}); continuing RPC-only")
        return None


# ---------------------------------------------------------------------- reporting

def pct(part: int, whole: int) -> Decimal:
    return (Decimal(part) / Decimal(whole) * Decimal(100)) if whole else Decimal(0)


def to_units(wei: int, decimals: int) -> Decimal:
    return Decimal(wei) / (Decimal(10) ** decimals)


def report_cluster(label: str, addrs: list[str], balances: dict[str, int],
                   total_supply: int, decimals: int, block: int,
                   explorer: dict[str, int] | None, csv_path: str | None):
    held = sum(balances[a.lower()] for a in addrs)
    share = pct(held, total_supply)

    print()
    print("=" * 78)
    print(f"{len(addrs)} {label} hold {to_units(held, decimals):,.2f} tokens "
          f"= {share:.2f}% of total supply at block {block}")
    print("=" * 78)

    rows = sorted(((a, balances[a.lower()]) for a in addrs),
                  key=lambda kv: kv[1], reverse=True)

    if csv_path:
        with open(csv_path, "w", newline="") as fh:
            w = csv.writer(fh)
            w.writerow(["address", "balance", "pct_of_supply", "balance_wei"])
            for a, bal in rows:
                w.writerow([a, f"{to_units(bal, decimals):.18f}",
                            f"{pct(bal, total_supply):.10f}", bal])
        log(f"  wrote {csv_path} ({len(rows)} rows)")

    zeros = [a for a, bal in rows if bal == 0]
    print(f"\n  ZERO-balance wallets: {len(zeros)} of {len(addrs)}")
    if zeros:
        print("  (tokens have left these wallets)")
        for a in zeros:
            print(f"    {a}")

    nonzero = [bal for _, bal in rows if bal > 0]
    print(f"\n  Distribution ({len(nonzero)} funded wallets):")
    if nonzero:
        print(f"    largest : {to_units(rows[0][1], decimals):>18,.4f}  {rows[0][0]}")
        smallest = min(((a, b) for a, b in rows if b > 0), key=lambda kv: kv[1])
        print(f"    smallest: {to_units(smallest[1], decimals):>18,.4f}  {smallest[0]}")
        med = Decimal(statistics.median(nonzero))
        print(f"    median  : {to_units(int(med), decimals):>18,.4f}")
        print(f"    mean    : {to_units(int(sum(nonzero) / len(nonzero)), decimals):>18,.4f}")
    print(f"    median incl. zeros: "
          f"{to_units(int(statistics.median([b for _, b in rows])), decimals):,.4f}")

    if explorer is not None:
        mismatches, not_listed = [], []
        for a, bal in rows:
            exp = explorer.get(a.lower())
            if exp is None:
                if bal != 0:
                    not_listed.append((a, bal))
            elif exp != bal:
                mismatches.append((a, bal, exp))
        print(f"\n  Explorer cross-check: ", end="")
        if not mismatches and not not_listed:
            print(f"all {len(addrs)} wallets agree with arcexplorer.org")
        else:
            print(f"{len(mismatches)} mismatch(es), "
                  f"{len(not_listed)} funded-but-unlisted")
            for a, rpc_bal, exp_bal in mismatches:
                print(f"    MISMATCH {a}: rpc={rpc_bal} explorer={exp_bal} "
                      f"(delta={rpc_bal - exp_bal})")
            for a, bal in not_listed:
                print(f"    UNLISTED {a}: rpc={bal} but absent from explorer holders")
    return held, share, rows


# --------------------------------------------------------------------------- main

def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    gen_path = os.path.join(here, "generated_wallets.txt")
    ops_path = os.path.join(here, "launchpad_ops_wallets.txt")

    log("== 1. Connecting to Arc mainnet ==")
    rpc = pick_rpc()
    chain_id = int(rpc.call("eth_chainId", []), 16)
    log(f"  CONFIRMED chain_id = {chain_id} (Arc mainnet); endpoint = {rpc.url}")

    log("\n== 2. Pinning snapshot block ==")
    block = int(rpc.call("eth_blockNumber", []), 16)
    block_hex = hex(block)
    log(f"  snapshot block = {block} ({block_hex})")

    log("\n  probing state retention (public Arc nodes are not archive)")
    for back in (2_000, 10_000, 30_000):
        probe = rpc.eth_call(TOKEN, "0x" + SEL_TOTAL_SUPPLY, hex(max(1, block - back)))
        if probe in ("0x", "0x0"):
            log(f"  state at block-{back:,} already pruned -> snapshot must be "
                f"read promptly; re-run rather than reusing a stale block")
            break
        log(f"  state at block-{back:,}: available")

    log("\n== 3. Verifying token contract on-chain ==")
    code = rpc.call("eth_getCode", [TOKEN, block_hex])
    if code in ("0x", "0x0"):
        raise SystemExit(f"FATAL: no contract code at {TOKEN}")
    log(f"  contract code present ({len(code) // 2 - 1} bytes)")

    name = decode_string(rpc.eth_call(TOKEN, "0x" + SEL_NAME, block_hex))
    symbol = decode_string(rpc.eth_call(TOKEN, "0x" + SEL_SYMBOL, block_hex))
    decimals = int(rpc.eth_call(TOKEN, "0x" + SEL_DECIMALS, block_hex), 16)
    total_supply = int(rpc.eth_call(TOKEN, "0x" + SEL_TOTAL_SUPPLY, block_hex), 16)
    supply_units = to_units(total_supply, decimals)

    log(f"  name        = {name!r}")
    log(f"  symbol      = {symbol!r}")
    log(f"  decimals    = {decimals}"
        f"{'  OK' if decimals == EXPECTED_DECIMALS else '  !! EXPECTED 18'}")
    log(f"  totalSupply = {total_supply} wei = {supply_units:,.2f} tokens"
        f"{'  OK' if supply_units == EXPECTED_TOTAL_SUPPLY_UNITS else '  !! EXPECTED 1e9'}")
    if decimals != EXPECTED_DECIMALS:
        log("  ! decimals differ from the expected 18 - using the ON-CHAIN value")
    if supply_units != EXPECTED_TOTAL_SUPPLY_UNITS:
        log("  ! total supply differs from the expected 1,000,000,000 "
            "- using the ON-CHAIN value")

    log("\n== 4. Checking Multicall3 ==")
    mc_code = rpc.call("eth_getCode", [MULTICALL3, block_hex])
    use_multicall = mc_code not in ("0x", "0x0")
    log(f"  Multicall3 at {MULTICALL3}: "
        f"{'DEPLOYED, using aggregate3' if use_multicall else 'absent, using batched eth_call'}")

    log("\n== 5. Reading wallet lists ==")
    generated = read_wallets(gen_path)
    log(f"  generated_wallets.txt: {len(generated)} unique addresses")
    ops = read_wallets(ops_path) if os.path.exists(ops_path) else []
    if ops:
        log(f"  launchpad_ops_wallets.txt: {len(ops)} unique addresses")
    else:
        log("  launchpad_ops_wallets.txt: not present, skipping ops cluster")

    log("\n== 6. Fetching balanceOf at pinned block ==")
    all_addrs = generated + [a for a in ops if a.lower() not in {g.lower() for g in generated}]
    balances = fetch_balances(rpc, all_addrs, block_hex, use_multicall)
    log(f"  resolved {len(balances)} balances in {rpc.calls} RPC requests")

    log("\n== 7. Explorer cross-check (arcexplorer.org) ==")
    explorer = fetch_explorer_holders()
    if explorer is not None:
        esum = sum(explorer.values())
        log(f"  {len(explorer)} non-zero holders, sum = {esum} wei "
            f"= {to_units(esum, decimals):,.2f} tokens")
        log(f"  reconciles to totalSupply: {'YES' if esum == total_supply else 'NO'}"
            f" (delta {total_supply - esum} wei)")

    report_cluster("generated wallets", generated, balances, total_supply,
                   decimals, block, explorer,
                   os.path.join(here, "azia_generated_balances.csv"))

    if ops:
        report_cluster("ops wallets", ops, balances, total_supply,
                       decimals, block, explorer,
                       os.path.join(here, "azia_ops_balances.csv"))

        gen_sum = sum(balances[a.lower()] for a in generated)
        ops_sum = sum(balances[a.lower()] for a in ops)
        combined = gen_sum + ops_sum
        print()
        print("=" * 78)
        print(f"COMBINED {len(generated) + len(ops)} wallets hold "
              f"{to_units(combined, decimals):,.2f} tokens "
              f"= {pct(combined, total_supply):.2f}% of total supply at block {block}")
        print("=" * 78)

    print(f"\nRemainder held outside the swept clusters: "
          f"{to_units(total_supply - sum(balances[a.lower()] for a in all_addrs), decimals):,.2f}"
          f" tokens")
    print("\nDone. Read-only: no transactions were sent and no keys were used.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
