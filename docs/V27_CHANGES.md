# V27 - Modules refactor

Behavior-neutral restructuring of the front-end JavaScript. **No feature, UI, API, CSS, backend or version change**
(`version.json` stays 1.0.0). Built on `YoFilter_FinalV26_EdgeAI`.

## What changed

The app has no build step and loads 44 classic `<script defer>` files that used to share one global scope: every top-level
helper in every file was a global, so any file could (and some tests did) depend on any other file's internals.

V27 gives the code explicit module boundaries **without** changing how it loads (no bundler, no ES-module conversion):

1. **`js/core/namespace.js`** (new, first script) - the `YF` registry. `YF.expose(name, {...})` publishes a module's API.
2. **23 files are now IIFE modules.** Each starts with a manifest listing exactly what it shares; every other top-level
   helper is private to the closure (86 names left the global scope).
3. **Live bindings.** Each export is a getter (+ setter for `function`/`let`/`var`) onto the module's own variable, published as
   a global property *and* as `YF.<module>.<name>` (e.g. `YF.presets.applyPreset`). Consequences, all intentional:
   - inline HTML handlers, bare-identifier calls from other scripts and `window.x` reads work exactly as before;
   - a module that reassigns its own `let`/`var` is seen live by every reader (no stale copies);
   - reassigning an exported function from outside (`updateLoadingSub = stub`) reaches the module's own internal calls, so
     patching/stubbing behaves exactly like a global function did;
   - `const` / `class` exports have no setter (same as before - assignment was never legal).
4. Module bodies are **not re-indented** (one-line header + one-line footer), so `git blame`/diffs stay meaningful and the
   source-anchored tests keep matching.
5. `index.html`: `namespace.js` added as the first app script; a stale comment claiming i18n "overrides showToast/showLoading"
   removed (it never did - `i18n.js` only defines `window.t`).

### Module map (generated from the manifests)

| File | Exported (manifest) | Now private |
|---|---:|---:|
| `core/file-handler.js` | 3 | 2 |
| `core/history.js` | 21 | 7 |
| `core/init.js` | 1 | 1 |
| `editing/ai-auto.js` | 1 | 0 |
| `editing/color-mix-apply.js` | 1 | 0 |
| `editing/color-mix.js` | 3 | 1 |
| `editing/crop.js` | 13 | 10 |
| `editing/curves.js` | 8 | 3 |
| `editing/effects.js` | 13 | 0 |
| `editing/fit-frame.js` | 20 | 5 |
| `editing/presets.js` | 4 | 2 |
| `editing/sliders.js` | 6 | 11 |
| `editing/watermark.js` | 4 | 3 |
| `overlays/overlay-manager.js` | 2 | 0 |
| `portrait/portrait-mode.js` | 3 | 0 |
| `ui/compare.js` | 9 | 13 |
| `ui/gestures.js` | 2 | 6 |
| `ui/loading-toast.js` | 5 | 1 |
| `ui/modals-export.js` | 5 | 10 |
| `ui/navigation.js` | 10 | 5 |
| `ui/reset.js` | 2 | 1 |
| `ui/save-image.js` | 3 | 3 |
| `ui/splash.js` | 1 | 2 |
| **23 modules** | **140** | **86** |

## Deliberately NOT wrapped (and why)

| File(s) | Reason |
|---|---|
| `js/core/state.js` | 30 bindings are written from many files (`isProcessing`, `originalImage`, `historyStack`, `portraitBusy`, ...). Wrapping would need every write site rewritten - a behavior-risking change. **V28 candidate** (`YF.state` accessors). |
| Edge AI: `edge-model.js`, `segmenter-service.js`, `edge-portrait.js`, `portrait-math.js`, `edge-model-ui.js`, `workers/depth-worker.js` | Already single namespaced objects (`YoEdgeModel`, `YoSegmenter`, `YoEdgePortrait`, `YoPortraitMath`, `YoEdgeModelUI`). **Byte-identical to V26** - worker pipeline, `onnxruntime-web`, Cache API, memory zeroing and the server fallback were not touched. |
| `js/config/app-config.js` | Rewritten by regex in `scripts/sync_version.py` (single-source version/API host). Byte-identical. |
| `render-pipeline.js`, `webgl-renderer.js`, `api-client.js`, `presets-data.js` | Already namespaced objects / self-contained / pure data. Byte-identical. |
| `i18n.js`, `a11y.js`, `ai-common.js`, `ai-mask.js`, `bg-removal.js`, `erase-window.js`, `magic-eraser.js`, `portrait-enhance.js`, `perf-utils.js`, `startup-lang.js` | No top-level declarations - already scoped. Byte-identical. |

`v27_modules_test.js` holds this list (`NOT_WRAPPED`): a new file must register via `YF.expose` **or** be added there on purpose.

## Tests

22 UI suites pass (21 existing + 1 new). Changes to existing tests - complete list:

| File | Change |
|---|---|
| `tests/ui/_harness.js` | Added `createContext(sandbox)`: `vm.createContext` + loads `namespace.js` (modules call `YF.expose`, so a vm sandbox needs the registry first). Added `fs`/`path`/`vm` imports. |
| `cancel_progress`, `history_frame`, `history_memory`, `presets`, `render_pipeline`, `save_image`, `skin_slider` (1 site each), `upload_hotfix` (2), `v22` (5), `v23` (6), `v24` (6), `v25` (4) | `vm.createContext(` -> `createContext(` (30 call sites) and the matching destructured import. **No assertion was changed, removed or loosened.** |
| `tests/ui/v27_modules_test.js` (new, 11 tests) | Registry loads first, every script exists once, every app file is a registered module or consciously listed; manifests are closed, sorted, honest (every export is a real top-level binding; const/class read-only); no cross-module global clash; **private stays private** (no other file or `index.html` uses a non-exported helper); Edge AI files + `state.js` unwrapped; live-binding semantics (live reads, reassignment reaches the module, const read-only, `YF.modules()`, loud failure on a clashing global). |

The guard was mutation-tested: removing a needed export, exporting a non-existent name, giving a `const` a setter, loading
`namespace.js` late, and adding an unregistered file each fail it.

## Verification performed

* `node tests/ui/run_all.js` - **22/22 suites pass.**
* Differential boot: V26 tree and V27 tree loaded in `index.html` order into the same stubbed environment - 0 load errors in
  either; all 140 exports resolve; of 277 V26 top-level names, 191 have identical type in both and the 86 that are no longer
  global are exactly the private ones; **no name changed type**.
* Byte-identity vs V26 confirmed for every file in the "not wrapped" table, plus `backend/`, `css/`, `fonts/`, `scripts/`,
  `config.xml`, `version.json`.
* AST scan: no unreferenced top-level functions (nothing to prune), no implicit globals, no top-level `this`, no duplicate
  top-level names across files, no file overriding another file's function via `window.x =`.

## Not run in this environment (flag for CI / your machine)

* **Playwright suites** (`tests/e2e/smoke.spec.js`, `tests/responsive/viewport_suite.js`) - no browser available. They exercise
  the real DOM boot; please run them once before release.
* **Backend pytest** (`tests/backend/*`) - `pytest` is not installed here. The backend is byte-identical to V26, so no result
  can change, but it was not executed.
* No on-device (Cordova/Android WebView) check. The change only affects script-scope, but a manual launch + one upload + one
  Portrait run is a sensible final gate.

## Rollback

V26 behavior is recoverable by reverting this commit; there is no data, storage or API change.

## Candidates for V28 (not done - your call)

* Move `state.js` behind `YF.state` accessors and migrate write sites, then wrap it.
* Convert call sites from bare globals to `YF.<module>.fn()` incrementally; once none remain, drop the global publication.
* Re-indent module bodies in a dedicated whitespace-only commit (kept out of V27 to keep the diff reviewable).
