#!/usr/bin/env python3
"""Fail-closed verification of backend/models against MODELS.sha256 (standard library only).

    python scripts/verify_models.py                  # full check: manifest + every model file (size + SHA-256)
    python scripts/verify_models.py --manifest-only  # manifest sanity only (used BEFORE downloading, to fail fast)
    python scripts/verify_models.py --dir D --manifest M --min-bytes N

Used by the Dockerfile twice: right after the models are downloaded and again on the final image, so what runs in
production is exactly what the manifest in Git promises. Exit code 0 = everything verified; 1 = ANY problem. There is no
"warn and continue" path: a missing manifest, an empty manifest, a missing required model, a git-lfs pointer / truncated /
corrupt file, a wrong hash, an .onnx file the manifest does not list, or a leftover .part file all fail.
"""
from __future__ import annotations

import argparse
import hashlib
import re
import sys
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DIR = PROJECT_DIR / "backend" / "models"
# The models the server cannot run without. Keep in sync with models_bootstrap.DEFAULT_TARGETS
# (tests/backend/test_verify_models.py fails if they drift apart).
REQUIRED = ("inpainting_lama.onnx", "portrait_depth.onnx")
MIN_BYTES = 1_000_000          # same threshold as ort_utils.MIN_MODEL_BYTES: smaller = LFS pointer / error page / truncated
_LINE = re.compile(r"^([0-9a-fA-F]{64})[ \t]+\*?([^\s/\\][^/\\]*)$")


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_manifest(path: Path) -> tuple[dict[str, str], list[str]]:
    """``({filename: sha256}, problems)``. Every malformed / duplicate line is a problem; so is a missing or empty file."""
    problems: list[str] = []
    table: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        return {}, [f"manifest unreadable: {path} ({exc})"]
    for number, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        match = _LINE.match(line)
        if not match:
            problems.append(f"{path.name}:{number}: not '<64 hex>  <filename>': {line[:80]!r}")
            continue
        digest, name = match.group(1).lower(), match.group(2)
        if name in table:
            problems.append(f"{path.name}:{number}: duplicate entry for {name}")
        table[name] = digest
    if not table and not problems:
        problems.append(f"manifest is empty: {path}")
    for name in REQUIRED:
        if name not in table:
            problems.append(f"manifest has no entry for required model {name}")
    return table, problems


def verify(models_dir: Path, manifest: Path, min_bytes: int = MIN_BYTES, manifest_only: bool = False) -> list[str]:
    table, problems = read_manifest(manifest)
    if manifest_only or problems and not table:
        return problems
    for name, digest in sorted(table.items()):
        path = models_dir / name
        if not path.is_file():
            problems.append(f"{name}: missing in {models_dir}")
            continue
        size = path.stat().st_size
        if size < min_bytes:
            problems.append(f"{name}: only {size} bytes (git-lfs pointer / error page / truncated download?)")
            continue
        actual = sha256_of(path)
        if actual != digest:
            problems.append(f"{name}: SHA-256 mismatch (expected {digest[:12]}..., got {actual[:12]}...)")
        else:
            print(f"ok   {name}  {size / 1e6:.1f} MB  sha256 {digest[:12]}...")
    listed = set(table)
    for extra in sorted(p.name for p in models_dir.glob("*.onnx") if p.name not in listed):
        problems.append(f"{extra}: an .onnx file the manifest does not list (unverified model)")
    for leftover in sorted(p.name for p in models_dir.glob("*.part")):
        problems.append(f"{leftover}: leftover partial download")
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="folder with the .onnx files")
    parser.add_argument("--manifest", type=Path, default=None, help="default: <dir>/MODELS.sha256")
    parser.add_argument("--min-bytes", type=int, default=MIN_BYTES)
    parser.add_argument("--manifest-only", action="store_true", help="only validate the manifest, not the model files")
    args = parser.parse_args(argv)
    manifest = args.manifest or args.dir / "MODELS.sha256"
    problems = verify(args.dir, manifest, args.min_bytes, args.manifest_only)
    if problems:
        print("MODEL VERIFICATION FAILED:", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 1
    print("manifest ok" if args.manifest_only else "all models verified")
    return 0


if __name__ == "__main__":
    sys.exit(main())
