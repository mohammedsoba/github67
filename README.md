# YoFilter

Mobile-first photo editor (HTML/CSS/JavaScript, WebGL) served by a small FastAPI backend that runs two
bundled ONNX models locally:

- **Magic Eraser** - LaMa inpainting (`POST /api/erase`)
- **Portrait** - Depth Anything V2 Small background blur plus natural skin smoothing (`POST /api/portrait`)

## Run

```bash
python -m pip install -r requirements.txt
uvicorn backend.app.main:app --host 0.0.0.0 --port 8080
```

Open **http://localhost:8080**. The backend serves the frontend and the API from the same origin and the page
calls relative paths (`/api/...`), so any port works. If the page is hosted elsewhere, open it with
`?api=http://host:port` or set `PRODUCTION_API_BASE` in `js/config/app-config.js`.

**Packaged Android app (Cordova).** The app cannot use a relative URL, so it needs the HTTPS origin of your deployed
backend. That value lives in ONE place, `native_api_base` in `version.json`; never edit the copies by hand:

```
python scripts/sync_version.py --native-api-base https://api.yourdomain.com   # validates, writes version.json, stamps the copies
python scripts/sync_version.py --release                                     # build gate: exits 1 while it is empty or any copy drifts
```

It stamps `NATIVE_API_BASE` (`js/config/app-config.js`), the `connect-src` of the CSP in `index.html` and the
`<access origin>` in `config.xml`. Unset (the default) means no host is listed anywhere and the packaged app answers
"AI server address is not set"; the browser build is unaffected. Add the same origin to the backend's `ALLOWED_ORIGINS`
only if the *page* is served from elsewhere; the Android app's own origin (`https://localhost`) is already the production default.

The terminal stays quiet: a one-line "ready" notice, uvicorn's "running on" line, then only failed requests
(status 400+), warnings and tracebacks.

## Project layout

```
backend/app/   main.py (routes, errors, static files)   lama.py (eraser)   portrait.py + skin.py (portrait)
               ort_utils.py (ONNX sessions, DirectML->CPU fallback)   config.py   log.py (console logging)
backend/models/  inpainting_lama.onnx, portrait_depth.onnx
vendor/ort/      pinned onnxruntime-web for on-device portrait (python scripts/fetch_ort.py --pin)
vendor/mediapipe/ pinned MediaPipe segmenter, served same-origin, no CDN (python scripts/fetch_mediapipe_assets.py --pin)
js/ css/ index.html   frontend (config, core, editing, overlays, portrait, ui, i18n)
fonts/                self-hosted WOFF2 fonts (Inter Latin, Noto Sans Arabic) - no third-party font requests
docs/                 perf-baseline.md (first-load metrics)
config.xml version.json icon.png favicon.ico robots.txt   Cordova wrapper + static assets (config.xml is never served by the backend)
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /livez` | Liveness: always `200` while the process answers (never checks models). |
| `GET /readyz` | Readiness: `200` only when both models are loaded and warm; otherwise `503` + `Retry-After` (`starting` / `warming_up` / `unavailable`). Use it as the platform health check. |
| `GET /health` | Model status; `503` if ANY required model is missing. Production (`YOFILTER_ENV=production`): only `status`, `model_loaded`, `portrait_model_loaded`. Development: also warm-up state, model paths, providers and dependency versions. |
| `POST /api/erase` | Multipart `image` + `mask` (white = remove) and optional `ref_size`. Returns a PNG of the input size. |
| `POST /api/portrait` | Multipart `image`; form fields `blur_level` (1-30, default 1 = untouched), `skin_smooth` (0-100, default 0 = off), `focus_x` / `focus_y` (0-1). Returns JPEG, or PNG if the upload has transparency. |
| `GET /docs`, `/redoc`, `/openapi.json` | Interactive API documentation - **development only** (not mounted in production). |

Errors are always JSON **with CORS headers**: 400 bad input, 413 over 25 MB, 422 invalid field, 503 model not loaded
(the reason is included), 504 portrait timeout, 500 anything else (message quotes a `ref` id that matches the server log).

**Eraser.** The 512x512 network only sees a square crop around the painted area (hole + context, mirrored where it
leaves the photo). Only the masked pixels plus a thin feather are pasted back after a seam colour match, so
everything else stays byte-identical. The client uploads just that window (`js/editing/erase-window.js`) and sends
`ref_size`, giving exactly the same pixels as a full-photo upload. The crop formula in `lama.py` (`crop_side`) and
`erase-window.js` must stay in sync.

**Portrait.** Depth drives a gradual DSLR-style blur with edge-aware guided filtering, so subject, hair and clothing
stay sharp. Skin smoothing (`skin.py`) detects faces and skin tone, protects eyes, brows, lips, hair and edges, and
smooths by frequency separation so texture is kept. If smoothing fails the request still returns the plain bokeh result.

## Configuration (environment variables)

| Variable | Default | Effect |
|---|---|---|
| `YOFILTER_LOG_LEVEL` | `INFO` | `DEBUG` shows model/session details. |
| `LAMA_PROFILE` | `0` | `1` prints a per-request eraser timing table (the `Server-Timing` header is always sent). |
| `LAMA_WARMUP_PASSES` | `1` | Silent background warm-up passes at start; `0` skips. |
| `LAMA_PROVIDER` / `LAMA_DML_DEVICE` | `auto` / `0` | `auto`, `dml` or `cpu`. DirectML (Windows GPU) falls back to CPU automatically. |
| `PORTRAIT_PROVIDER` | `cpu` | `auto` or `dml` to run the portrait model on DirectML. |
| `LAMA_THREADS` | auto | CPU threads for ONNX (respects affinity and container quotas). |
| `LAMA_MODEL_PATH` / `PORTRAIT_MODEL_PATH` | bundled | Override model locations. |
| `MODEL_BASE_URL` | Hugging Face repo | Folder URL the `.onnx` models are downloaded from at start-up when missing (`<url>/<filename>`). |
| `MODEL_AUTO_DOWNLOAD` | `1` | `0` = never download (a missing model then disables only its endpoint). |
| `MODEL_VERIFY_ON_START` | `0` | `1` = SHA-256 the existing model files at start and re-download corrupt ones (default: size check only). |
| `MODEL_DOWNLOAD_TIMEOUT` / `MODEL_DOWNLOAD_ATTEMPTS` | `60` / `3` | Per-socket-operation timeout (s) and tries per file. |
| `PORTRAIT_TIMEOUT_S` | `120` | Compute-time cap per portrait request (queue wait is NOT counted; over it -> `504`). |
| `AI_MAX_CONCURRENCY` | larger of `ERASE_MAX_CONCURRENCY` / `PORTRAIT_MAX_CONCURRENCY` (`1`) | Heavy jobs (LaMa erase + portrait) running at once, **shared**: one erase and one portrait never overlap on the same CPU. `ERASE_MAX_CONCURRENCY` / `PORTRAIT_MAX_CONCURRENCY` now only seed this default. |
| `PORTRAIT_THREADS` | `0` (= CPU quota) | ONNX Runtime threads for the portrait model. `0` follows the container's real CPU quota (cgroup), so 1 vCPU = 1 thread; OpenCV's pool is capped to the same number. |
| `PORTRAIT_MAX_QUEUE` / `PORTRAIT_QUEUE_WAIT_S` | `4` / `90` | Portrait requests allowed to WAIT for a slot, and the longest one may wait; a full queue or a timed-out wait answers `503` "busy" + `Retry-After: 5`. |
| `PORTRAIT_MAX_SIDE` | `2048` | Photos are shrunk to this longest side (px) while decoding, before the memory-hungry stages; the returned image has that size. Lower it (e.g. `1600`) on a small plan; `0` = never shrink. |
| `YOFILTER_ENV` | `development` (the Docker image bakes in `production`) | `production` hides `/docs`, `/redoc`, `/openapi.json`, trims `/health`, adds the security headers (`X-Content-Type-Options`, CSP incl. `frame-ancestors 'none'`, `X-Frame-Options`, `Referrer-Policy`, HSTS on HTTPS) and flips the CORS default (below). |
| `ALLOWED_ORIGINS` | dev: `*` / production: `https://localhost` | Comma-separated CORS allow-list, e.g. `https://yofilter.app,https://www.yofilter.app`. Unset in production = only the packaged Android app (`https://localhost`) may call cross-origin; the browser build is same-origin and needs no CORS. If you set it, include `https://localhost` to keep the native app working. An explicit `*` is honoured but logs a production warning. |
| `RATE_LIMIT_PER_MIN` | `30` | Token bucket per client for `POST /api/*`; over the limit -> `429` + `Retry-After`. `0` disables. |
| `TRUST_PROXY` | `0` | Legacy shorthand for `TRUSTED_PROXY_HOPS=1`. Set it only behind your own reverse proxy; never when the app is directly exposed (the header is spoofable). Set it to `1` on Railway (see `docs/RAILWAY_DEPLOY.md`). |
| `TRUSTED_PROXY_HOPS` | unset (`1` if `TRUST_PROXY=1`, else `0`) | Number of your reverse proxies in front of the app (max 10). The client IP is the `X-Forwarded-For` entry that many places from the right; `0` ignores the header. When set it overrides `TRUST_PROXY`. IPv6 clients are rate-limited per `/64`. |
| `BLOCK_STARTUP_ON_MODELS` | `0` | `0`: the port opens at once and models load in the background (`/readyz` 503 until ready). `1`: wait for the models before accepting connections (used by the test-suite). |
| `READY_WAITS_FOR_WARMUP` | `1` | `/readyz` also waits for the LaMa warm-up pass. |
| `ERASE_MAX_CONCURRENCY` / `ERASE_MAX_QUEUE` | `1` / `4` | Seeds `AI_MAX_CONCURRENCY` (see above), and how many erase requests may wait for a slot; a full queue answers `503` + `Retry-After: 5`. |
| `ERASE_QUEUE_WAIT_S` | `90` | Longest an erase may wait for a slot (the pool is shared with portrait); then `503` "busy" + `Retry-After: 5`. |
| `ERASE_MAX_PIXELS` | `64000000` | Decoded-size cap for `/api/erase` uploads (checked from the header, no decode); larger -> `400`. |
| `ERASE_MAX_SELECTION_WIDTH` | `1024` (constant, not an env var) | Widest painted selection `/api/erase` accepts (bounding box of the white mask pixels, photo px); wider -> `400` with `code: SELECTION_TOO_LARGE` and an English + Arabic message. The browser enforces the same limit before uploading (`MAX_SELECTION_WIDTH` in `js/editing/erase-window.js`; a test keeps both equal). |

Each model loads independently: a missing or broken file disables only its own endpoint (503 with the reason) and
never stops the server. A failed portrait model is retried on the next request.


## On-device portrait (optional, hybrid)

The 99 MB portrait model can be downloaded once on first use and run locally; everything else falls back to the server.
Off until `edge_model_url` is set in `version.json` (`python scripts/sync_version.py --edge-model-url https://...`).
See `docs/EDGE_AI_PORTRAIT.md` (flow, limits, hosting requirements, what is not yet device-verified).

## Deploying to Railway

`Procfile` + `app.py` + `requirements.txt` + `.python-version` are all Railway needs. The ONNX models are **not** in the
repository: the app downloads them from Hugging Face on start-up (`backend/app/models_bootstrap.py`). Step-by-step
instructions, variables and troubleshooting: [`docs/RAILWAY_DEPLOY.md`](docs/RAILWAY_DEPLOY.md).

**Docker:** `docker build -t yofilter .` bakes the verified ONNX models into the image (build fails closed on a missing/corrupt model); see `docs/RAILWAY_DEPLOY.md` section 2b.
