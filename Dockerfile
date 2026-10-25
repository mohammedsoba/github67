# YoFilter - production image (Railway / any container host).
#
#   stage 1 "models"  : downloads the two ONNX models from Hugging Face AT BUILD TIME and verifies them against
#                       backend/models/MODELS.sha256. Any problem (manifest missing / empty / lacking a required model,
#                       download failed, wrong or corrupt file) FAILS THE BUILD - an image without verified models is never produced.
#   stage 1b "mediapipe": downloads the pinned MediaPipe segmenter (npm tarball + .tflite model) and verifies every file against
#                       scripts/MEDIAPIPE.sha256, so AI Mask / Background Removal never load anything from a CDN. Fails the build the same way.
#   stage 2 "builder" : installs the pinned Python dependencies into a virtualenv (wheels only, no compilers).
#   stage 3 "runtime" : slim image = venv + app code + the verified models. Runs as a non-root user and NEVER touches the
#                       network for models (MODEL_AUTO_DOWNLOAD=0); the models are re-verified once more on the final layers.
#
# Build:  docker build -t yofilter .            (optional: --build-arg MODEL_BASE_URL=https://mirror.example/folder)
# Run:    docker run --rm -p 8000:8000 yofilter        (YOFILTER_ENV=production is already baked into the image)
# Railway: this file is picked up automatically (railway.json pins it); set MODEL_BASE_URL as a service variable ONLY if you
#          host the models yourself - Railway passes service variables to the build as build args.
#          ALSO set TRUST_PROXY=1 as a service variable (per-client rate limiting behind Railway's proxy) - see docs/RAILWAY_DEPLOY.md.

ARG PYTHON_IMAGE=python:3.11-slim-bookworm


# ---------------------------------------------------------------- stage 1: verified models
FROM ${PYTHON_IMAGE} AS models
ARG MODEL_BASE_URL=""
WORKDIR /build
# Only what the stage needs, so a code change never invalidates the (large) download layer.
COPY backend/models/MODELS.sha256 backend/models/MODELS.sha256
COPY scripts/fetch_models.py scripts/verify_models.py scripts/
RUN set -eu; \
    # 1) fail fast, BEFORE downloading ~190 MB: the manifest must exist, parse and list every required model
    python scripts/verify_models.py --manifest-only; \
    # 2) download whatever is missing, retrying transient network errors (each file is hash-checked by fetch_models.py)
    ok=0; \
    for attempt in 1 2 3 4; do \
        if python scripts/fetch_models.py; then ok=1; break; fi; \
        echo "model download attempt ${attempt} failed" >&2; sleep $((attempt * 5)); \
    done; \
    test "${ok}" = 1; \
    # 3) independent final verdict: every required file present, big enough, SHA-256 equal, nothing unlisted
    python scripts/verify_models.py


# ---------------------------------------------------------------- stage 1b: verified MediaPipe assets (vendor/mediapipe)
FROM ${PYTHON_IMAGE} AS mediapipe
WORKDIR /build
# Only what the stage needs, so a code change never invalidates the download layer.
COPY scripts/MEDIAPIPE.sha256 scripts/MEDIAPIPE.sha256
COPY scripts/fetch_mediapipe_assets.py scripts/
RUN set -eu; \
    # 1) fail fast: the manifest must exist, parse and list the bundle, the wasm files and the model (run --pin once and commit it)
    python scripts/fetch_mediapipe_assets.py --manifest-only; \
    # 2) download whatever is missing, retrying transient network errors (every file is hash-checked against the manifest)
    ok=0; \
    for attempt in 1 2 3 4; do \
        if python scripts/fetch_mediapipe_assets.py; then ok=1; break; fi; \
        echo "mediapipe download attempt ${attempt} failed" >&2; sleep $((attempt * 5)); \
    done; \
    test "${ok}" = 1; \
    # 3) independent final verdict, no network: every listed file present, big enough, SHA-256 equal, nothing unlisted
    python scripts/fetch_mediapipe_assets.py --check


# ---------------------------------------------------------------- stage 2: python dependencies
FROM ${PYTHON_IMAGE} AS builder
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
COPY requirements.txt .
# --only-binary: the pinned versions are installed as the exact wheels that were tested; a source build would fail the image.
RUN pip install --only-binary=:all: -r requirements.txt


# ---------------------------------------------------------------- stage 3: runtime
FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:${PATH}" \
    PORT=8000 \
    MODEL_AUTO_DOWNLOAD=0 \
    READY_WAITS_FOR_WARMUP=1 \
    EXIT_ON_MODEL_LOAD_FAILURE=1 \
    YOFILTER_ENV=production
# YOFILTER_ENV=production is baked into the image so a deploy can never silently fall back to the development profile: it hides
# /docs, /redoc and /openapi.json, trims /health (no model paths / provider / dependency details), adds the security headers and
# flips the CORS default to the native-app origin only. A service variable of the same name (Railway) still overrides it.
# TRUST_PROXY is deliberately NOT baked in: it is only safe behind YOUR reverse proxy (X-Forwarded-For is spoofable when the
# container is exposed directly), so set TRUST_PROXY=1 as a Railway service variable (docs/RAILWAY_DEPLOY.md, section 2c).
# libgomp1: OpenMP runtime used by numpy / OpenCV builds. Nothing else is installed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 yofilter \
    && useradd --system --uid 10001 --gid yofilter --home-dir /app --shell /usr/sbin/nologin yofilter
WORKDIR /app

COPY --from=builder /opt/venv /opt/venv
# Application code + the static front-end the backend serves (see .dockerignore: no tests, docs, Cordova files, local models, vendor/).
COPY --chown=yofilter:yofilter app.py version.json index.html favicon.ico icon.png robots.txt ./
COPY --chown=yofilter:yofilter backend ./backend
COPY --chown=yofilter:yofilter css ./css
COPY --chown=yofilter:yofilter js ./js
COPY --chown=yofilter:yofilter fonts ./fonts
# vendor/ is never taken from the build context (.dockerignore). Only the verified MediaPipe assets are added below (stage "mediapipe"); the
# on-device portrait runtime (vendor/ort) is NOT baked in - portrait then uses the server (see vendor/ort/README.md).
COPY --chown=yofilter:yofilter scripts/verify_models.py scripts/docker_healthcheck.py scripts/fetch_mediapipe_assets.py scripts/MEDIAPIPE.sha256 ./scripts/
# The verified models from stage 1 (the manifest next to them came with `COPY backend`).
COPY --from=models --chown=yofilter:yofilter /build/backend/models/*.onnx ./backend/models/
# The verified MediaPipe assets from stage 1b: the page loads them from this origin (/vendor/mediapipe/...), never from a CDN.
COPY --from=mediapipe --chown=yofilter:yofilter /build/vendor/mediapipe ./vendor/mediapipe

# Fail-closed gate on the FINAL filesystem: if anything above copied a wrong / missing / extra model, the build stops here.
RUN python scripts/verify_models.py && python scripts/fetch_mediapipe_assets.py --check

USER yofilter
EXPOSE 8000

# Liveness only (/livez): a slow model load must never mark the container unhealthy. Railway ignores HEALTHCHECK and uses
# healthcheckPath from railway.json (/readyz).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "scripts/docker_healthcheck.py", "/livez"]

# A required model that fails to load makes the process exit 1 (EXIT_ON_MODEL_LOAD_FAILURE=1) -> Railway's ON_FAILURE restart policy retries.
# ONE worker on purpose (the slot pool, queues, rate limiter and both models live in the process). `exec` makes uvicorn PID 1,
# so SIGTERM from the platform triggers a graceful shutdown. $PORT is injected by Railway.
CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --no-server-header --timeout-graceful-shutdown 20"]
