# YoFilter V25 - changes (G11 - G15) - FINAL SHIPPABLE RELEASE

Base: `YoFilter_FinalV24.zip`. V22, V23 and V24 behaviour is unchanged except where listed under "Behaviour changes".
Release version stays **1.0.0**.

## G11 - Backend and ops hardening (`backend/app/main.py`, `config.py`, new `security.py`)
* **`/health` per profile.** `YOFILTER_ENV=production` -> exactly `{status, model_loaded, portrait_model_loaded}`.
  Absolute model paths, `portrait_load_error` (raw exception text), ONNX providers and the dependency-version map are
  built only in `_health_details()`, which the production branch never calls. Development output is unchanged.
* **Security headers** (new outermost middleware, added after CORS so 2xx / 4xx / 429 / 503 / JSON-500 all carry them):
  `X-Content-Type-Options: nosniff` always; in production also `Content-Security-Policy`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, and `Strict-Transport-Security` on HTTPS requests (also when `TRUST_PROXY=1` and
  `X-Forwarded-Proto: https`).
  * API / health answers: `default-src 'none'; frame-ancestors 'none'`.
  * Page and static assets: `frame-ancestors 'none'; base-uri 'self'; object-src 'none'` only. The full page policy stays in
    the `<meta>` of `index.html` (one source, no drift); a meta CSP cannot express `frame-ancestors`, which is why the header
    exists. Both apply, so the header can only tighten.
* **`config.xml` is no longer served** (removed from the root-asset allow-list). `version.json` and everything else not on the list stays 404.
* **`/docs`, `/redoc`, `/openapi.json` are not mounted in production.**
* **CORS.** `allow_headers=["*"]` -> explicit `Accept, Accept-Language, Content-Type, X-Requested-With`. With
  `YOFILTER_ENV=production` and `ALLOWED_ORIGINS` unset the allow-list is `https://localhost` only (the packaged Android
  app); every web origin is denied. The browser build is same-origin and needs no CORS. Dev default is still `*`.
  An explicitly configured list is used exactly as written (**include `https://localhost` in it if you ship the Android app**);
  an explicit `*` is honoured and logs the existing production warning.

## G12 - Metadata (`version.json`, `scripts/sync_version.py`, `config.xml`)
* **`version.json` is the single source** (`version`, `api_title`, `name`). The backend reads it at start-up (FastAPI title
  **"YoFilter API"** - was "YoFilter LaMa Inpainting API" - and version); a missing file falls back to neutral values.
* **`python scripts/sync_version.py`** stamps `config.xml` (`<widget version>`), `index.html` (About fallback text) and
  `js/i18n/i18n.js` (EN and AR `appVersion`); `--check` changes nothing and exits 1 on drift. Tests enforce it
  (UI suite + pytest), so a hand-edit of one copy cannot ship.
* **`config.xml`:** author e-mail kept; the placeholder API host is now explicitly marked
  `PLACEHOLDER HOST - REPLACE BEFORE RELEASE` (same host as `NATIVE_API_BASE` and the CSP `connect-src`); Android-only with
  pinned targets: `android-minSdkVersion 24`, `android-targetSdkVersion 34`, `<engine name="android" spec="^13.0.0">`.

## G13 - Cordova Back button and blocking dialogs (`js/ui/navigation.js`, `js/core/init.js`, `js/ui/modals-export.js`)
* **One ordered layer list (`BACK_LAYERS`)**, top-most first: running operation with a Cancel button (Back == Cancel) ->
  About -> Settings -> Export -> Premium -> Crop -> Portrait "Set Focus" mode -> selected overlay (deselect).
  Back and Escape both use `closeTopmostLayer()`; each press closes exactly one layer. New read-only helpers:
  `topmostLayerName()`, `isBackBlockedByBusy()`; portrait-mode exposes `isPortraitFocusModeActive()` / `exitPortraitFocusMode()`.
* **Exit flow** only when nothing is open: first press -> toast, second within 2 s -> exit. During a **non-cancellable**
  save / export the toast says "Still working... press back again to exit anyway" (new key `toastBackBusy`, EN + AR) instead of
  silently arming the exit; the double press still exits, so a stuck overlay can never trap the user.
* **Both remaining `alert()` calls are gone** (Cordova save success / failure). Success -> existing `toastSavedName`
  (the alert duplicated it). Failure -> new `toastSaveFailedMsg` with the reason (EN + AR), falling back to `toastSaveFailed`.
  Removed orphaned keys `alertSavedDevice`, `alertSaveFailed`. There is no `alert/confirm/prompt` left in `js/` or `index.html` (tested).

## G14 - CSS cascade (`components.css`, `mobile.css`, `polish.css`, `touch-layout.css`, `responsive.css`)
* **`.top-bar` and `.control-panel` geometry now has one home (`components.css`)**, written from the values that actually won
  the old cascade (load order: components -> responsive -> mobile -> polish -> touch-layout), so rendering is unchanged:
  header `calc(56px + safe-area-top)` (48px landscape-short); panel `clamp(244px, 34vh, 360px)` from 521px height,
  `clamp(272px, 44vh, 340px)` for 521-720px, `44vh` landscape-short, `clamp(150px, 34vh, 360px)` below - each with its `dvh` variant. Removed
  from mobile / polish / touch-layout. `.control-panel` also absorbed `position: relative` (polish) and `padding-bottom: 0` (mobile).
* The header's responsive blocks used the `padding` shorthand, which would now reset the safe-area top padding folded into the
  base rule; they use `padding-inline` instead (same left/right values).
* **`.main-img`: `!important` removed** from `width/height/max-*`. Every inline write the app makes to those properties is
  `auto` / `100%` (verified in a test), so the layout is identical, but inline updates now take effect. Its duplicate GPU-layer
  declarations (also in the compositing block) and the duplicate `border-radius` (polish) were merged.
* **Font smoothing:** the `subpixel-antialiased` rule on `body` for >=2x screens is removed (it only affected `<body>` itself
  because `*` already sets every element). One definition remains: `antialiased` / `grayscale` (`base.css`).

## G15 - Tests
* `tests/ui/v25_test.js` (28 tests): G11-G14 guards plus behaviour regressions for **preview == export (identical pixels)**,
  **per-channel curves** (red / green / blue change only their channel), **Color Mix isolation**, **frame state across undo and new upload**,
  and **swipe thresholds / blocking** (two fingers, controls, crop, eraser paint, overlay selection, hold-to-compare, touchcancel).
* `tests/backend/test_v25_pure.py` (14 tests, no FastAPI / models) and `tests/backend/test_v25_hardening.py` (app-level).
* `conftest.py` pins `YOFILTER_ENV=development`; `test_hardening.py` follows the new explicit CORS header list.
* Against the untouched V24 sources the G11-G14 tests fail (12/28 pass); the G15 behaviour tests pass on both, i.e. **they found no latent bug** - they are regression guards.

## Behaviour changes (intentional)
1. Production `/health` has 3 fields; `/docs`, `/redoc`, `/openapi.json` 404 in production; `/config.xml` 404 everywhere.
2. Production CORS default is `https://localhost` only (was `*`); request headers are an explicit list.
3. Back button: also cancels a running operation, leaves Portrait focus mode, deselects an overlay; busy save/export gets its own warning.
4. Cordova save: toast only, no native dialog.

## Verification status (be explicit)
| Suite | Result | Where |
|---|---|---|
| UI, all `tests/ui/*_test.js` (15 suites incl. v25) | **all pass** | run in the build sandbox (`node tests/ui/run_all.js`) |
| Backend `test_v25_pure.py` (14) | **all pass** | run in the sandbox with a plain-Python runner (pytest itself is not installed there) |
| Backend **needs local `pytest`**: `test_v25_hardening.py`, plus `test_api_contract.py`, `test_hardening.py`, `test_limits.py`, `test_slots.py`, `test_pipeline_golden.py` | **NOT RUN here** (no network -> no FastAPI / pytest; models are present) | run `REQUIRE_GOLDEN=1 pytest tests/backend` locally / in CI. The changed backend files were syntax-checked (`py_compile`) and the pure logic was executed. |
| Playwright e2e (`tests/e2e`) and viewport suite (`tests/responsive`) | **skipped due to missing browser environment** | run `npm run test:responsive` and `npx playwright test` locally - recommended after G14 |

## Known limits / notes
* G14 was done by cascade analysis, not by rendering. The viewport suite is the right confirmation (`.top-bar` / `.control-panel` clearances are what it measures).
* Preview/export parity is tested on the CPU engine (the shared `cpuApply`); GPU-shader vs CPU parity needs a browser.
* Back does not clear eraser strokes or switch tabs (both would lose work or change navigation semantics).
* `targetSdk 34` is kept as instructed; Google Play's required target level for new uploads may be higher - check before publishing.
* `<engine ... ^13.0.0>`: if your local Cordova Android platform is a different major version, adjust or remove that line.
