# YoFilter regression safety net

| Layer | Where | Run | Needs |
|---|---|---|---|
| UI logic (pure Node, no JSDOM) | `tests/ui/*_test.js` | `node tests/ui/run_all.js` | Node >= 20 |
| Golden pipeline (LaMa + DepthPortrait) | `tests/backend/test_pipeline_golden.py` | `pytest tests/backend` | models + `requirements-dev.txt` |
| FastAPI contract | `tests/backend/test_api_contract.py` | `pytest tests/backend` | same |
| V25 hardening (production profile, CORS, headers, version source) | `tests/backend/test_v25_pure.py` (no FastAPI / models), `tests/backend/test_v25_hardening.py` (needs both) | `pytest tests/backend` | see above |
| V26 remediation (portrait 503 leak-proof in production; one stamped source for the packaged-app API host) | `tests/backend/test_v26_pure.py` (no FastAPI / models), `tests/backend/test_v26_hardening.py` (needs both), `tests/ui/v26_test.js` | `pytest tests/backend` / `node tests/ui/run_all.js` | see above |
| Eraser selection-size guard (1024 px, EN + AR, HTTP 400) | `tests/backend/test_erase_selection_guard.py` (pipeline tests need no models; route tests need the `client` fixture), `tests/ui/erase_selection_guard_test.js` | `pytest tests/backend` / `node tests/ui/run_all.js` | see above |
| V25 UI regressions (Back stack, CSS cascade, preview == export, curves, Color Mix, frame state, swipes) | `tests/ui/v25_test.js` | `node tests/ui/run_all.js` | Node >= 20 |
| V27 module structure (registry first, manifests accurate, private stays private, live-binding semantics) | `tests/ui/v27_modules_test.js` | `node tests/ui/run_all.js` | Node >= 20 |
| V28 launch splash (inline critical CSS, SVG monogram, EN/AR tagline, reduced motion, compositor-only keyframes, ready-aware lifecycle on a virtual clock) | `tests/ui/v28_test.js` | `node tests/ui/run_all.js` | Node >= 20 |
| Portrait load protection (downscale at decode, bounded queue, queue wait vs compute timeout, no slot leaks; busy-503 message in the UI) | `tests/backend/test_portrait_queue.py` (no models needed), `tests/ui/portrait_busy_test.js` | `pytest tests/backend` / `node tests/ui/run_all.js` | see above |
| Portrait panel flow in a DOM (no Apply step, busy 503 -> retry -> result, error -> "Try again", cancel while waiting, no unhandled rejection); toolbar order, header style, EN/AR key parity | `tests/dom/portrait_flow_check.js` (needs `npm i -D jsdom`, skipped otherwise), `tests/ui/portrait_panel_test.js`, `tests/ui/portrait_busy_retry_test.js` | `node tests/dom/portrait_flow_check.js` / `node tests/ui/run_all.js` | see above |
| Shared erase+portrait slot pool, erase queue wait, slot-leak on cancel, portrait threads vs CPU quota; browser-side upload downscale | `tests/backend/test_shared_slots.py` (no models needed), `tests/ui/portrait_upload_test.js` | `pytest tests/backend` / `node tests/ui/run_all.js` | see above |
| Request-body guard (Content-Length gate, streaming 25 MB counter, in-flight upload cap) | `tests/backend/test_body_guard.py` (pure ASGI, no FastAPI/models), `tests/backend/test_body_guard_api.py` (needs fastapi + httpx, no models) | `pytest tests/backend` | see above |
| Browser smoke | `tests/e2e/smoke.spec.js` | `npm install && npx playwright install chromium && npx playwright test` | live uvicorn is started for you |
| Mobile viewport suite | `tests/responsive/viewport_suite.js` | `npm run test:responsive` | Node >= 20 + `npx playwright install chromium` (no backend) |
| Geometry suite (loader, orb, dialogs, 44 px hit areas; 7 viewports x EN/AR) | `tests/responsive/geometry_suite.js` | `npm run test:geometry` | same as above |
| Mutation check | `scripts/mutation_check.py` | `python scripts/mutation_check.py` | same as backend |

## Golden hashes
* Compare: `pytest tests/backend`. Strict (CI): `REQUIRE_GOLDEN=1 pytest tests/backend` - missing/stale entries FAIL.
* Intentional pipeline change: `UPDATE_GOLDEN=1 pytest tests/backend/test_pipeline_golden.py`, review the `golden.json` diff, commit.
* Hashes are tied to the pins in `requirements-dev.txt` and the model files (fingerprints are stored under `_meta`).
  If CI reports a mismatch with "environment differs", run the **CI workflow manually with `update_golden`** and commit the
  uploaded `golden.json` (ONNX Runtime CPU kernels can differ slightly between CPU generations).

## Models in CI
`scripts/fetch_models.py` verifies `backend/models/MODELS.sha256`. Order: cache -> Hugging Face (default in the script; override with the `MODEL_BASE_URL` repo
variable). Pointer files / truncated downloads fail loudly. The same download logic runs in the app at start-up
(`backend/app/models_bootstrap.py`, covered by `tests/backend/test_models_bootstrap.py`).

## Mobile viewport suite
Headless Chromium at 360x640, 390x844 and 428x926, in English (LTR) and Arabic (RTL). It checks page/nav overflow, silent
clipping, bottom-nav label readability, the floating Undo/Original pill clearance, and the Frame tab design contract.
Screenshots go to `test-results/responsive/`.

**Negative controls** - prove the checks can fail by injecting broken CSS (each must exit non-zero):
```
RESP_INJECT_CSS=".main-nav .nav-tab span{font-size:22px!important}"      node tests/responsive/viewport_suite.js   # labels/bars
RESP_INJECT_CSS=".canvas-float{bottom:-70px!important}"                  node tests/responsive/viewport_suite.js   # float
RESP_INJECT_CSS=".top-bar{width:520px!important;min-width:520px!important}" node tests/responsive/viewport_suite.js # bars/page
RESP_INJECT_CSS=".frame-ctrl-row{min-width:520px!important}"             node tests/responsive/viewport_suite.js   # clipping
```

### Geometry suite negative controls (V68)

`GEO_INJECT_CSS` proves the suite can go red:

```
GEO_INJECT_CSS=".island-cancel{min-height:30px!important}"   node tests/responsive/geometry_suite.js   # modal: Cancel < 44 px
GEO_INJECT_CSS=".yo-orb--sm{--orb-size:40px!important}"       node tests/responsive/geometry_suite.js   # orb: too small
GEO_INJECT_CSS=".sub-btn{height:30px!important}"              node tests/responsive/geometry_suite.js   # touch targets
```

The touch check measures the *effective* hit area with `elementFromPoint` and fails if fewer than 6 controls are reachable
(a covered page would otherwise pass vacuously). Screenshots: `test-results/geometry/`.
