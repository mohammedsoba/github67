# On-demand Edge AI for Portrait (first-use download, local inference)

Status: implemented and unit-tested in Node. **Not yet verified on a real device** - see "What is and is not verified".

## 1. What changed

The ~99 MB `portrait_depth.onnx` (Depth-Anything-V2-Small) never lived inside the APK - it lives on the server
(`backend/models/`) and portrait ran through `POST /api/portrait`. This feature adds a second, **on-device** path:

| | Before | Now (hybrid) |
|---|---|---|
| Model location | server only | server **and**, after a one-time download, the device's Cache API |
| Portrait without skin smoothing | server round trip | on-device (offline-capable once cached) |
| Portrait with skin smoothing (`skin_smooth > 0`) | server | **server** (the skin stage is not ported) |
| Any local failure | - | silent fall back to the unchanged server request |
| APK size | unchanged | unchanged (the model is downloaded, never bundled) |

The feature is **off until a model URL is configured** (section 6). With no URL, behaviour is exactly V26.

## 2. Flow

```
Apply / slider / tap-to-focus
        |
        v
portrait-mode.js  runPortraitRequest()
        |  YoEdgePortrait.canHandle({skin})?  --no--> server request (unchanged)
        v yes
YoEdgePortrait.run(baseBlob, {level, focus})
        |
        |-- YoEdgeModel.ensure()                      single flight, shared by every caller
        |      |-- cached + right size?  -> done (no network)
        |      '-- else download -> exact size -> SHA-256 -> Cache API -> prune old versions
        |          (progress card: 0-100 %, MB, Cancel;  failure: reason + Retry)
        |-- worker session (once per app session)     model ArrayBuffer TRANSFERRED to js/workers/depth-worker.js
        |-- depth, 518x518, in the worker             onnxruntime-web, WASM/CPU, 1 thread
        |-- mask + layered disc bokeh on the main thread (js/portrait/portrait-math.js, typed arrays)
        '-- PNG blob  ---------------------------->   committed exactly like the server result (history, undo, colour edits)

null at ANY step above (not configured, cancelled, offline, runtime cannot start, local error)  ->  the server request runs.
```

Files: `js/core/edge-model.js` (cache + downloader), `js/ui/edge-model-ui.js` + `css/edge-ai.css` (card),
`js/workers/depth-worker.js` (ORT), `js/portrait/portrait-math.js` (maths), `js/portrait/edge-portrait.js` (orchestrator),
`scripts/fetch_ort.py` + `vendor/ort/` (pinned runtime), hook in `js/portrait/portrait-mode.js`.

## 3. Download, cache and the progress UI

* **Check first.** The first local run asks the Cache API (`yofilter-edge-models-v1`) for the model. A cached entry whose
  length is wrong is deleted and re-downloaded.
* **One download, however often the user taps.** `YoEdgeModel.ensure()` is single-flight: concurrent calls return the *same*
  promise. The portrait button is also disabled while a request is busy, and a newer request supersedes an older one.
* **Integrity, fail closed.** `Content-Length` must equal the expected size, the stream must end at exactly that size, and the
  SHA-256 must match (`EDGE_MODEL_CONFIG` in `js/config/app-config.js`, kept equal to `backend/models/MODELS.sha256` by a test).
  A bad file is never cached and never executed. The download goes into one pre-sized buffer (peak memory ~ the model size).
* **Storage.** Free quota is checked before downloading; `navigator.storage.persist()` is requested (best effort). A new model URL
  prunes the old entry, so versions never pile up.
* **Card (EN / AR).** A floating glass card, *not* an overlay - the editor stays usable. Text: *"Preparing AI features
  (Downloading model package once)..."* / *"جاري تجهيز ميزات الذكاء الاصطناعي (تنزيل حزمة النموذج مرة واحدة)..."*, a transform-only
  progress bar (RTL-aware), `x / y MB`, **Cancel** while downloading, a "Verifying" phase, and on failure a localised reason plus
  **Retry**. `role="status"`, `aria-live="polite"`, reduced-motion respected.
* **Failure behaviour.** Offline, interrupted, HTTP error, wrong size/hash, no space: the card shows the reason and **Retry**;
  the pending portrait request meanwhile completes through the server, so the user's action is not lost. **Cancel** switches the
  on-device path off for the rest of the session (no repeated prompts); **Retry** switches it back on.

## 4. Local inference

* `onnxruntime-web`, WASM execution provider, **single thread** (multi-threaded WASM needs cross-origin isolation, which a Cordova /
  Android WebView page does not have). It runs in a **module Web Worker**, so the UI thread is never blocked by the network.
* The runtime is **vendored** in `vendor/ort/` and pinned (`scripts/fetch_ort.py`, hashes in `vendor/ort/ORT.sha256`); nothing is
  loaded from a CDN, so the CSP needs no new script host. CSP already has `'wasm-unsafe-eval'` and `worker-src 'self' blob:`.
* **WebGL / WebGPU are not enabled.** Depth-Anything's operator coverage on those providers is unverified and a silent partial
  fallback would be slower than plain WASM; CPU is the dependable choice. Adding `'webgpu'` first in `executionProviders` is a
  one-line change in the worker once measured on target devices.
* The depth map of the last photo is cached (1 MB), so moving the blur slider or re-tapping focus never re-runs the network.

## 5. What is ported, what is not (the server stays the reference)

Ported (`portrait-math.js`): robust depth normalisation, colour guided-filter edge snapping, focal-plane mask with the long S-curve,
protected connected subject region, coarse + fine guided passes, multi-layer disc bokeh with highlight bloom, per-pixel mix.

Different on purpose: mask analysis at <= 640 px and bokeh layers at <= 1024 px (server: 1600), no bilateral/shock pre-filter on the
depth map, no morphological opening of the focus region. Results are *visually equivalent*, **not pixel-identical** to the server and
the golden backend tests do not apply to this path.

Always served by the server: `skin_smooth > 0`; photos over 25 MP; devices reporting less than 3 GB RAM (`navigator.deviceMemory`);
runtimes without Cache API / `crypto.subtle` / WebAssembly / module workers. Images with partial transparency may differ by one
level in RGB at semi-transparent pixels (canvas premultiplication); alpha itself is copied verbatim.

## 6. Hosting the model and turning it on

```
python scripts/fetch_ort.py --pin                 # once: vendor + pin the runtime, commit vendor/ort/ORT.sha256
python scripts/sync_version.py --edge-model-url https://models.yourdomain.com/v1/portrait_depth.onnx
python scripts/sync_version.py --check
```

The URL is stamped into `app-config.js` (`EDGE_MODEL_URL`), the CSP `connect-src` and `config.xml` `<access>`. Requirements for the host:

* HTTPS, a **stable path** (no query string / signed URL - it would expire inside a shipped app; the script rejects them).
* **CORS**: `Access-Control-Allow-Origin` for the app origin (`https://localhost` for the Cordova Android WebView, plus the web origin).
* **`Content-Length`** on the response (no chunked-only responses) and **no redirects to another host** (the redirect target would also have to be in the CSP).
* Serve the *exact* file whose SHA-256 is in `MODELS.sha256`. A new model version = new file name/URL + new hash in `app-config.js`.

Object storage with a CORS rule (R2, S3, GCS) fits; a GitHub release asset usually does not (cross-host redirect).

## 7. Memory discipline

Every temporary canvas is created by `withCanvas()` / `withCanvasAsync()` and set to `width = height = 0` in a `finally` (also when the
encode rejects); the decoded `ImageBitmap` is closed in `finally`; temporary blob URLs are revoked in `finally`; the model buffer is
transferred to the worker so the main thread keeps no 99 MB copy; a hung worker run is terminated after 120 s and rebuilt on demand.

## 8. What is and is not verified

Verified here (Node, `npm run test:ui`): downloader (progress, single-flight, size/hash/HTTP/offline/quota/cancel/retry, cache hygiene),
the maths on synthetic scenes (subject exact, background blurred, focal-plane flip, level monotonicity), the orchestrator against fake
worker/canvas/model (transfer, depth cache, fallback on every failure, disposal of 100 % of canvases, supersede), CSP/i18n/config/stamping.

**Not verified (no network and no device in the build environment):** the vendored `onnxruntime-web` file names for the pinned version
(`fetch_ort.py` stops with a clear message if they differ), the real model running in a WebView, its speed and peak memory on low/mid-range
phones (expect several seconds per photo on WASM single-thread), and visual parity with the server on real portraits. Test these on
a mid-range Android device before shipping, and tune `minDeviceMemoryGB` / `MAX_PIXELS` from the measurements.
