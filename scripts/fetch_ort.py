#!/usr/bin/env python3
"""Vendor the pinned onnxruntime-web (WASM / CPU) build into vendor/ort/ for the on-device portrait path (stdlib only).

    python scripts/fetch_ort.py            # download what is missing/corrupt, verify every file against vendor/ort/ORT.sha256
    python scripts/fetch_ort.py --pin      # FIRST RUN ONLY: download, then (re)write ORT.sha256 from what was received - review + commit it

Files (all served from the app's own origin afterwards - the CSP never needs a CDN for them):
    vendor/ort/ort.wasm.min.mjs                  ES-module bundle, WASM execution provider only (imported by js/workers/depth-worker.js)
    vendor/ort/ort-wasm-simd-threaded.mjs        WASM loader (imported by the bundle at run time)
    vendor/ort/ort-wasm-simd-threaded.wasm       the runtime itself (~10 MB; single-thread mode is used, see the worker)

Integrity: ORT.sha256 is the trust anchor. Without an entry for a file the script refuses to continue (exit 1) instead of
silently trusting a download; --pin records the hashes of a download YOU have inspected. Bumping VERSION means re-pinning.
Exit codes: 0 all files present and verified, 1 a file is missing/unverifiable (never continues silently).
"""
from __future__ import annotations

import hashlib
import json
import sys
import urllib.request
from pathlib import Path

VERSION = "1.20.1"                     # pinned; >= 2 weeks old at the time of writing (never float on "latest")
PKG = "onnxruntime-web"
CDN = f"https://cdn.jsdelivr.net/npm/{PKG}@{VERSION}/dist"
FILES = ("ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm")
OUT = Path(__file__).resolve().parents[1] / "vendor" / "ort"
TABLE = OUT / "ORT.sha256"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def pinned() -> dict[str, str]:
    table: dict[str, str] = {}
    if TABLE.is_file():
        for line in TABLE.read_text(encoding="utf-8").splitlines():
            if line.strip() and not line.startswith("#"):
                digest, name = line.split(None, 1)
                table[name.strip().lstrip("*")] = digest.lower()
    return table


def download(name: str) -> None:
    url = f"{CDN}/{name}"
    dest = OUT / name
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  downloading {url}")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "yofilter-ci"}), timeout=300) as resp, open(tmp, "wb") as out:
        for block in iter(lambda: resp.read(1 << 20), b""):
            out.write(block)
    tmp.replace(dest)


def listing_has_all() -> list[str]:
    """Names (from the jsdelivr package listing) that the pinned version does NOT ship - a clear error beats a 404 mid-way."""
    try:
        data = json.load(urllib.request.urlopen(f"https://data.jsdelivr.com/v1/packages/npm/{PKG}@{VERSION}?structure=flat", timeout=60))
    except Exception:
        return []                                                     # listing is only a courtesy check
    have = {f["name"] for f in data.get("files", [])}
    return [n for n in FILES if f"/dist/{n}" not in have]


def main() -> int:
    pin = "--pin" in sys.argv[1:]
    OUT.mkdir(parents=True, exist_ok=True)
    table = pinned()
    absent = listing_has_all()
    if absent:
        print(f"{PKG}@{VERSION} does not ship: {', '.join(absent)}. Update FILES / VERSION in this script and in js/workers/depth-worker.js.")
        return 1
    problems = []
    for name in FILES:
        path = OUT / name
        ok = path.is_file() and (pin or (name in table and sha256(path) == table[name]))
        if not ok:
            try:
                download(name)
            except Exception as exc:                                  # network / HTTP failure
                problems.append(f"{name}: download failed ({exc})")
                continue
        if not pin:
            if name not in table:
                problems.append(f"{name}: no entry in {TABLE.name} - run once with --pin, inspect, then commit the table")
            elif sha256(path) != table[name]:
                path.unlink(missing_ok=True)
                problems.append(f"{name}: SHA-256 does not match {TABLE.name} (file removed)")
    if pin and not problems:
        TABLE.write_text(f"# {PKG}@{VERSION} - written by scripts/fetch_ort.py --pin\n" +
                         "".join(f"{sha256(OUT / n)}  {n}\n" for n in FILES), encoding="utf-8")
        print(f"pinned {len(FILES)} files in {TABLE}")
    if problems:
        print("vendor/ort is NOT ready:\n  " + "\n  ".join(problems))
        return 1
    print(f"vendor/ort ready: {PKG}@{VERSION} ({len(FILES)} files verified)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
