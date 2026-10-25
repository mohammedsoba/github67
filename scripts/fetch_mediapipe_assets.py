#!/usr/bin/env python3
"""Vendor the pinned MediaPipe segmenter (stdlib only) into vendor/mediapipe/ so AI Mask / Background Removal never touch a CDN.

    python scripts/fetch_mediapipe_assets.py --pin            # FIRST RUN (and after any version bump): download, then WRITE scripts/MEDIAPIPE.sha256
    python scripts/fetch_mediapipe_assets.py                  # download what is missing / corrupt, verify EVERY file against the manifest
    python scripts/fetch_mediapipe_assets.py --check          # no network: verify the files already on disk against the manifest
    python scripts/fetch_mediapipe_assets.py --manifest-only  # no network, no files: the manifest must exist, parse and list every required asset

Where the bytes come from (both URLs are pinned to an exact version - nothing says "latest"):
    code  : the npm tarball  @mediapipe/tasks-vision@VERSION  (registry.npmjs.org)  ->  vision_bundle.mjs + wasm/*
    model : storage.googleapis.com/mediapipe-models/.../float32/MODEL_VERSION/selfie_multiclass_256x256.tflite

Result (served by the backend from its own origin; js/core/segmenter-service.js loads ONLY these):
    vendor/mediapipe/vision_bundle.mjs
    vendor/mediapipe/wasm/*                        (vision_wasm_*.js / .wasm)
    vendor/mediapipe/selfie_multiclass_256x256.tflite

Integrity: scripts/MEDIAPIPE.sha256 (tracked, `<sha256>  <path relative to vendor/mediapipe>`) is the trust anchor. A URL version only says
WHICH release to ask for; the hash decides what is ACCEPTED. Without a complete manifest the script refuses to run (exit 1) instead of silently
trusting a download; --pin records the hashes of a download YOU have inspected (review + commit the manifest).
Exit codes: 0 every asset present and verified, 1 anything missing / unverifiable / mismatching (never continues silently).
"""
from __future__ import annotations

import hashlib
import io
import sys
import tarfile
import urllib.request
from pathlib import Path

VERSION = "0.10.14"                    # @mediapipe/tasks-vision; keep equal to VERSION in js/core/segmenter-service.js (a test checks it)
PKG_PATH = "@mediapipe/tasks-vision"
TARBALL_URL = f"https://registry.npmjs.org/{PKG_PATH}/-/tasks-vision-{VERSION}.tgz"
MODEL_VERSION = "1"                    # explicit model release (the old URL said "latest", which can change under the app)
MODEL_NAME = "selfie_multiclass_256x256.tflite"
MODEL_URL = f"https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/{MODEL_VERSION}/{MODEL_NAME}"

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "vendor" / "mediapipe"
MANIFEST = ROOT / "scripts" / "MEDIAPIPE.sha256"
BUNDLE = "vision_bundle.mjs"
MIN_BYTES = {BUNDLE: 50_000, MODEL_NAME: 1_000_000}   # an error page / truncated download is far smaller; wasm files are checked by hash only


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_manifest() -> dict[str, str]:
    """{relative path: sha256}. Raises ValueError with a plain message when the manifest is unusable."""
    if not MANIFEST.is_file():
        raise ValueError(f"{MANIFEST.name} is missing - run: python scripts/fetch_mediapipe_assets.py --pin   (then review and commit it)")
    table: dict[str, str] = {}
    for number, line in enumerate(MANIFEST.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or len(parts[0]) != 64 or any(c not in "0123456789abcdef" for c in parts[0].lower()):
            raise ValueError(f"{MANIFEST.name} line {number} is not '<sha256>  <path>'")
        name = parts[1].strip().lstrip("*")
        if name.startswith("/") or ".." in Path(name).parts:
            raise ValueError(f"{MANIFEST.name} line {number}: unsafe path {name!r}")
        table[name] = parts[0].lower()
    required = {BUNDLE, MODEL_NAME}
    absent = sorted(required - set(table))
    if absent:
        raise ValueError(f"{MANIFEST.name} does not list: {', '.join(absent)} - re-run with --pin")
    if not any(n.startswith("wasm/") and n.endswith(".wasm") for n in table):
        raise ValueError(f"{MANIFEST.name} lists no wasm/*.wasm file - re-run with --pin")
    return table


def http_get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "yofilter-build"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return response.read()


def tarball_files(blob: bytes) -> dict[str, bytes]:
    """vision_bundle.mjs and wasm/* from the npm tarball, keyed by path relative to the package root. Regular files only."""
    files: dict[str, bytes] = {}
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
        for member in archive.getmembers():
            if not member.isfile() or not member.name.startswith("package/"):
                continue
            rel = member.name[len("package/"):]
            if rel == BUNDLE or (rel.startswith("wasm/") and "/" not in rel[len("wasm/"):]):
                handle = archive.extractfile(member)
                if handle is not None:
                    files[rel] = handle.read()
    return files


def write_atomic(rel: str, data: bytes) -> None:
    dest = OUT / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)


def verify(table: dict[str, str]) -> list[str]:
    """Problems found on disk (empty = all good). Also flags leftovers: an unlisted file or a half-downloaded .part."""
    problems: list[str] = []
    for rel, digest in sorted(table.items()):
        path = OUT / rel
        if not path.is_file():
            problems.append(f"{rel}: missing")
        elif path.stat().st_size < MIN_BYTES.get(rel, 1):
            problems.append(f"{rel}: only {path.stat().st_size} bytes (error page / truncated download?)")
        elif sha256_file(path) != digest:
            problems.append(f"{rel}: SHA-256 does not match {MANIFEST.name}")
    if OUT.is_dir():
        for path in sorted(OUT.rglob("*")):
            rel = path.relative_to(OUT).as_posix()
            if path.is_file() and rel != "README.md" and rel not in table:
                problems.append(f"{rel}: not listed in {MANIFEST.name}")
    return problems


def fetch(table: dict[str, str] | None) -> list[str]:
    """Download what is missing/corrupt. table=None means --pin (accept whatever arrives and return no problems)."""
    pin = table is None
    have_ok = lambda rel: (not pin) and (OUT / rel).is_file() and sha256_file(OUT / rel) == table[rel]   # noqa: E731
    wanted_code = [rel for rel in (table or {}) if rel != MODEL_NAME]
    problems: list[str] = []
    if pin or any(not have_ok(rel) for rel in wanted_code):
        print(f"  downloading {TARBALL_URL}")
        try:
            files = tarball_files(http_get(TARBALL_URL))
        except Exception as exc:                                   # network / HTTP / corrupt archive
            return [f"npm tarball: download failed ({exc})"]
        if BUNDLE not in files or not any(n.endswith(".wasm") for n in files):
            return [f"@mediapipe/tasks-vision@{VERSION} does not contain {BUNDLE} + wasm/*.wasm - check VERSION"]
        for rel in (sorted(files) if pin else wanted_code):
            if rel not in files:
                problems.append(f"{rel}: not in the npm tarball")
            elif pin or sha256_bytes(files[rel]) == table[rel]:
                write_atomic(rel, files[rel])
            else:
                problems.append(f"{rel}: tarball content does not match {MANIFEST.name} (not written)")
    if pin or not have_ok(MODEL_NAME):
        print(f"  downloading {MODEL_URL}")
        try:
            model = http_get(MODEL_URL)
        except Exception as exc:
            return problems + [f"{MODEL_NAME}: download failed ({exc})"]
        if pin or sha256_bytes(model) == table[MODEL_NAME]:
            write_atomic(MODEL_NAME, model)
        else:
            problems.append(f"{MODEL_NAME}: download does not match {MANIFEST.name} (not written)")
    return problems


def main(argv: list[str]) -> int:
    flags = set(argv)
    unknown = flags - {"--pin", "--check", "--manifest-only"}
    if unknown:
        print(f"unknown option(s): {' '.join(sorted(unknown))}")
        return 1
    if "--pin" in flags:
        problems = fetch(None)
        if not problems:
            names = sorted(str(p.relative_to(OUT).as_posix()) for p in OUT.rglob("*") if p.is_file() and p.suffix != ".part" and p.name != "README.md")
            MANIFEST.write_text(f"# @mediapipe/tasks-vision@{VERSION} + {MODEL_NAME} (float32/{MODEL_VERSION}) - written by scripts/fetch_mediapipe_assets.py --pin\n"
                                + "".join(f"{sha256_file(OUT / n)}  {n}\n" for n in names), encoding="utf-8")
            print(f"pinned {len(names)} files in {MANIFEST} - review it, then commit it")
    else:
        try:
            table = read_manifest()
        except ValueError as exc:
            print(f"MEDIAPIPE MANIFEST PROBLEM: {exc}")
            return 1
        if "--manifest-only" in flags:
            print(f"manifest OK: {len(table)} files listed")
            return 0
        problems = [] if "--check" in flags else fetch(table)
        problems = problems or verify(table)
    if problems:
        print("vendor/mediapipe is NOT ready:\n  " + "\n  ".join(problems))
        return 1
    print(f"vendor/mediapipe ready: @mediapipe/tasks-vision@{VERSION}, model float32/{MODEL_VERSION}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
