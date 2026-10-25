"""Download missing ONNX models at start-up (standard library only).

Why this exists: the two models (~190 MB) are not committed to GitHub - Railway cannot pull Git LFS objects and
the files are too large to keep in plain Git history comfortably. On start-up ``ensure_models()`` makes sure both
files exist locally and, if not, downloads them from the Hugging Face repository.

Guarantees
* NEVER raises. A failed download is logged and reported in the return value; the server still boots and the
  affected endpoint answers 503 exactly as before (each model is optional at boot, see main.lifespan).
* Atomic: bytes go to ``<name>.<pid>.part`` and are renamed only after the size and SHA-256 are verified, so a
  crash or a dropped connection can never leave a truncated file under the real name.
* Verified: SHA-256 comes from ``backend/models/MODELS.sha256`` (the same manifest scripts/fetch_models.py and CI use).
* Cheap on warm starts: a file that is already present and larger than MIN_MODEL_BYTES is accepted after a
  size check only (a git-lfs pointer is ~130 bytes, so it is rejected). Set MODEL_VERIFY_ON_START=1 for a full hash.

Environment variables (all optional)
    MODEL_AUTO_DOWNLOAD      1 (default) | 0 = never touch the network
    MODEL_BASE_URL           folder URL; files are fetched from <MODEL_BASE_URL>/<filename>
                             default: https://huggingface.co/ertegfg/yofilter-models/resolve/main
    MODEL_VERIFY_ON_START    0 (default) | 1 = hash existing files too and re-download corrupt ones
    MODEL_DOWNLOAD_TIMEOUT   seconds per socket operation (default 60)
    MODEL_DOWNLOAD_ATTEMPTS  tries per file (default 3)
"""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from backend.app.config import BACKEND_DIR, MODEL_PATH, PORTRAIT_MODEL_PATH
from backend.app.ort_utils import MIN_MODEL_BYTES

logger = logging.getLogger("yofilter.models")

# Keep in sync with scripts/fetch_models.py (that script is stdlib-only and cannot import from backend/).
DEFAULT_BASE_URL = "https://huggingface.co/ertegfg/yofilter-models/resolve/main"
MANIFEST_PATH = BACKEND_DIR / "models" / "MODELS.sha256"
CHUNK = 1 << 20
DISK_HEADROOM = 1.1   # require 10 % more free space than Content-Length before starting a download

# remote file name -> local destination (honours LAMA_MODEL_PATH / PORTRAIT_MODEL_PATH overrides from config.py)
DEFAULT_TARGETS: dict[str, Path] = {
    "inpainting_lama.onnx": MODEL_PATH,
    "portrait_depth.onnx": PORTRAIT_MODEL_PATH,
}

PRESENT, DOWNLOADED, DISABLED = "present", "downloaded", "disabled"


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(float(os.environ.get(name, default))))
    except (TypeError, ValueError):
        return default


def read_manifest(path: Path = MANIFEST_PATH) -> dict[str, str]:
    """``{filename: sha256}`` from a ``sha256sum``-style file. Missing / unreadable file -> ``{}`` (no hash check)."""
    table: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                digest, name = line.split(None, 1)
                table[name.strip().lstrip("*")] = digest.lower()
    except (OSError, ValueError):
        logger.warning("Model manifest unreadable (%s): downloads will not be hash-verified", path)
    return table


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def _already_good(path: Path, digest: str | None, min_bytes: int, verify: bool) -> bool:
    try:
        if not path.is_file() or path.stat().st_size < min_bytes:
            return False
        return not (verify and digest and sha256_of(path) != digest)
    except OSError:
        return False


def _download_once(url: str, dest: Path, digest: str | None, min_bytes: int, timeout: float) -> int:
    """One attempt. Returns the byte count; raises on ANY problem and always removes its .part file."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(f"{dest.name}.{os.getpid()}.part")
    request = urllib.request.Request(url, headers={"User-Agent": "yofilter-model-bootstrap"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as resp:      # follows the Hugging Face CDN redirect
            declared = int(resp.headers.get("Content-Length") or 0)
            if declared and shutil.disk_usage(dest.parent).free < declared * DISK_HEADROOM:
                raise OSError(f"not enough free disk space for {declared} bytes in {dest.parent}")
            hasher, received = hashlib.sha256(), 0
            with open(part, "wb") as out:
                for block in iter(lambda: resp.read(CHUNK), b""):
                    out.write(block)
                    hasher.update(block)
                    received += len(block)
        if declared and received != declared:
            raise OSError(f"truncated download: got {received} of {declared} bytes")
        if received < min_bytes:
            raise OSError(f"download is only {received} bytes (error page or LFS pointer?)")
        if digest and hasher.hexdigest() != digest:
            raise OSError("SHA-256 mismatch: the downloaded file is not the expected model")
        os.replace(part, dest)                                               # atomic publish
        return received
    finally:
        try:
            part.unlink()
        except FileNotFoundError:
            pass


def _fetch_with_retries(url: str, dest: Path, digest: str | None, min_bytes: int, timeout: float, attempts: int) -> str:
    """Returns ``DOWNLOADED`` or ``"failed: <reason>"``; never raises."""
    reason = "unknown error"
    for attempt in range(1, attempts + 1):
        started = time.perf_counter()
        try:
            logger.info("[models] downloading %s (attempt %d/%d)", dest.name, attempt, attempts)
            size = _download_once(url, dest, digest, min_bytes, timeout)
            logger.info("[models] %s ready: %.1f MB in %.1f s", dest.name, size / 1e6, time.perf_counter() - started)
            return DOWNLOADED
        except (urllib.error.URLError, OSError, ValueError) as exc:
            reason = f"{type(exc).__name__}: {exc}"
            logger.warning("[models] %s attempt %d/%d failed: %s", dest.name, attempt, attempts, reason)
            if attempt < attempts:
                time.sleep(min(2.0 * attempt, 10.0))
    return f"failed: {reason}"


def ensure_models(
    targets: dict[str, Path] | None = None,
    *,
    base_url: str | None = None,
    manifest: dict[str, str] | None = None,
    min_bytes: int = MIN_MODEL_BYTES,
    enabled: bool | None = None,
    verify: bool | None = None,
) -> dict[str, str]:
    """Make sure every model file exists. Blocking (call it in a worker thread). Returns ``{name: status}`` where
    status is ``present`` | ``downloaded`` | ``disabled`` | ``failed: <reason>``. Never raises."""
    try:
        targets = DEFAULT_TARGETS if targets is None else targets
        enabled = _flag("MODEL_AUTO_DOWNLOAD", True) if enabled is None else enabled
        verify = _flag("MODEL_VERIFY_ON_START", False) if verify is None else verify
        base = (base_url or os.environ.get("MODEL_BASE_URL", "").strip() or DEFAULT_BASE_URL).rstrip("/")
        hashes = read_manifest() if manifest is None else manifest
        timeout = float(_int("MODEL_DOWNLOAD_TIMEOUT", 60))
        attempts = _int("MODEL_DOWNLOAD_ATTEMPTS", 3)

        results: dict[str, str] = {}
        for name, dest in targets.items():
            digest = hashes.get(name)
            if _already_good(dest, digest, min_bytes, verify):
                results[name] = PRESENT
                continue
            if not enabled:
                results[name] = DISABLED
                logger.warning("[models] %s is missing/invalid and MODEL_AUTO_DOWNLOAD=0: its endpoint will answer 503", name)
                continue
            if digest is None:
                logger.warning("[models] no SHA-256 known for %s: the download will only be size-checked", name)
            results[name] = _fetch_with_retries(f"{base}/{urllib.parse.quote(name)}", dest, digest, min_bytes, timeout, attempts)
        return results
    except Exception as exc:                                                 # noqa: BLE001 - boot must never fail here
        logger.exception("[models] unexpected error while preparing models")
        return {"*": f"failed: {type(exc).__name__}: {exc}"}
