# YoFilter V26 - changes (audit remediation S1 + S3)

Base: `YoFilter_FinalV25.zip`. Release version stays **1.0.0**. Nothing else in V25 behaviour changes.

## S1 - portrait 503 no longer leaks paths or exception text (`backend/app/security.py`, `backend/app/main.py`)
* **Problem (found in the V25 audit):** `ort_utils.py` builds messages such as `Portrait model not found: /abs/path/...onnx`.
  `load_portrait` stored them in `app.state.portrait_error`, and `/api/portrait` returned them in the 503 body, so in
  production any visitor could read the server's filesystem layout whenever the model failed to load.
* **Fix:** the 503 body is now built by the new pure helper `public_model_error(IS_PRODUCTION, PORTRAIT_UNAVAILABLE_MESSAGE, reason)`.
  * Production: always exactly **"Portrait background model failed to load"**. No path, no exception class, no text from the exception.
  * Development: `"Portrait background model failed to load (<reason>)"`, so a developer still sees the cause at once.
  * The full reason is still written to the server log (`[portrait] 503 model not loaded (...)` and the load-time traceback); `ort_utils.py` itself is unchanged.
* Unchanged and already safe: `/health` in production (3 fields), the 500 answers (reference id only), `/api/erase` 503 ("LaMa model is not loaded").
  `str(exc)` reaches a client only in 400 input-validation answers (image empty / not valid / too large), which contain no paths.
* The frontend maps any 503 to its own translated message, so the user-facing text is unchanged.

## S3 - no placeholder API host; one stamped source (`version.json`, `scripts/sync_version.py`, `js/config/app-config.js`, `index.html`, `config.xml`, `js/config/api-client.js`)
* **Problem:** `https://api.yofilter.example` was hand-copied into `app-config.js`, the CSP `connect-src`, `config.xml` and
  `api-client.js`, and had to be replaced in all of them before a release.
* **Web build (unchanged):** served by the backend, same origin, relative URLs (`/api/...`). It needs no host and was never affected.
* **Packaged Android build:** the HTTPS origin of the deployed backend now lives in ONE place, **`native_api_base` in `version.json`**
  (empty by default). `scripts/sync_version.py` stamps it into:
  * `js/config/app-config.js` (`NATIVE_API_BASE`),
  * the `connect-src` of the CSP in `index.html`,
  * the `<access origin>` in `config.xml` (between `yofilter:native-api:begin/end` markers).
* **Commands**
  * `python scripts/sync_version.py --native-api-base https://api.yourdomain.com` - validate, write `version.json`, stamp all copies.
  * `python scripts/sync_version.py --check` - change nothing, exit 1 on drift (already enforced by the UI suite and pytest).
  * `python scripts/sync_version.py --release` (`npm run check:release`) - `--check` plus exit 1 while `native_api_base` is empty. Run it before building the app.
* **Validation:** HTTPS origin only (scheme + host [+ port]). Rejected: `http://`, a path or query, wildcards, bare hostnames,
  `localhost`, and reserved names (`.example`, `.invalid`, `.test`, `.localhost`). A rejected value never reaches `version.json`.
* **Unconfigured default (what ships in V26):** no host is listed in the CSP or `config.xml` (which says `NOT CONFIGURED`),
  `NATIVE_API_BASE = ""`, and `YoApi.resolveBase()` returns `null` for a packaged shell. `request()` then refuses before any network
  call with the existing "AI server address is not set in this app build" message (EN + AR, now pointing at `native_api_base`).
  `api-client.js` no longer contains a default placeholder host; the `.example` guard stays as defence in depth.
* The CSP `connect-src` is what stops a `?api=` override from sending photos to a host that is not listed.

## Tests
* `tests/ui/v26_test.js` (7 tests): S1 static and helper checks, placeholder sweep over every shipped file, single-source consistency,
  unconfigured-default behaviour, and the real `sync_version.py` CLI in a scratch copy (stamp, reject unsafe values, drift, `--release`, clear).
* `tests/backend/test_v26_pure.py` (no FastAPI / models) and `tests/backend/test_v26_hardening.py` (app-level: production 503 is generic and
  leak-free, development keeps the reason, production `/health` stays clean after a failed load).
* Updated for the new contract: `api_client_test.js`, `v20_static_test.js`, `v25_test.js` (config.xml), `test_api_contract.py` (503 wording, development),
  `test_v25_pure.py` (scratch copy now includes `app-config.js`).
* Mutation check: putting the old `f"... ({reason})"` back into `main.py` makes `v26_test.js` fail.

## Behaviour changes (intentional)
1. Production `/api/portrait` 503 body is the generic message above (development keeps the reason).
2. Packaged builds have no default API host: until `native_api_base` is set they refuse API calls with a clear message instead of targeting a placeholder.

## Verification status (be explicit)
| Suite | Result | Where |
|---|---|---|
| UI, all `tests/ui/*_test.js` (16 suites incl. v26) | **all pass** | run in the build sandbox (`node tests/ui/run_all.js`) |
| Backend `test_v26_pure.py` + `test_v25_pure.py` | **all pass** (29 checks) | sandbox, plain-Python runner (pytest is not installed there) |
| `sync_version.py --check` | in sync | sandbox |
| `sync_version.py --release` | **fails by design** until `native_api_base` is set | sandbox |
| Backend app-level: `test_v26_hardening.py`, `test_v25_hardening.py`, `test_api_contract.py`, `test_hardening.py`, `test_limits.py`, `test_slots.py`, `test_pipeline_golden.py` | **NOT RUN here** (no FastAPI / pytest, no network) | `REQUIRE_GOLDEN=1 pytest tests/backend` locally / in CI |
| Playwright e2e and viewport suite | **NOT RUN here** (no browser) | `npx playwright test`, `npm run test:responsive` |

## Before you release the Android app
1. `python scripts/sync_version.py --native-api-base https://<your real backend host>` then `python scripts/sync_version.py --release`.
2. Deploy the backend with `YOFILTER_ENV=production`; if you set `ALLOWED_ORIGINS`, include `https://localhost`.

## Still open from the V25 audit (not part of V26)
Proxy-level upload size limit and HSTS/`TRUST_PROXY` deployment notes (S4); `script-src-attr 'unsafe-inline'` and the jsDelivr script source (S2);
global-scope cleanup and the few canvas releases that are not in `finally`; targetSdk 34 vs Google Play's current requirement.
