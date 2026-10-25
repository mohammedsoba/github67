# YoFilter V24 - changes (G6 - G10)

Base: `YoFilter_FinalV23.zip`. No user-facing feature was removed. Intentional behaviour changes are listed explicitly
under "Behaviour changes" - everything else is internal.

## G6 - Curves drag optimisation (`js/editing/curves.js`)
* **Sorted control points are cached per channel** (`getSortedCurvePoints` / `invalidateCurveCache`). `cubicInterpolate`
  used to copy + sort the points on every call (256 x 4 per LUT rebuild + ~200 for the preview line, on *every pointer
  move*). The cache is keyed by the points array itself, so a reset / undo / new photo that replaces
  `curvesData[channel]` can never serve a stale copy; a re-ordering in-place edit is caught by a 5-element order check.
* **Only the active channel's LUT is rebuilt during a drag** (`buildCurveLUT(channel)`). `buildCurvesLUTs()` (all four) is
  still used by init / reset / history restore. The rebuilt channel gets a **fresh `Uint8Array`** - `webgl-renderer.js`
  decides whether to re-upload the LUT texture by comparing array references, so an in-place edit would never reach the GPU.
* **Nested `requestAnimationFrame` removed.** `applyAllEdits()` already coalesces into one rAF (and cancels a pending
  one); the extra wrapper only added a frame of latency and a redundant callback.
* **Curves drags now use the G1 live GPU path** (`applyAllEdits(true)`): no image encode per move, one settle encode
  ~140 ms after the last move / on release.

## G7 - Global coupling / monkey-patching
* `gestures.js` no longer reassigns `handleFileSelect` (the "INIT OVERRIDES" block is gone). Its only effect - revealing
  the Compare button - now lives in `file-handler.js` where the photo is loaded.
* `file-handler.js` no longer assigns `mainImg.onload`. A single `load` listener (`_bindMainImgLoadOnce`) is registered
  **once** (first upload, so it keeps its position among the other `load` listeners) and runs for every `#mainImg`
  source change exactly as the property handler did.
* Audit result: that was the only function reassignment. The `window.x = function` definitions in `portrait-mode.js` /
  `ai-mask.js` are first definitions, and there are no duplicate top-level function names across `js/` (now guarded by a test).

## G8 - One commit routine, shared helpers
* **`YoPipeline.commitImageUrl(url, opts)` / `commitCanvas(canvas, opts)`** are the single "make this the working image"
  implementation (alpha cache, colour-edit reset, `#mainImg`, preview canvas, fit, overlay geometry, history). Crop,
  background removal, portrait enhance, AI masks, Magic Eraser and Portrait mode all call it; `commitCanvasAsOriginal`
  stays as a thin wrapper. Options: `hasAlpha`, `keepColorEdits` (crop, portrait), `resetImageBox`, `beforeHistory`,
  `releaseCanvas`.
* `YoAiCommon.applyResultToEditor` is a wrapper that resolves `true/false` (failure toast, never rejects); bg-removal and
  enhance now show their success toast only after the commit really succeeded.
* **One `canvas.toBlob()` wrapper:** `canvasToBlob` in `save-image.js`. `history.js canvasToBlobUrl` is built on it; the
  Magic Eraser's private copy, the raw `toBlob` calls in `file-handler.js`, `portrait-mode.js` and `compare.js` are gone
  (only the Cordova storage path in `modals-export.js` keeps its own).
* Portrait mode reads backend error bodies with `YoApi.httpError` like the eraser does; the eraser's patch loader uses
  `YoAiCommon.loadImage`.

## G9 - Lossless pipeline (JPEG exactly once, at export)
* `YoPipeline.encodeSpec()` always returns **PNG** (arguments ignored, kept for compatibility). Every intermediate
  image - upload, crop, AI results, edit bakes sent to AI tools, portrait baseline - is lossless.
* **Upload** is re-encoded as PNG instead of JPEG 0.92 (original bytes are deliberately not passed through: the decode +
  orientation + downscale path behaves identically in every WebView). A failing encoder falls back to `FileReader` once
  and then reports an error (the old code could loop).
* **Backend:** `/api/portrait` always returns PNG (`compress_level=1`); the portrait baseline is uploaded as PNG.
  `tests/backend` updated: level-1 output is now asserted **bit-identical** to the decoded input; new test for a PNG
  baseline; the five portrait golden hashes were regenerated (the decoded output is now exact).
* **History budget** raised to **150 MB** (low-end / unknown) and **200 MB** (> 4 GB devices) because PNG states are
  ~8-12 MB for a 2560 px photo. `maxHistory = 20` and "always keep the 2 newest" are unchanged.
* Deliberately still lossy: the **export** (`modals-export.js`), the **display-only preview** image and filter-preset
  thumbnails. The preview is never read back as pixels, so it adds no generation loss.

## G10 - HTML sinks
* `ai-mask.js setStatus()` (the one real sink: it concatenated a message into `innerHTML`) now uses
  `createElement` + `textContent`.
* `overlay-manager.js` already had no HTML sink (V23 G3 removed the panel code); a test now pins that.
* Remaining `innerHTML` uses: `= ''` clears and one constant SVG (`RING_SVG`) in `portrait-mode.js`; the test fails on
  any new non-empty assignment.

## Behaviour changes to be aware of
1. **Frame, overlays and crop ratio are kept** after background removal, portrait enhance and Magic Eraser (they used
   `resetAllValues()`, which cleared them). Colour edits are still cleared when they were baked into the result.
2. The Magic Eraser's working-image bake no longer includes overlays (they stay live above the photo and survive the
   commit - baking them too would draw them twice). Its Download still composites them.
3. Undo depth with large photos is shorter in terms of *count* than V23 only if the 150/200 MB budget is reached;
   commits and the first upload encode PNG, which is slower than JPEG on low-end phones.
4. The Compare button appears when a photo is actually loaded (the removed override showed it on file pick).
5. `tests/backend/test_hardening.py`: CORS fixture resets `middleware_stack` before `add_middleware` (newer Starlette
   refuses it otherwise; older versions are unaffected).

## Tests
`node tests/ui/run_all.js` - 14 suites incl. the new `tests/ui/v24_test.js`; `pytest tests/backend` - 57 tests.
Adapted V23 expectations: history budget numbers, `YoPipeline` stubs gained `commitImageUrl`, two sandboxes gained the
shared `canvasToBlob`.
**Not measured here (no browser / GPU):** real drag frame rate, PNG encode time and memory on phones. Please check on a
device: curve drag smoothness, a crop + enhance + eraser chain, and undo depth on a 12 MP photo.
