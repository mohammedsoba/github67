"""Application settings and absolute model path resolution."""

from __future__ import annotations

import json
import os
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
PROJECT_DIR = BACKEND_DIR.parent
DEFAULT_MODEL_PATH = BACKEND_DIR / "models" / "inpainting_lama.onnx"
MODEL_PATH = Path(os.environ.get("LAMA_MODEL_PATH", str(DEFAULT_MODEL_PATH))).expanduser().resolve()
if not MODEL_PATH.is_file() and DEFAULT_MODEL_PATH.is_file():
    MODEL_PATH = DEFAULT_MODEL_PATH.resolve()   # a stale LAMA_MODEL_PATH must not hide the bundled model


def _load_app_meta() -> dict[str, str]:
    """Single source of truth for the product name / version: ``version.json`` in the project root.

    ``scripts/sync_version.py`` stamps the same value into config.xml, js/i18n/i18n.js and index.html, and a test
    fails if any copy drifts. A missing / unreadable file never stops the server: it falls back to neutral values.
    """
    meta = {"name": "YoFilter", "api_title": "YoFilter API", "version": "0.0.0"}
    try:
        data = json.loads((PROJECT_DIR / "version.json").read_text(encoding="utf-8"))
        for key in meta:
            if isinstance(data.get(key), str) and data[key].strip():
                meta[key] = data[key].strip()
    except (OSError, ValueError, AttributeError):
        pass
    return meta


APP_META = _load_app_meta()
APP_VERSION = APP_META["version"]
APP_TITLE = APP_META["api_title"]
MODEL_SIZE = 512
MAX_UPLOAD_BYTES = 25 * 1024 * 1024

# --- Portrait (Depth Anything V2 Small) ---------------------------------------
DEFAULT_PORTRAIT_MODEL_PATH = BACKEND_DIR / "models" / "portrait_depth.onnx"


def _resolve_model_path(env_name: str, default: Path, filename: str) -> Path:
    """Absolute model path that survives any working directory.

    Order: $ENV override -> backend/models (next to this source file) -> <project>/models ->
    ./backend/models and ./models relative to the cwd. The first candidate that exists wins;
    if none exists the default is returned so the error message names a sensible location.
    """
    candidates: list[Path] = []
    override = os.environ.get(env_name, "").strip()
    if override:
        candidates.append(Path(override).expanduser())
    candidates += [default, PROJECT_DIR / "models" / filename,
                   Path.cwd() / "backend" / "models" / filename, Path.cwd() / "models" / filename]
    for candidate in candidates:
        try:
            if candidate.resolve().is_file():
                return candidate.resolve()
        except OSError:
            continue
    return (Path(override).expanduser() if override else default).resolve()


PORTRAIT_MODEL_PATH = _resolve_model_path("PORTRAIT_MODEL_PATH", DEFAULT_PORTRAIT_MODEL_PATH, "portrait_depth.onnx")
PORTRAIT_INPUT_SIZE = 518  # Depth-Anything-V2 ViT patch size 14 * 37
PORTRAIT_MIN_BLUR_LEVEL = 1    # 1 = completely sharp (no blur applied)
PORTRAIT_MAX_BLUR_LEVEL = 30   # 30 = widest f/1.4-style bokeh
PORTRAIT_DEFAULT_BLUR_LEVEL = 1
PORTRAIT_MIN_SKIN_SMOOTH = 0      # 0 = skin smoothing off (photo skin untouched)
PORTRAIT_MAX_SKIN_SMOOTH = 100    # 100 = strongest (still texture-preserving) beauty smoothing
PORTRAIT_DEFAULT_SKIN_SMOOTH = 0
PORTRAIT_MAX_PIXELS = 64_000_000   # decoded-size guard (decompression bombs / OOM): larger photos answer 400


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


PORTRAIT_TIMEOUT_S = _float_env("PORTRAIT_TIMEOUT_S", 120.0)       # server-side cap per request -> 504 (with CORS)
PORTRAIT_MAX_CONCURRENCY = max(1, int(_float_env("PORTRAIT_MAX_CONCURRENCY", 1)))   # parallel blur jobs (memory)


# --- Public-traffic hardening (P1.3) -------------------------------------------
def _int_env(name: str, default: int, minimum: int = 0) -> int:
    """Integer env var; garbage or empty falls back to the default, never below ``minimum``."""
    try:
        return max(minimum, int(float(os.environ.get(name, default))))
    except (TypeError, ValueError):
        return default


def _bool_env(name: str, default: str = "0") -> bool:
    return os.environ.get(name, default).strip().lower() in {"1", "true", "yes", "on"}


# Origin of a packaged Android build (Cordova's default https://localhost scheme/host). It is the ONLY cross-origin
# caller a production deployment needs: the browser build is served by this same backend (same origin, no CORS).
NATIVE_APP_ORIGINS = ["https://localhost"]


def resolve_allowed_origins(raw: str | None, production: bool) -> list[str]:
    """CORS allow-list from the ``ALLOWED_ORIGINS`` value.

    * set            -> exactly that list (whitespace / trailing slashes stripped); an explicit ``*`` is honoured
                        (the operator asked for it; production start-up logs a warning).
    * unset, dev     -> ``["*"]`` (local development from any port).
    * unset, prod    -> ``NATIVE_APP_ORIGINS`` only: cross-origin is DENIED for every web origin.
    """
    origins = [part.strip().rstrip("/") for part in (raw or "").split(",") if part.strip()]
    if not origins:
        return list(NATIVE_APP_ORIGINS) if production else ["*"]
    return ["*"] if "*" in origins else origins


# --- Portrait load protection (same idea as the eraser queue below) ----------------------------------------------------
# Memory of the post-depth pipeline grows ~90 MB per megapixel (measured), so a 24 MP phone photo needs ~2 GB for ONE job.
# Photos are therefore shrunk to PORTRAIT_MAX_SIDE (longest side, px) at decode time, before any large array exists; the
# depth network always runs at PORTRAIT_INPUT_SIZE, so nothing the model sees is lost. 0 = never downscale.
_portrait_side = _int_env("PORTRAIT_MAX_SIDE", 2048)
PORTRAIT_MAX_SIDE = 0 if _portrait_side == 0 else max(PORTRAIT_INPUT_SIZE, _portrait_side)
PORTRAIT_MAX_QUEUE = _int_env("PORTRAIT_MAX_QUEUE", 4)                    # requests allowed to WAIT for a slot; more -> 503
PORTRAIT_QUEUE_WAIT_S = max(1.0, _float_env("PORTRAIT_QUEUE_WAIT_S", 90.0))   # longest a request may wait for a slot -> 503

ERASE_MAX_CONCURRENCY = _int_env("ERASE_MAX_CONCURRENCY", 1, minimum=1)   # parallel LaMa jobs (CPU/memory)
ERASE_MAX_QUEUE = _int_env("ERASE_MAX_QUEUE", 4)                          # requests allowed to WAIT for a slot; more -> 503
ERASE_MAX_PIXELS = _int_env("ERASE_MAX_PIXELS", 64_000_000, minimum=1)    # decoded-size guard for /api/erase uploads
ERASE_QUEUE_WAIT_S = max(1.0, _float_env("ERASE_QUEUE_WAIT_S", 90.0))      # longest an erase may wait for a slot -> 503 busy
# Widest painted selection /api/erase accepts: the bounding box of the white mask pixels, in photo pixels. The network window is
# capped at 2 x MODEL_SIZE (lama.crop_side), so a wider hole cannot be repaired in one pass - it is refused with a 400 instead of
# being silently cut off. A plain constant (not an env var) on purpose: MUST stay equal to MAX_SELECTION_WIDTH in
# js/editing/erase-window.js (tests/ui/erase_window_test.js fails if the two drift apart).
ERASE_MAX_SELECTION_WIDTH = 1024

# --- Response size (network egress) ----------------------------------------------------------------------------------------
# zlib level of the PNG that /api/erase returns. It is ALWAYS lossless (the pixels outside the mask stay identical to the upload);
# only the size / CPU trade-off changes. 0 = "stored" (no compression: a 12 MP photo is ~36 MB), 1 = fastest real compression
# (~7-21 MB depending on the photo, ~+0.3 s per 12 MP); 6 was ~3x slower than 1 for ~14 % smaller on a noisy photo (measured).
# Use 0 only when the client and the server share a LAN / localhost.
ERASE_PNG_COMPRESS_LEVEL = min(9, _int_env("ERASE_PNG_COMPRESS_LEVEL", 1))

# On-the-fly gzip / Brotli of the static front end (compression.py). HTTP_COMPRESSION=0 switches it off completely.
# Images, fonts and the /api/ answers are never compressed (they already are, or are not worth the CPU).
HTTP_COMPRESSION = _bool_env("HTTP_COMPRESSION", "1")
HTTP_COMPRESSION_MIN_BYTES = _int_env("HTTP_COMPRESSION_MIN_BYTES", 1024)   # smaller bodies are sent as they are
HTTP_GZIP_LEVEL = min(9, _int_env("HTTP_GZIP_LEVEL", 5, minimum=1))         # 5: a 9 MB .wasm -> ~31 % in ~0.3 s; level 9 = ~2.6x the CPU for 0.5 % more
HTTP_BROTLI_QUALITY = min(11, _int_env("HTTP_BROTLI_QUALITY", 4))           # low quality = cheap per request; 11 is meant for build-time precompression

# --- One CPU, one heavy job ------------------------------------------------------------------------------------------------
# The eraser (LaMa) and the portrait (depth net + blur) are both CPU-bound. They share ONE pool of slots, so an erase and a
# portrait never run side by side and fight for the same core(s). Default = the larger of the two per-endpoint limits above (1).
AI_MAX_CONCURRENCY = _int_env("AI_MAX_CONCURRENCY", max(ERASE_MAX_CONCURRENCY, PORTRAIT_MAX_CONCURRENCY), minimum=1)
# ONNX Runtime threads for the portrait model. 0 = follow the container's real CPU quota (ort_utils.effective_cpu_count),
# so a 1-vCPU Railway service gets 1 thread instead of oversubscribing the core.
PORTRAIT_THREADS = _int_env("PORTRAIT_THREADS", 0)
# --- Request-body guard (body_guard.py): enforced BEFORE FastAPI parses / spools the multipart body --------------------------
# Multipart framing + the small form fields (blur_level, focus_x ...) on top of the file bytes. A file that is only slightly over
# MAX_UPLOAD_BYTES still reaches the route, which answers its own precise 413 (the existing contract); anything bigger is cut off early.
BODY_OVERHEAD_BYTES = _int_env("BODY_OVERHEAD_BYTES", 1024 * 1024, minimum=0)
# Whole-request limit per route: /api/erase carries TWO files (image + mask), /api/portrait one.
MAX_REQUEST_BYTES_BY_PATH = {
    "/api/erase": 2 * MAX_UPLOAD_BYTES + BODY_OVERHEAD_BYTES,
    "/api/portrait": MAX_UPLOAD_BYTES + BODY_OVERHEAD_BYTES,
}
DEFAULT_MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + BODY_OVERHEAD_BYTES           # any other POST/PUT/PATCH under /api/
# Requests held in memory at once (uploading, queued for a model slot, or processing). Each holds its upload in RAM.
MAX_INFLIGHT_UPLOADS = _int_env("MAX_INFLIGHT_UPLOADS", 8, minimum=1)
MAX_INFLIGHT_UPLOAD_MB = _int_env("MAX_INFLIGHT_UPLOAD_MB", 256, minimum=1)   # budget of declared bytes across those requests
MAX_INFLIGHT_UPLOAD_BYTES = MAX_INFLIGHT_UPLOAD_MB * 1024 * 1024
# --- Start-up / probes (lifecycle.py) ---------------------------------------------------------------------------------------
# False (default, production): the HTTP port opens at once and the models load in the background - /livez answers 200 immediately,
# /readyz answers 503 until both models are loaded (a platform health check pointed at /readyz waits for it). True: the lifespan
# waits for the models before the server accepts connections (the old behaviour; the test-suite uses it).
BLOCK_STARTUP_ON_MODELS = _bool_env("BLOCK_STARTUP_ON_MODELS", "0")
# True (default): /readyz also waits for the LaMa warm-up pass, so the first real erase never queues behind it.
READY_WAITS_FOR_WARMUP = _bool_env("READY_WAITS_FOR_WARMUP", "1")
# True: when start-up has finished and a REQUIRED model (LaMa or portrait depth) is not loaded, the process logs the reason and exits
# with status 1, so the platform's restart policy (Railway: ON_FAILURE, max 5 retries) retries the boot instead of leaving a replica
# that can never become ready. Off by default so local development / the test-suites can run with a missing model (that endpoint then
# answers 503); the Dockerfile switches it on. A failed warm-up pass is NOT a failed load: it only logs.
EXIT_ON_MODEL_LOAD_FAILURE = _bool_env("EXIT_ON_MODEL_LOAD_FAILURE", "0")
RATE_LIMIT_PER_MIN = _int_env("RATE_LIMIT_PER_MIN", 30)                   # POSTs per client per minute on /api/*; 0 = off
# Number of reverse proxies of YOURS in front of the app (Railway: 1). The client IP is the X-Forwarded-For entry that many
# places from the right. 0 = ignore X-Forwarded-For. Unset -> derived from the legacy TRUST_PROXY flag (1 = one hop).
_MAX_PROXY_HOPS = 10
TRUSTED_PROXY_HOPS = (min(_MAX_PROXY_HOPS, _int_env("TRUSTED_PROXY_HOPS", 0)) if os.environ.get("TRUSTED_PROXY_HOPS", "").strip()
                      else (1 if _bool_env("TRUST_PROXY", "0") else 0))
TRUST_PROXY = TRUSTED_PROXY_HOPS > 0                                      # honour forwarded headers (only behind YOUR proxy)
# Set YOFILTER_ENV=production on public deployments: hides /docs, /redoc, /openapi.json, trims /health, adds the
# security headers and flips the CORS default to "native app origin only" (see resolve_allowed_origins).
IS_PRODUCTION = os.environ.get("YOFILTER_ENV", os.environ.get("ENV", "")).strip().lower() in {"prod", "production"}
ALLOWED_ORIGINS = resolve_allowed_origins(os.environ.get("ALLOWED_ORIGINS"), IS_PRODUCTION)   # "*" = any origin

# LaMa warm-up: dummy inference passes run once at server start so the first
# real /api/erase request never pays the ONNX Runtime cold-start cost.
# Default is 1 pass (a second pass froze boot for ~75 s on low-core CPUs).
# Set LAMA_WARMUP_PASSES=0 to skip warm-up entirely (fastest boot, first erase is slower).
def _warmup_passes() -> int:
    try:
        return max(0, int(os.environ.get("LAMA_WARMUP_PASSES", "1")))
    except ValueError:
        return 1


LAMA_WARMUP_PASSES = _warmup_passes()
