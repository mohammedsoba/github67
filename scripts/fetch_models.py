#!/usr/bin/env python3
"""Make sure backend/models/*.onnx are the REAL model files (stdlib only).

    python scripts/fetch_models.py                 # verify; download only what is missing/corrupt
    MODEL_BASE_URL=https://example.com/folder python scripts/fetch_models.py     # override the source

Each file is verified against backend/models/MODELS.sha256. A git-lfs pointer file (~130 bytes), a truncated
download or a wrong file all count as "missing" and are re-downloaded from $MODEL_BASE_URL/<filename>
(default: the Hugging Face repository).
Exit codes: 0 all good, 1 a model is bad and could not be fetched (never continues silently).
"""
from __future__ import annotations

import hashlib
import os
import sys
import urllib.request
from pathlib import Path

# Keep in sync with backend/app/models_bootstrap.py (this script is stdlib-only and cannot import from backend/).
DEFAULT_BASE_URL = "https://huggingface.co/ertegfg/yofilter-models/resolve/main"
MODELS_DIR = Path(__file__).resolve().parents[1] / "backend" / "models"


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def expected() -> dict[str, str]:
    table = {}
    for line in (MODELS_DIR / "MODELS.sha256").read_text().splitlines():
        if line.strip():
            digest, name = line.split(None, 1)
            table[name.strip().lstrip("*")] = digest
    return table


def download(url: str, dest: Path) -> None:
    print(f"  downloading {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "yofilter-ci"})
    token = os.environ.get("GITHUB_TOKEN")
    if token and "github.com" in url:
        request.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(request, timeout=300) as resp, open(tmp, "wb") as out:
        while True:
            block = resp.read(1 << 20)
            if not block:
                break
            out.write(block)
    tmp.replace(dest)


def main() -> int:
    base = (os.environ.get("MODEL_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip("/")
    bad = []
    for name, digest in expected().items():
        path = MODELS_DIR / name
        if path.is_file() and sha256(path) == digest:
            print(f"ok       {name}")
            continue
        state = "missing" if not path.is_file() else f"wrong content ({path.stat().st_size} bytes - LFS pointer?)"
        print(f"BAD      {name}: {state}")
        if not base:
            bad.append(name)
            continue
        try:
            download(f"{base}/{name}", path)
        except Exception as exc:                      # noqa: BLE001 - report and fail below
            print(f"  download failed: {exc}")
        if not (path.is_file() and sha256(path) == digest):
            bad.append(name)
        else:
            print(f"fetched  {name}")
    if bad:
        print("\nModels unavailable: " + ", ".join(bad) +
              "\nCheck MODEL_BASE_URL / your network connection.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
