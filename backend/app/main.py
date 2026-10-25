"""YoFilter standalone FastAPI service."""

from __future__ import annotations

import asyncio
import io
import mimetypes
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from importlib.metadata import PackageNotFoundError, version
from typing import AsyncIterator

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.exception_handlers import request_validation_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
import onnxruntime as ort
from starlette.concurrency import run_in_threadpool

from backend.app.config import (
    ALLOWED_ORIGINS,
    APP_TITLE,
    AI_MAX_CONCURRENCY,
    APP_VERSION,
    DEFAULT_MAX_REQUEST_BYTES,
    ERASE_MAX_PIXELS,
    ERASE_MAX_QUEUE,
    ERASE_PNG_COMPRESS_LEVEL,
    ERASE_QUEUE_WAIT_S,
    HTTP_BROTLI_QUALITY,
    HTTP_COMPRESSION,
    HTTP_COMPRESSION_MIN_BYTES,
    HTTP_GZIP_LEVEL,
    IS_PRODUCTION,
    LAMA_WARMUP_PASSES,
    MAX_INFLIGHT_UPLOAD_BYTES,
    MAX_INFLIGHT_UPLOADS,
    MAX_REQUEST_BYTES_BY_PATH,
    MAX_UPLOAD_BYTES,
    MODEL_PATH,
    PORTRAIT_DEFAULT_BLUR_LEVEL,
    PORTRAIT_DEFAULT_SKIN_SMOOTH,
    PORTRAIT_MAX_BLUR_LEVEL,
    PORTRAIT_MAX_PIXELS,
    PORTRAIT_MAX_QUEUE,
    PORTRAIT_MAX_SIDE,
    PORTRAIT_MAX_SKIN_SMOOTH,
    PORTRAIT_MIN_BLUR_LEVEL,
    PORTRAIT_MIN_SKIN_SMOOTH,
    PORTRAIT_MODEL_PATH,
    PORTRAIT_QUEUE_WAIT_S,
    PORTRAIT_TIMEOUT_S,
    PROJECT_DIR,
    RATE_LIMIT_PER_MIN,
    TRUST_PROXY,
    TRUSTED_PROXY_HOPS,
    BLOCK_STARTUP_ON_MODELS,
    EXIT_ON_MODEL_LOAD_FAILURE,
    READY_WAITS_FOR_WARMUP,
)
from backend.app.body_guard import BodyGuardMiddleware
from backend.app.compression import CompressionMiddleware, build_encoders
from backend.app.erase_guard import SelectionTooLargeError, error_body
from backend.app.imaging import open_image
from backend.app.lama import PROFILE, LamaInpainter
from backend.app.lifecycle import (
    EXIT_CODE_MODEL_LOAD_FAILURE,
    NO_STORE,
    RETRY_AFTER_S,
    STARTING_MESSAGE,
    evaluate_readiness,
    health_http_status,
    liveness_body,
    missing_models,
    readiness_body,
)
from backend.app.limits import rate_limit
from backend.app.slots import run_in_owned_slot
from backend.app.log import configure_logging
from backend.app.models_bootstrap import ensure_models
from backend.app.portrait import DepthPortrait
from backend.app.security import (
    CORS_ALLOW_HEADERS,
    CORS_ALLOW_METHODS,
    PORTRAIT_UNAVAILABLE_MESSAGE,
    health_payload,
    public_model_error,
    security_headers,
)


logger = configure_logging()


# Retry-After must be readable by the page: the packaged app calls this API cross-origin, and without it the browser hides the
# header on every 503 "busy" / 429 (the page would silently fall back to its default wait).
EXPOSED_HEADERS = ["Server-Timing", "Content-Disposition", "Retry-After"]


def cors_headers_for(request: Request) -> dict[str, str]:
    """CORS headers for responses produced OUTSIDE CORSMiddleware (Starlette's last-resort 500 handler).
    Same rule as the middleware: the Origin is echoed only if it is on ALLOWED_ORIGINS - never a blanket '*'
    on a restricted deployment."""
    origin = request.headers.get("origin")
    if not origin:
        return {}
    if "*" in ALLOWED_ORIGINS:
        allow = "*"
    elif origin.rstrip("/") in ALLOWED_ORIGINS:
        allow = origin
    else:
        return {}
    return {"Access-Control-Allow-Origin": allow, "Access-Control-Expose-Headers": ", ".join(EXPOSED_HEADERS),
            **({"Vary": "Origin"} if allow != "*" else {})}


def internal_error(request: Request, exc: Exception) -> JSONResponse:
    """Log the traceback under a short reference id and answer JSON (with CORS headers) that quotes it."""
    error_id = uuid.uuid4().hex[:8]
    logger.error("[%s %s] unhandled exception (ref %s) from %s", request.method, request.url.path, error_id,
                 request.client.host if request.client else "?", exc_info=(type(exc), exc, exc.__traceback__))
    return error_response(500, f"Internal server error (ref {error_id}); see the server log.",
                          cors_headers_for(request))


def error_response(status: int, detail: str, extra: dict[str, str] | None = None) -> JSONResponse:
    """JSON error body. CORS headers are NOT added here: CORSMiddleware is outermost and stamps every
    response (2xx, 4xx, 429, 503, 5xx) with the headers for the requesting origin. Hard-coding '*' here
    would leak access to origins that ALLOWED_ORIGINS excludes."""
    return JSONResponse(status_code=status, content={"detail": detail}, headers=extra or None)


def load_portrait(app: FastAPI) -> bool:
    """(Re)load the portrait depth model into app.state. Never raises; the reason is kept for 503s."""
    try:
        app.state.portrait = DepthPortrait()
        app.state.portrait_error = None
        return True
    except Exception as exc:
        app.state.portrait = None
        app.state.portrait_error = f"{type(exc).__name__}: {exc}"
        logger.exception("Portrait depth model failed to load from %s", PORTRAIT_MODEL_PATH)
        return False


async def _warm_up_lama(app: FastAPI) -> None:
    """Silent background warm-up: the server answers immediately instead of waiting for it. ``/readyz`` reports
    ``warming_up`` until this has finished (success, failure or nothing to do), so no real request queues behind it."""
    inpainter = app.state.inpainter
    try:
        if LAMA_WARMUP_PASSES <= 0 or inpainter is None:
            return
        await run_in_threadpool(inpainter.warm_up)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("LaMa warm-up failed; the first erase will be slower")
    finally:
        app.state.warmup_pending = False


async def _boot_models(app: FastAPI) -> None:
    """Make sure the model files exist, then load both models. Never raises (except cancellation).

    Runs either inline in the lifespan (BLOCK_STARTUP_ON_MODELS=1) or as a background task right after the port opens, so a
    slow load never makes the platform think the process is dead. ``boot_finished`` flips only AFTER both loads were
    attempted; a model that failed stays ``None`` and keeps ``/readyz`` and ``/health`` at 503 (fail closed, endpoint 503s)."""
    started = time.perf_counter()
    try:
        # Baked-in models (Docker image) are only size-checked here; hosts without them download + verify, see models_bootstrap.py.
        model_status = await run_in_threadpool(ensure_models)
        failed = {name: status for name, status in model_status.items() if status.startswith("failed")}
        if failed:
            logger.error("Model download problems (endpoints will answer 503): %s", failed)
        # Each model is optional at boot: a missing/broken file disables only ITS endpoint (503 with the reason) and never
        # prevents the server from starting. Models are loaded in worker threads.
        try:
            app.state.inpainter = await run_in_threadpool(LamaInpainter)
        except Exception:
            logger.exception("LaMa model failed to load from %s - /api/erase will answer 503", MODEL_PATH)
        async with app.state.portrait_load_lock:         # the request path's lazy retry takes the same lock: no double load
            if app.state.portrait is None:
                await run_in_threadpool(load_portrait, app)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Model start-up crashed; the affected endpoints will answer 503")
    _exit_if_required_model_missing(app)                 # no-op unless EXIT_ON_MODEL_LOAD_FAILURE; never reached by a healthy boot
    # No await between these three lines: /readyz never sees "finished" without the matching warm-up flag.
    app.state.warmup_pending = bool(READY_WAITS_FOR_WARMUP and LAMA_WARMUP_PASSES > 0 and app.state.inpainter is not None)
    app.state.boot_finished = True
    logger.info("YoFilter ready - eraser: %s | portrait: %s (models loaded in %.1f s)",
                app.state.inpainter.provider if app.state.inpainter else "UNAVAILABLE",
                app.state.portrait.provider if app.state.portrait else "UNAVAILABLE",
                time.perf_counter() - started)


def _exit_process(code: int) -> None:
    """Stop the whole process with ``code`` (a seam so the tests can observe it instead of dying).

    From the background boot task ``SystemExit`` is re-raised by asyncio out of the event loop, which ends uvicorn with that status
    (the lifespan ``finally`` still runs). From the blocking start-up path (``BLOCK_STARTUP_ON_MODELS=1``) it fails the lifespan
    start-up, so uvicorn exits non-zero as well. Either way the platform sees a failed start and applies its restart policy."""
    sys.exit(code)


def _exit_if_required_model_missing(app: FastAPI) -> None:
    """After BOTH loads were attempted: exit when a required model is missing and ``EXIT_ON_MODEL_LOAD_FAILURE`` is on."""
    if not EXIT_ON_MODEL_LOAD_FAILURE:
        return
    missing = missing_models(lama_loaded=app.state.inpainter is not None, portrait_loaded=app.state.portrait is not None)
    if missing:
        logger.critical("Required model(s) failed to load: %s - exiting with status %d so the platform restarts the service "
                        "(set EXIT_ON_MODEL_LOAD_FAILURE=0 to keep a degraded server running)",
                        ", ".join(missing), EXIT_CODE_MODEL_LOAD_FAILURE)
        _exit_process(EXIT_CODE_MODEL_LOAD_FAILURE)


async def _boot_then_warm_up(app: FastAPI) -> None:
    await _boot_models(app)
    await _warm_up_lama(app)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.inpainter = None
    app.state.portrait = None
    app.state.portrait_error = None
    app.state.boot_finished = False                                    # /readyz: "starting" until both loads were attempted
    app.state.warmup_pending = False
    app.state.portrait_load_lock = asyncio.Lock()
    # ONE slot pool for both CPU-bound endpoints: an erase and a portrait never run side by side (see config.py).
    # The three names point at the SAME semaphore; each endpoint keeps its own waiting counter / queue limit.
    shared_slots = asyncio.Semaphore(AI_MAX_CONCURRENCY)
    workers = os.environ.get("WEB_CONCURRENCY", "").strip()
    if workers.isdigit() and int(workers) > 1:
        # The slot pool, the queues and the rate limiter live in THIS process. N workers = N pools (N heavy jobs at once)
        # and N copies of both models in RAM - exactly what the shared pool exists to prevent.
        logger.warning("WEB_CONCURRENCY=%s: every worker has its OWN slot pool, queues and models; heavy jobs are no longer "
                       "limited to AI_MAX_CONCURRENCY=%d overall. Run ONE worker (the Procfile default).", workers, AI_MAX_CONCURRENCY)
    app.state.ai_slots = shared_slots
    app.state.portrait_slots = shared_slots
    app.state.erase_slots = shared_slots
    app.state.portrait_waiting = 0                                     # portrait requests queued for a slot
    app.state.erase_waiting = 0                                        # erase requests queued for a slot
    if "*" in ALLOWED_ORIGINS:
        (logger.warning if IS_PRODUCTION else logger.info)(
            "CORS allows ANY origin (ALLOWED_ORIGINS=*)%s", " in production - set ALLOWED_ORIGINS to your site(s)" if IS_PRODUCTION else "")
    elif IS_PRODUCTION:
        logger.info("CORS allow-list: %s", ", ".join(ALLOWED_ORIGINS) or "(none)")
    logger.info("Hardening: rate limit %s/min per client (trusted proxy hops: %s) | erase: %d concurrent, queue %d, max %d MP",
                RATE_LIMIT_PER_MIN or "off", TRUSTED_PROXY_HOPS, AI_MAX_CONCURRENCY, ERASE_MAX_QUEUE, ERASE_MAX_PIXELS // 1_000_000)
    logger.info("Body guard: request limits %s B (default %d B) | at most %d uploads / %d MB in flight",
                MAX_REQUEST_BYTES_BY_PATH, DEFAULT_MAX_REQUEST_BYTES, MAX_INFLIGHT_UPLOADS, MAX_INFLIGHT_UPLOAD_BYTES // (1024 * 1024))
    if HTTP_COMPRESSION:
        encodings = list(build_encoders(HTTP_GZIP_LEVEL, HTTP_BROTLI_QUALITY))
        logger.info("HTTP compression: %s for text-like static assets >= %d B (never /api/, images or fonts)%s",
                    "+".join(encodings), HTTP_COMPRESSION_MIN_BYTES,
                    "" if "br" in encodings else " - the brotli package is missing, gzip only")
    else:
        logger.info("HTTP compression: off (HTTP_COMPRESSION=0)")
    logger.info("Eraser result: lossless PNG, zlib level %d (ERASE_PNG_COMPRESS_LEVEL; 0 = uncompressed)", ERASE_PNG_COMPRESS_LEVEL)
    logger.info("Heavy jobs: %d at a time, SHARED by eraser + portrait | eraser queue wait <= %.0fs | portrait queue %d (wait <= %.0fs, "
                "compute <= %.0fs), photos shrunk to %s px longest side",
                AI_MAX_CONCURRENCY, ERASE_QUEUE_WAIT_S, PORTRAIT_MAX_QUEUE, PORTRAIT_QUEUE_WAIT_S, PORTRAIT_TIMEOUT_S,
                PORTRAIT_MAX_SIDE or "unlimited")
    if not (PROJECT_DIR / "vendor" / "mediapipe" / "vision_bundle.mjs").is_file():
        # The page loads the segmenter ONLY from this origin (no CDN fallback): without the files AI Mask / Background Removal fail.
        logger.warning("MediaPipe assets are missing (vendor/mediapipe): AI Mask and Background Removal cannot load. "
                       "Run scripts/fetch_mediapipe_assets.py (the Docker image does it at build time).")
    if BLOCK_STARTUP_ON_MODELS:
        await _boot_models(app)                                        # old behaviour: accept connections only once loaded
        boot_task = asyncio.create_task(_warm_up_lama(app))
    else:
        # Open the port NOW. /livez is 200 from the first second; /readyz stays 503 until the background task has loaded
        # both models (and run the warm-up), and API calls in the meantime get a clear 503 + Retry-After.
        logger.info("Listening - models load in the background (/livez: alive now, /readyz: ready when loaded)")
        boot_task = asyncio.create_task(_boot_then_warm_up(app))
    try:
        yield
    finally:
        boot_task.cancel()
        await asyncio.gather(boot_task, return_exceptions=True)        # a model load already running in a thread cannot be interrupted
        app.state.inpainter = None
        app.state.portrait = None


app = FastAPI(
    title=APP_TITLE,                                    # "YoFilter API" - from version.json (single source)
    version=APP_VERSION,
    description="YoFilter image-editing API: LaMa object erase and depth-based portrait blur.",
    lifespan=lifespan,
    # Interactive docs and the machine-readable schema expose every route / parameter: off in production.
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None if IS_PRODUCTION else "/redoc",
    openapi_url=None if IS_PRODUCTION else "/openapi.json",
)


@app.middleware("http")
async def never_drop_the_connection(request: Request, call_next):
    """Turn ANY escaped exception into a JSON 500. Added before CORSMiddleware, so CORS wraps it and the
    error reaches the page with headers instead of a silently dropped connection."""
    try:
        return await call_next(request)
    except asyncio.CancelledError:
        raise                                   # client went away: let Starlette clean up
    except Exception as exc:
        return internal_error(request, exc)


# Middleware order (add_middleware inserts OUTSIDE everything added before it):
#   never_drop_the_connection (innermost)  ->  rate_limit  ->  CORSMiddleware (outermost, added LAST)
# so a 429 from the limiter, a 503 "busy" and a JSON 500 all leave through CORS with proper headers.
app.middleware("http")(rate_limit)

# Body guard (pure ASGI): Content-Length gate + streaming byte counter + in-flight upload cap, all BEFORE FastAPI parses the
# multipart body. Added after rate_limit (so it wraps it: oversized / excess uploads are refused first) and before
# CORSMiddleware (so its early 413 / 503 still leave through CORS and the security headers).
app.add_middleware(
    BodyGuardMiddleware,
    limits=MAX_REQUEST_BYTES_BY_PATH,
    default_limit=DEFAULT_MAX_REQUEST_BYTES,
    max_inflight=MAX_INFLIGHT_UPLOADS,
    max_inflight_bytes=MAX_INFLIGHT_UPLOAD_BYTES,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=CORS_ALLOW_METHODS,
    allow_headers=CORS_ALLOW_HEADERS,
    expose_headers=EXPOSED_HEADERS,
    max_age=86400,
)


@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    """Outermost layer (added after CORSMiddleware): every response that leaves the app - 2xx, 4xx, 429, 503 -
    carries nosniff, and in production the CSP / frame-ancestors / X-Frame-Options / Referrer-Policy / HSTS set.
    The production flag is read at call time (module global) so tests can flip it."""
    response = await call_next(request)
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower() if TRUST_PROXY else ""
    https = request.url.scheme == "https" or forwarded == "https"
    for name, value in security_headers(request.url.path, IS_PRODUCTION, https).items():
        response.headers.setdefault(name, value)
    return response


# Compression is registered LAST, i.e. it is the OUTERMOST layer: it sees the final response (CORS + security headers already set)
# and compresses only the text-like static assets - never /api/ (the eraser's PNG is already deflated by lama.py), never images / fonts.
# See compression.py for why this is not Starlette's GZipMiddleware.
if HTTP_COMPRESSION:
    app.add_middleware(
        CompressionMiddleware,
        minimum_size=HTTP_COMPRESSION_MIN_BYTES,
        gzip_level=HTTP_GZIP_LEVEL,
        brotli_quality=HTTP_BROTLI_QUALITY,
    )


@app.exception_handler(RequestValidationError)
async def log_validation_error(request: Request, exc: RequestValidationError):
    """Log WHY a request was rejected (422), then answer exactly like FastAPI would."""
    problems = "; ".join(
        f"{'.'.join(str(part) for part in err.get('loc', ()))}: {err.get('msg')}" for err in exc.errors()
    )
    logger.warning(
        "[%s %s] 422 validation failed from %s (content-type=%s, content-length=%s): %s",
        request.method, request.url.path, request.client.host if request.client else "?",
        request.headers.get("content-type", "-").split(";")[0], request.headers.get("content-length", "-"), problems,
    )
    return await request_validation_exception_handler(request, exc)


@app.exception_handler(Exception)
async def log_unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    """Last line of defence: log the traceback and answer with JSON that still carries CORS headers.

    Starlette runs this handler *outside* the CORS middleware, so without the explicit header a
    cross-origin page would only see an opaque "Failed to fetch" instead of the server's message."""
    return internal_error(request, exc)    # attaches CORS headers itself (this handler sits outside the middleware)


def installed_version(package: str) -> str:
    try:
        return version(package)
    except PackageNotFoundError:
        return "missing"


def _health_details(request: Request) -> dict[str, object]:
    """Diagnostics for development only: absolute model paths, provider list, dependency versions, load errors."""
    inpainter = getattr(request.app.state, "inpainter", None)
    ort_version = installed_version("onnxruntime")
    dependencies = {
        "fastapi": installed_version("fastapi"),
        "uvicorn": installed_version("uvicorn"),
        "onnxruntime": ort_version if ort_version != "missing" else installed_version("onnxruntime-directml"),
        "pillow": installed_version("Pillow"),
        "numpy": installed_version("numpy"),
        "opencv": installed_version("opencv-python-headless"),
    }
    return {
        "model_warmed_up": bool(getattr(inpainter, "warmed_up", False)),
        "model_path": str(MODEL_PATH),
        "lama_provider": getattr(inpainter, "provider", None),
        "portrait_model_path": str(PORTRAIT_MODEL_PATH),
        "portrait_model_exists": PORTRAIT_MODEL_PATH.is_file(),
        "portrait_load_error": getattr(request.app.state, "portrait_error", None),
        "erase_queue": getattr(request.app.state, "erase_waiting", 0),
        "portrait_queue": getattr(request.app.state, "portrait_waiting", 0),
        "rate_limit_per_min": RATE_LIMIT_PER_MIN,
        "onnx_providers": ort.get_available_providers(),
        "dependencies": dependencies,
    }


def _models_loaded(request: Request) -> tuple[bool, bool]:
    state = request.app.state
    return getattr(state, "inpainter", None) is not None, getattr(state, "portrait", None) is not None


@app.get("/livez", include_in_schema=False)
async def livez() -> JSONResponse:
    """LIVENESS: 200 whenever the process answers. Deliberately independent of the models, the disk and the network."""
    return JSONResponse(liveness_body(), headers=NO_STORE)


@app.get("/readyz", include_in_schema=False)
async def readyz(request: Request) -> JSONResponse:
    """READINESS: 200 only when start-up is finished, BOTH models are loaded and the warm-up pass is done; else 503
    (+ Retry-After) with the reason in ``status`` (starting | warming_up | unavailable). Point the platform health check here."""
    lama_loaded, portrait_loaded = _models_loaded(request)
    state = request.app.state
    readiness = evaluate_readiness(
        boot_finished=getattr(state, "boot_finished", False),
        lama_loaded=lama_loaded,
        portrait_loaded=portrait_loaded,
        warmup_pending=getattr(state, "warmup_pending", False),
    )
    headers = dict(NO_STORE)
    if not readiness.ready:
        headers["Retry-After"] = RETRY_AFTER_S
    return JSONResponse(readiness_body(readiness, IS_PRODUCTION, lambda: _health_details(request)),
                        status_code=readiness.http_status, headers=headers)


@app.get("/health")
async def health(request: Request) -> JSONResponse:
    """Model status. 200 only when BOTH required models are loaded, otherwise 503 (a missing model is never "fine").
    Production profile (YOFILTER_ENV=production): ONLY status + the two model flags. Development: full diagnostics."""
    lama_loaded, portrait_loaded = _models_loaded(request)
    body = health_payload(
        IS_PRODUCTION,
        model_loaded=lama_loaded,
        portrait_loaded=portrait_loaded,
        detailed=lambda: _health_details(request),
    )
    return JSONResponse(body, status_code=health_http_status(lama_loaded, portrait_loaded), headers=NO_STORE)


def _reject_if_huge(data: bytes, limit: int, what: str) -> None:
    """400 unless ``data`` is a JPEG / PNG / WebP whose DECODED size is within ``limit`` pixels.

    Header-only (``imaging.open_image`` never decodes a pixel), so this costs microseconds, never allocates the image, and
    runs BEFORE the request is queued or any decoder sees the bytes. Other formats and undecodable data are refused here
    with the same 'not a valid image' answer the decoders give."""
    try:
        with open_image(data, limit, what):
            pass
    except ValueError as exc:                       # UnsupportedImageError / ImageTooLargeError
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/erase")
async def erase(
    request: Request,
    image: UploadFile = File(..., description="Source image to inpaint"),
    mask: UploadFile = File(..., description="White pixels mark areas to remove"),
    ref_size: int = Form(0, ge=0, le=65535, description="Longest side of the full photo when only a crop is uploaded"),
) -> Response:
    t_req = time.perf_counter()
    req_id = uuid.uuid4().hex[:8]
    client = request.client.host if request.client else "?"
    image_bytes = await image.read(MAX_UPLOAD_BYTES + 1)
    mask_bytes = await mask.read(MAX_UPLOAD_BYTES + 1)
    t_read = time.perf_counter() - t_req            # reading the multipart upload from the spooled temp files
    # One context string reused by every log line of this request, so a failure can be traced back.
    context = (f"req={req_id} client={client} image={image.filename!r}/{image.content_type} {len(image_bytes)} B "
               f"mask={mask.filename!r}/{mask.content_type} {len(mask_bytes)} B ref_size={ref_size}")
    if len(image_bytes) > MAX_UPLOAD_BYTES or len(mask_bytes) > MAX_UPLOAD_BYTES:
        logger.warning("[erase] 413 upload over %d MB limit | %s", MAX_UPLOAD_BYTES // (1024 * 1024), context)
        raise HTTPException(status_code=413, detail="Each upload must be 25 MB or smaller")
    if not image_bytes or not mask_bytes:
        logger.warning("[erase] 400 empty upload | %s", context)
        raise HTTPException(status_code=400, detail="Both image and mask must be non-empty")

    inpainter = getattr(request.app.state, "inpainter", None)
    if inpainter is None and not getattr(request.app.state, "boot_finished", True):
        logger.info("[erase] 503 models still loading | %s", context)
        raise HTTPException(status_code=503, detail=STARTING_MESSAGE, headers={"Retry-After": RETRY_AFTER_S})
    if inpainter is None:
        logger.error("[erase] 503 LaMa model is not loaded | %s", context)
        raise HTTPException(status_code=503, detail="LaMa model is not loaded")

    # Cheap header-only size check BEFORE anything is queued or decoded.
    _reject_if_huge(image_bytes, ERASE_MAX_PIXELS, "Image")
    _reject_if_huge(mask_bytes, ERASE_MAX_PIXELS, "Mask")

    state = request.app.state
    if state.erase_slots.locked() and state.erase_waiting >= ERASE_MAX_QUEUE:
        logger.warning("[erase] 503 busy: %d already queued | %s", state.erase_waiting, context)
        raise HTTPException(status_code=503, detail="The eraser is busy; please retry in a few seconds",
                            headers={"Retry-After": "5"})

    state.erase_waiting += 1                    # no await between the check above and this line: race-free
    queued = True
    try:
        try:
            # Heavy jobs share one slot pool with /api/portrait, so waiting is bounded (as for portrait): a request that
            # cannot get a slot in time is told to retry instead of idling until the proxy gives up.
            await asyncio.wait_for(state.erase_slots.acquire(), timeout=ERASE_QUEUE_WAIT_S)
        except asyncio.TimeoutError:
            logger.warning("[erase] 503 waited %.0fs for a slot | %s", ERASE_QUEUE_WAIT_S, context)
            raise HTTPException(status_code=503, detail="The eraser is busy; please retry in a few seconds",
                                headers={"Retry-After": "5"})
        state.erase_waiting -= 1
        queued = False
        try:
            gone = await request.is_disconnected()
        except BaseException:                   # cancelled while holding the slot: never leak it
            state.erase_slots.release()
            raise
        if gone:
            state.erase_slots.release()
            logger.info("[erase] 499 client left while queued | %s", context)
            return Response(status_code=499)
        try:
            # The slot is released by the worker thread's completion (slots.py), not by this request.
            result, timer = await run_in_owned_slot(state.erase_slots, inpainter.erase_profiled,
                                                    image_bytes, mask_bytes, ref_size)
        except SelectionTooLargeError as exc:    # BEFORE the generic ValueError branch (it is a subclass)
            logger.warning("[erase] 400 selection too wide: %d px > %d px | %s", exc.width, exc.limit, context)
            # Structured 400: ``detail`` is the English | Arabic text, ``code`` / ``max_width`` let the client localise it.
            # CORSMiddleware is outermost, so this response gets the same CORS headers as every other error.
            return JSONResponse(status_code=400, content=error_body(exc), headers=NO_STORE)
        except ValueError as exc:
            logger.warning("[erase] 400 rejected input: %s | %s", exc, context)
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            # Full traceback + the request context goes to the server console / log.
            logger.exception("[erase] 500 LaMa inpainting failed | %s", context)
            raise HTTPException(
                status_code=500, detail=f"LaMa inpainting failed (ref {req_id}); see the server log.",
            ) from exc
    finally:
        if queued:                              # cancelled / failed while still waiting for a slot
            state.erase_waiting -= 1

    total = time.perf_counter() - t_req
    if PROFILE:
        logger.info("[erase-profile] endpoint: upload read %.1f ms | pipeline %.1f ms | request total (excl. network) %.1f ms | response %.2f MB",
                    t_read * 1000, timer.total * 1000, total * 1000, len(result) / 1e6)
    # ``result`` is a lossless PNG that lama.py already deflated (ERASE_PNG_COMPRESS_LEVEL); the compression middleware skips /api/,
    # so the bytes leave exactly as encoded. Server-Timing's "f" step is the encode cost; the profile log above prints the size.
    return Response(
        content=result,
        media_type="image/png",
        headers={
            "Content-Disposition": 'inline; filename="result.png"',
            "Server-Timing": f"upload;dur={t_read * 1000:.1f}, {timer.server_timing()}, total;dur={total * 1000:.1f}",
        },
    )


@app.post("/api/portrait")
async def portrait(
    request: Request,
    image: UploadFile = File(..., description="Photo whose background should be blurred"),
    blur_level: int = Form(
        PORTRAIT_DEFAULT_BLUR_LEVEL,
        ge=PORTRAIT_MIN_BLUR_LEVEL,
        le=PORTRAIT_MAX_BLUR_LEVEL,
        description="Background blur strength, 1 (sharp) to 30 (widest bokeh)",
    ),
    focus_x: float = Form(
        0.5, ge=0.0, le=1.0, description="Tap-to-focus X, normalised 0..1 (default centre)"
    ),
    focus_y: float = Form(
        0.5, ge=0.0, le=1.0, description="Tap-to-focus Y, normalised 0..1 (default centre)"
    ),
    skin_smooth: int = Form(
        PORTRAIT_DEFAULT_SKIN_SMOOTH,
        ge=PORTRAIT_MIN_SKIN_SMOOTH,
        le=PORTRAIT_MAX_SKIN_SMOOTH,
        description="Natural skin smoothing, 0 (off) to 100 (strongest); combines with the bokeh blur",
    ),
) -> Response:
    """Depth-based background blur plus optional natural skin smoothing. Every failure path answers JSON *with CORS headers*:
    400 bad input, 413 too big, 503 model missing, 504 timeout, 500 anything else."""
    t_req = time.perf_counter()
    req_id = uuid.uuid4().hex[:8]
    client = request.client.host if request.client else "?"
    context = f"req={req_id} client={client} blur={blur_level} skin={skin_smooth} focus=({focus_x:.2f},{focus_y:.2f})"
    try:
        image_bytes = await image.read(MAX_UPLOAD_BYTES + 1)
        context += f" image={image.filename!r}/{image.content_type} {len(image_bytes)} B"
        if len(image_bytes) > MAX_UPLOAD_BYTES:
            logger.warning("[portrait] 413 upload over limit | %s", context)
            return error_response(413, "Upload must be 25 MB or smaller")
        if not image_bytes:
            logger.warning("[portrait] 400 empty upload | %s", context)
            return error_response(400, "Image must be non-empty")

        depth_portrait = getattr(request.app.state, "portrait", None)
        if depth_portrait is None and not getattr(request.app.state, "boot_finished", True):
            logger.info("[portrait] 503 models still loading | %s", context)
            return error_response(503, STARTING_MESSAGE, {"Retry-After": RETRY_AFTER_S})
        if depth_portrait is None:
            # The model may have failed at boot (file copied later, transient error): retry once, lazily.
            async with request.app.state.portrait_load_lock:
                if getattr(request.app.state, "portrait", None) is None:
                    await run_in_threadpool(load_portrait, request.app)
            depth_portrait = getattr(request.app.state, "portrait", None)
        if depth_portrait is None:
            reason = getattr(request.app.state, "portrait_error", None) or "unknown error"
            logger.error("[portrait] 503 model not loaded (%s) | %s", reason, context)      # full reason: server log only
            # S1 (V26): the reason can contain absolute paths / raw exception text - the client only gets it in development.
            return error_response(503, public_model_error(IS_PRODUCTION, PORTRAIT_UNAVAILABLE_MESSAGE, reason))

        # Cheap header-only size check BEFORE anything is queued or decoded (same as /api/erase).
        try:
            _reject_if_huge(image_bytes, PORTRAIT_MAX_PIXELS, "Image")
        except HTTPException as exc:
            logger.warning("[portrait] %d rejected before queueing: %s | %s", exc.status_code, exc.detail, context)
            return error_response(exc.status_code, str(exc.detail))

        # Bounded queue (same policy as /api/erase): at most AI_MAX_CONCURRENCY heavy jobs run (shared with the eraser), at most PORTRAIT_MAX_QUEUE
        # requests wait (each waiting request holds its upload in RAM), everything beyond that is told to retry - a clear
        # 503 + Retry-After instead of an ever-growing pile that ends in a proxy timeout or an out-of-memory kill.
        state = request.app.state
        slots = state.portrait_slots
        busy_headers = {"Retry-After": "5"}
        if slots.locked() and state.portrait_waiting >= PORTRAIT_MAX_QUEUE:
            logger.warning("[portrait] 503 busy: %d already queued | %s", state.portrait_waiting, context)
            return error_response(503, "Portrait is busy; please retry in a few seconds", busy_headers)

        state.portrait_waiting += 1                 # no await between the check above and this line: race-free
        queued = True
        try:
            try:
                # Waiting for a slot has its OWN limit. PORTRAIT_TIMEOUT_S below counts only the compute time, so a
                # request that queued for a while is not killed for a delay that was not its own.
                await asyncio.wait_for(slots.acquire(), timeout=PORTRAIT_QUEUE_WAIT_S)
            except asyncio.TimeoutError:
                logger.warning("[portrait] 503 waited %.0fs for a slot | %s", PORTRAIT_QUEUE_WAIT_S, context)
                return error_response(503, "Portrait is busy; please retry in a few seconds", busy_headers)
            state.portrait_waiting -= 1
            queued = False
            try:
                gone = await request.is_disconnected()
            except BaseException:                   # cancelled while holding the slot: never leak it
                slots.release()
                raise
            if gone:
                slots.release()
                logger.info("[portrait] 499 client left while queued | %s", context)
                return Response(status_code=499)
            try:
                # The slot is handed back only when the worker THREAD finishes (see slots.py): a timed-out
                # job keeps counting against the limit until it is really gone.
                result, media_type = await asyncio.wait_for(
                    run_in_owned_slot(slots, depth_portrait.blur_background,
                                      image_bytes, blur_level, focus_x, focus_y, skin_smooth),
                    timeout=PORTRAIT_TIMEOUT_S)
            except asyncio.TimeoutError:
                logger.error("[portrait] 504 timed out after %.0fs | %s", PORTRAIT_TIMEOUT_S, context)
                return error_response(504, f"Portrait processing timed out after {PORTRAIT_TIMEOUT_S:.0f}s (ref {req_id}); try a smaller photo.")
            except ValueError as exc:
                logger.warning("[portrait] 400 rejected input: %s | %s", exc, context)
                return error_response(400, str(exc))
            except MemoryError:
                logger.error("[portrait] 500 out of memory | %s", context)
                return error_response(500, f"Not enough memory to process this photo (ref {req_id}); try a smaller one.")
            except Exception:
                logger.exception("[portrait] 500 depth blur failed | %s", context)
                return error_response(500, f"Portrait processing failed (ref {req_id}); see the server log.")
        finally:
            if queued:                              # cancelled / timed out while still waiting for a slot
                state.portrait_waiting -= 1
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("[portrait] 500 unexpected failure | %s", context)
        return error_response(500, f"Portrait request failed (ref {req_id}); see the server log.")

    total = time.perf_counter() - t_req
    extension = "png" if media_type == "image/png" else "jpg"
    return Response(
        content=result,
        media_type=media_type,
        headers={
            "Content-Disposition": f'inline; filename="portrait.{extension}"',
            "Server-Timing": f"total;dur={total * 1000:.1f}",
        },
    )


# Self-hosted fonts: pin the MIME type so it never depends on the host OS registry (Windows can lack .woff2).
mimetypes.add_type("font/woff2", ".woff2")
# Locally bundled MediaPipe segmenter (vendor/mediapipe): module JS, WASM and the model need exact types
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("application/octet-stream", ".tflite")

if (PROJECT_DIR / "index.html").is_file():
    @app.get("/", include_in_schema=False)
    async def frontend_index() -> FileResponse:
        return FileResponse(PROJECT_DIR / "index.html", media_type="text/html")

    for asset_directory in ("css", "js", "fonts", "vendor"):
        asset_path = PROJECT_DIR / asset_directory
        if asset_path.is_dir():
            app.mount(
                f"/{asset_directory}",
                StaticFiles(directory=asset_path),
                name=f"frontend-{asset_directory}",
            )

    @app.get("/{filename}", include_in_schema=False)
    async def frontend_root_asset(filename: str) -> FileResponse:
        # config.xml (Cordova build config) is deliberately NOT served.
        if filename not in {"favicon.ico", "icon.png", "robots.txt"}:
            raise HTTPException(status_code=404, detail="Not found")
        asset_path = PROJECT_DIR / filename
        if not asset_path.is_file():
            raise HTTPException(status_code=404, detail="Not found")
        return FileResponse(asset_path)
