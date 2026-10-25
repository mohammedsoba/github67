# Deploying YoFilter to Railway

## What is in the repository (and what is not)

| Item | Role |
|---|---|
| `Procfile` | `web: uvicorn app:app --host 0.0.0.0 --port $PORT` (Railway injects `$PORT`) |
| `app.py` | 1-line re-export of the real app `backend.app.main:app` so `app:app` resolves from the project root |
| `requirements.txt` / `.python-version` | dependencies (pinned to the CI-tested numerics) / Python 3.11 (what CI tests) |
| `backend/app/models_bootstrap.py` | downloads missing `.onnx` models from Hugging Face at start-up, SHA-256 verified, atomic |
| `backend/models/MODELS.sha256` | integrity manifest (tracked). The `.onnx` files themselves are git-ignored. |

Railway cannot pull Git LFS objects, which is why the models are fetched at runtime instead of being committed.

## 1. Push to GitHub

```bash
git init -b main                      # (skip if the repo already exists)
git add -A
git ls-files | grep -i onnx           # MUST print nothing
git commit -m "Prepare Railway deployment"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

If an earlier push already stored the models in LFS or in history, start from a fresh repository (or rewrite history);
otherwise the old objects still count against GitHub limits.

## 2. Create the Railway service

1. Railway -> **New Project** -> **Deploy from GitHub repo** -> pick the repository (root directory = repo root).
2. **Variables** tab:

   | Variable | Value | Why |
   |---|---|---|
   | `YOFILTER_ENV` | `production` | hides `/docs`, trims `/health`, adds security headers. **Already baked into the Docker image**; set it here too only for Procfile / Nixpacks deploys (or to be explicit) |
   | `TRUST_PROXY` | `1` | **Required - NOT baked into the image.** Railway terminates TLS and proxies every request: needed for per-client rate limiting and HSTS (see section 2c) |
   | `TRUSTED_PROXY_HOPS` | `1` *(optional; the default when `TRUST_PROXY=1`)* | how many of your proxies sit in front of the app; the client IP is the `X-Forwarded-For` entry that many places from the right |
   | `ALLOWED_ORIGINS` | *(only if another website calls the API)* comma-separated, include `https://localhost` for the Android app | CORS allow-list |

   Do **not** set `LAMA_MODEL_PATH` / `PORTRAIT_MODEL_PATH`. Optional: `MODEL_BASE_URL`, `MODEL_VERIFY_ON_START`, `RATE_LIMIT_PER_MIN`,
   and the portrait load knobs below.

   **Portrait load protection.** `/api/portrait` uses the same bounded-queue policy as `/api/erase`: `PORTRAIT_MAX_CONCURRENCY` (default `1`)
   jobs run, `PORTRAIT_MAX_QUEUE` (default `4`) wait, and anything beyond that - or a wait longer than `PORTRAIT_QUEUE_WAIT_S` (default `90`) -
   gets `503` "busy" with `Retry-After: 5` instead of piling up. `PORTRAIT_TIMEOUT_S` (default `120`) limits only the compute time. Photos are
   shrunk to `PORTRAIT_MAX_SIDE` (default `2048` px, longest side) while decoding: measured post-depth memory is ~90 MB per megapixel, so a 24 MP
   photo needed ~2 GB for one job and now needs ~0.5 GB. Size the plan for the models (both stay loaded) plus `PORTRAIT_MAX_CONCURRENCY` x
   that figure; on a small plan set `PORTRAIT_MAX_SIDE=1600`.

   **One CPU, one heavy job.** Erase (LaMa) and portrait share ONE pool of slots, `AI_MAX_CONCURRENCY` (default `1`), so they never run side by
   side and fight for the same core. Each endpoint keeps its own waiting queue (`ERASE_MAX_QUEUE` / `PORTRAIT_MAX_QUEUE`) and its own wait limit
   (`ERASE_QUEUE_WAIT_S` / `PORTRAIT_QUEUE_WAIT_S`, both `90`); a request that cannot get a slot in time gets `503` "busy" + `Retry-After: 5` and the
   page shows a retry message. The portrait model uses `PORTRAIT_THREADS` ONNX threads (default `0` = the container's CPU quota, so a 1-vCPU
   service gets 1 thread); on a bigger plan raise `AI_MAX_CONCURRENCY` only if memory allows it (each portrait job needs ~0.5 GB at 2048 px).

   **Upload guard (before parsing).** `backend/app/body_guard.py` refuses oversized uploads *before* FastAPI parses or spools the body: a declared
   `Content-Length` above the route limit is answered `413` immediately (`/api/portrait` 25 MB + 1 MB framing, `/api/erase` 2 x 25 MB + 1 MB), a
   chunked / lying body is counted chunk by chunk and cut off with `413` the moment it passes the limit, and at most `MAX_INFLIGHT_UPLOADS`
   (default `8`) requests / `MAX_INFLIGHT_UPLOAD_MB` (default `256`) reserved megabytes are in memory at once (uploading, queued or processing) -
   the rest get `503` + `Retry-After: 5`. Tune `BODY_OVERHEAD_BYTES` only if you add large form fields.

   **Run exactly ONE uvicorn worker** (the Procfile default). The slot pool, the queues, the rate limiter and both models live in the
   process: with `WEB_CONCURRENCY` > 1 every worker gets its own copy of all of them, so the shared limit and the memory sizing above stop
   being true. The server logs a warning at startup if it sees `WEB_CONCURRENCY` > 1. A busy answer carries `Retry-After`, which is exposed
   through CORS so the Android app can read it; the page waits that long (2-10 s) and retries a busy portrait request twice before it shows
   "Portrait is busy right now" with a Try again button.

   **Browser-side downscale.** The page shrinks a portrait photo to 2048 px (`UPLOAD_MAX_SIDE` in `js/portrait/portrait-mode.js`, keep it equal to
   `PORTRAIT_MAX_SIDE`) before uploading it; a fully opaque photo is JPEG-encoded once at quality 0.92 (`UPLOAD_JPEG_QUALITY`; set it to `0` to
   upload lossless PNG instead), a photo with transparency stays PNG. The working image and the result stay lossless PNG, and any failure falls back
   to uploading the original. Typical upload: ~8 MB PNG -> well under 1 MB.
3. **Settings -> Networking -> Generate Domain**. The site (frontend + API) is served from that one origin.

## 2b. Docker build (recommended): models baked into the image

The repository root has a multi-stage `Dockerfile` and a `railway.json` that pins it, so Railway builds the image instead of using
Nixpacks / the Procfile (keep the Procfile for plain `uvicorn` hosts).

* **Stage 1 (`models`)** downloads `inpainting_lama.onnx` and `portrait_depth.onnx` from Hugging Face *at build time* (4 attempts),
  then `scripts/verify_models.py` checks them against `backend/models/MODELS.sha256`. The build **fails** if the manifest is missing,
  empty, malformed or lacks a required model; if a download fails; or if a file is missing, tiny (LFS pointer), corrupt, unlisted or
  left half-downloaded. The same check runs once more on the final image filesystem.
* **Runtime** has `MODEL_AUTO_DOWNLOAD=0`: the container never contacts Hugging Face. A model that is somehow absent keeps
  `/readyz` and `/health` at `503` instead of silently downloading.
* Optional: host the models yourself and set `MODEL_BASE_URL` as a Railway service variable (Railway passes variables to the build as
  build args). The hashes in the manifest still decide what is accepted.
* Rebuilds only re-download when `MODELS.sha256` (or the fetch scripts) change; code changes reuse the cached model layer.

Set the service's **health check path to `/readyz`** (already in `railway.json`, timeout 300 s).

| Probe | Meaning | Answers |
|---|---|---|
| `GET /livez` | process is up (liveness) - never looks at models | always `200 {"status":"alive"}` |
| `GET /readyz` | may receive traffic (readiness) | `200` only when both models are loaded **and** the LaMa warm-up pass is done; otherwise `503` + `Retry-After: 5` with `status` = `starting` / `warming_up` / `unavailable` |
| `GET /health` | model summary for humans / monitors | `200` only when **both** models are loaded, else `503` (`status: degraded`) |

The HTTP port now opens immediately and the models load in the background (`BLOCK_STARTUP_ON_MODELS=0`, the default), so the platform
never sees a closed port during a cold start. API calls that arrive before the models are loaded get `503` + `Retry-After` with
"The server is starting", and the page retries. Set `READY_WAITS_FOR_WARMUP=0` if you want `/readyz` to turn green as soon as the
models are loaded (the first erase may then wait for the warm-up pass).

**Start-up policy of the Docker image** (set in the `Dockerfile`, override with Railway service variables):

| Variable | Image value | Effect |
|---|---|---|
| `READY_WAITS_FOR_WARMUP` | `1` | `/readyz` stays `503 warming_up` until the LaMa warm-up pass is done, so the first real erase never queues behind it |
| `YOFILTER_ENV` | `production` | locks the image to the production profile (no `/docs`, trimmed `/health`, security headers, CORS = native app only); see section 2c |
| `EXIT_ON_MODEL_LOAD_FAILURE` | `1` | if LaMa or the portrait model is not loaded once start-up has finished, the process logs `Required model(s) failed to load: ...` and exits with status `1`; Railway's `ON_FAILURE` restart policy (`restartPolicyMaxRetries` 5) then retries the boot. Code default is `0` (local development / tests keep a degraded server and that endpoint answers `503`). A failed *warm-up* only logs - it never exits |

**MediaPipe is vendored, never loaded from a CDN.** A dedicated Docker stage (`mediapipe`) downloads the pinned `@mediapipe/tasks-vision`
npm tarball (`vision_bundle.mjs` + `wasm/*`) and the `selfie_multiclass_256x256.tflite` model (`float32/1/`, not `latest`), and verifies every
file against `scripts/MEDIAPIPE.sha256`. The build fails if the manifest is missing/unpinned, a download fails, or any file is missing, tiny,
different, or unlisted; the same check runs again on the final image. The backend serves the files from its own origin (`/vendor/mediapipe/...`)
and the page's CSP no longer lists `cdn.jsdelivr.net` or `storage.googleapis.com`.

**One-time step before the first Docker build:** `python scripts/fetch_mediapipe_assets.py --pin` on a machine with internet, review
`scripts/MEDIAPIPE.sha256`, commit it. Bumping `VERSION` / `MODEL_VERSION` in the script (and `VERSION` in `js/core/segmenter-service.js`) means re-pinning.
Without Docker (Procfile / Nixpacks) run `python scripts/fetch_mediapipe_assets.py` in the build step; the server logs a warning at start-up if
`vendor/mediapipe` is empty. The on-device portrait runtime (`vendor/ort`) is still NOT in the image: portrait then uses the server.

## 2c. Production lock-down: `YOFILTER_ENV` (baked in) and `TRUST_PROXY` (you set it)

**`YOFILTER_ENV=production` is baked into the Docker image** (runtime stage `ENV` in the `Dockerfile`), so a Railway deploy can no longer fall
back to the development profile by forgetting a variable. In production the app: serves no `/docs`, `/redoc` or `/openapi.json` (404),
answers `/health` with only `status` + the two model flags (no model paths, providers or dependency versions), sends the security headers
and restricts CORS to `https://localhost` (the packaged Android app) unless `ALLOWED_ORIGINS` says otherwise. A Railway service variable
of the same name still overrides the image value (only ever set it to `production`).

**`TRUST_PROXY=1` must be set on Railway** - it is deliberately *not* in the image, because the `X-Forwarded-For` header is spoofable when a
container is reachable directly. Railway always puts its own proxy in front of the service, so there it is safe and required:

1. Railway -> your service -> **Variables** -> **New Variable** (or **Raw Editor**).
2. Add `TRUST_PROXY` = `1` (leave `TRUSTED_PROXY_HOPS` unset; it then defaults to 1 hop = Railway's edge proxy).
3. Save. Railway stages the change: click **Deploy** (or let it auto-apply) so the service restarts with the new variable. No rebuild of the
   model layers is needed; a variable change only restarts the container.
4. Verify in the deploy log: there must be **no** `Rate limiter: ... no usable client address` line.

What it fixes: the rate limiter (`RATE_LIMIT_PER_MIN`, default 30 `POST /api/*` per client per minute) keys on the client IP. Without
`TRUST_PROXY`, every request arrives from Railway's proxy address, so **all visitors share one bucket** and the 31st POST of the whole site in a
minute gets `429`. With `TRUST_PROXY=1` the app takes the client IP from the `X-Forwarded-For` entry 1 place from the right (the one Railway's
proxy appended; anything the client put to its left is ignored), so each visitor has an own bucket (IPv6 clients per `/64`).

Check it (replace the domain; the body does not matter, you only need the status codes):

```bash
for i in $(seq 1 35); do
  curl -s -o /dev/null -w "%{http_code} " -X POST https://<your-domain>/api/portrait
done; echo
```

Expect a run of non-`429` codes (e.g. `400`/`422` for the empty body) and then `429` from roughly the 31st request, while a request from a
*different* network (phone on mobile data) at the same moment is **not** throttled. If everyone is throttled together, `TRUST_PROXY` is missing
or not applied yet. If you put a CDN / Cloudflare in front of Railway, set `TRUSTED_PROXY_HOPS=2` instead (it overrides `TRUST_PROXY`).
Never set `TRUST_PROXY` when the container is exposed without a proxy (plain `docker run -p`): any client could then pick its own IP.

Quick check of the lock-down: `curl -i https://<your-domain>/docs` -> `404`, and `curl https://<your-domain>/health` -> only `status`,
`model_loaded`, `portrait_model_loaded`.

## 3. First boot - what you should see in the deploy logs

```
[models] downloading inpainting_lama.onnx (attempt 1/3)
[models] inpainting_lama.onnx ready: 92.6 MB in ... s
[models] downloading portrait_depth.onnx (attempt 1/3)
[models] portrait_depth.onnx ready: 99.4 MB in ... s
YoFilter ready - eraser: CPUExecutionProvider | portrait: CPUExecutionProvider
```

With the Docker build there is no `[models] downloading ...` line: the files are already in the image and the log shows

```
Listening - models load in the background (/livez: alive now, /readyz: ready when loaded)
YoFilter ready - eraser: CPUExecutionProvider | portrait: CPUExecutionProvider (models loaded in ... s)
```

(Without Docker - Procfile / Nixpacks - the `[models] downloading ...` lines above still appear on every start, because the container
filesystem is ephemeral; `MODEL_AUTO_DOWNLOAD=1` is the default there.)

Check `https://<your-domain>/readyz` -> `{"status":"ready","ready":true,"model_loaded":true,"portrait_model_loaded":true}` and
`https://<your-domain>/health` -> `{"status":"ok","model_loaded":true,"portrait_model_loaded":true}`.

## 4. After the first deploy

* **Client IP for rate limiting.** With `TRUSTED_PROXY_HOPS=N` (default 1 when `TRUST_PROXY=1`) `limits.py` keys on the `X-Forwarded-For`
  entry N places from the right; anything to its left is client-supplied and ignored. IPv6 clients are keyed by their `/64`
  network, IPv4 by address. Send ~35 quick POSTs from one browser/IP: you should get `429` after ~30 and *other* visitors must not
  be throttled by them. If everyone shares one bucket, the log shows `Rate limiter: ... no usable client address` once - raise or
  lower `TRUSTED_PROXY_HOPS` to match the number of proxies in front of the app (e.g. 2 if a CDN sits in front of Railway).
* **Memory.** Both models load at boot. Watch the Metrics tab and size the plan accordingly.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ModuleNotFoundError: app` | `app.py` or `Procfile` not at the repo root of the deployed service |
| `/readyz` stays `503` / `/health` shows `"status":"degraded"` | `starting` / `warming_up`: wait (cold start); `unavailable`: a model failed to load - read the deploy log (`LaMa model failed to load` / `Portrait depth model failed to load`). Docker build fails with `MODEL VERIFICATION FAILED`: the manifest or a download is wrong - the message names the file. Without Docker: read the `[models]` lines (network/URL, wrong file name, hash mismatch) |
| Deploy keeps restarting, log says `Required model(s) failed to load` | `EXIT_ON_MODEL_LOAD_FAILURE=1` is doing its job: the lines above it name the model and the cause (`LaMa model failed to load` / `Portrait depth model failed to load`); after 5 retries Railway marks the deploy failed. Fix the model, or set `EXIT_ON_MODEL_LOAD_FAILURE=0` temporarily to keep a degraded server up |
| Docker build stops in stage `mediapipe` with `MEDIAPIPE MANIFEST PROBLEM` | `scripts/MEDIAPIPE.sha256` is not pinned yet (or lacks a required file): run `python scripts/fetch_mediapipe_assets.py --pin`, review, commit |
| AI Mask / Background Removal say the model could not load | `/vendor/mediapipe/vision_bundle.mjs` answers 404: the assets are not in the deployment (see the start-up warning `MediaPipe assets are missing`) |
| `SHA-256 mismatch` | the file in Hugging Face differs from `MODELS.sha256` - re-upload the right model or update the manifest |
| Every visitor gets `429` | `TRUST_PROXY` not set to `1` (all clients look like the proxy) |
| `/docs` returns 404 | expected: `YOFILTER_ENV=production` hides it |
