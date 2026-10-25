# YoFilter V19 - remediation of audit tasks R1-R16

New file: `js/core/render-pipeline.js` (loaded before `webgl-renderer.js`).
New tests: `tests/ui/render_pipeline_test.js`, `tests/ui/history_frame_test.js` (all 8 UI suites pass).

| Task | Fix | Where |
|---|---|---|
| R1 | One predicate `YoPipeline.needsPixelPass()` (sliders + all curve channels + Color Mix) used by preview AND export | render-pipeline.js, sliders.js, modals-export.js |
| R2 | Curves are "active" when ANY of the 4 LUTs differs from the default curve at ANY of the 256 entries (the old 4-point rgb-only sample is gone) | render-pipeline.js (`curvesActive`) |
| R3 | Removed the averaged global hue-rotate/saturate Color Mix approximation from `buildCSSFilter`; Color Mix runs only per band in shader/CPU | sliders.js |
| R4 | Export renders through the same WebGL shader as the preview (CPU fallback has identical order and maths: filters -> sharpen -> exposure -> shadows/whites/blacks -> vibrance -> warmth -> tint -> colour mix -> clarity -> vignette -> grain -> curves). CPU vignette is now UV-based and grain is a deterministic hash (same as shader, fixed seed - no flicker) | webgl-renderer.js, effects.js, render-pipeline.js |
| R5 | brightness/contrast/saturate + every preset (sepia, grayscale, hue-rotate...) now run as colour-matrix steps inside the shader / CPU pass - no `ctx.filter` needed. `YoCompat` detects `ctx.filter` and supplies fallbacks (blur by down/up-scale, colour matrices) for the AI mask and background-removal passes | render-pipeline.js, ai-mask.js, bg-removal.js |
| R6 | Frame id + all controls are in every history snapshot; undo restores them (and the UI); `resetAllValues` resets frame state; frame slider/colour changes are undoable; export reads the same state | fit-frame.js, history.js, reset.js |
| R7 | Export frame: scale = exportWidth / displayedImageWidth; rounded clip, outer drop shadow / neon glow, inset shadow, border outside padding, explicit backdrop for JPEG | modals-export.js |
| R8 | `resetHistory()` on every new upload (releases/revokes old URLs, index -1) | history.js, file-handler.js |
| R9 | `undoEdit()` first flushes the pending 650 ms debounced save | history.js |
| R10 | Preset "Original" = `resetColorEdits()` (preset, sliders, Color Mix, curves; crop/frame/overlays kept), saves history, truthful toast | presets.js, reset.js |
| R11 | AI Mask results are committed through `YoPipeline.commitCanvasAsOriginal()` (registered blob, `originalImage` replaced, preview refreshed, history saved) | ai-mask.js, render-pipeline.js |
| R12 | `getCurrentEditedImageSrc()` and the Magic Eraser source now bake the colour edits at FULL working resolution from `originalImage` (never the <=1200 px preview) | portrait-mode.js, magic-eraser.js, render-pipeline.js |
| R13 | Alpha preserved: upload and crop use PNG when the image has transparency, shader keeps alpha, preview canvas is cleared and encoded as WebP/PNG when alpha, JPEG export flattens onto white | file-handler.js, crop.js, webgl-renderer.js, render-pipeline.js, sliders.js, portrait-enhance.js |
| R14 | `cancelCrop()` whenever the user leaves the Crop tab (main tab or sub-tab) | navigation.js |
| R15 | Swipe-to-undo ignored while crop/eraser/overlay/compare is engaged, when the touch starts on a tool surface or control, on multi-touch and on touchcancel | gestures.js |
| R16 | `doExport` wrapped in try/catch/finally (overlay always hidden), canvases shrunk to 1x1 after export, double-export guard | modals-export.js |

## Notes / limits
* Exported frames wrap the picture tightly (padding scaled from the on-screen proportions). On screen the
  frame container fills the whole workspace; the export deliberately does not reproduce that letterbox.
* Frost frames: CSS `backdrop-filter` cannot be reproduced on a canvas; only the tint is exported.
* The default curve (Catmull-Rom through 5 collinear points) is not exactly the identity; "untouched" is
  therefore compared with the default LUT. Once a curve is edited the whole LUT is applied, as before.
* Not run here: a real browser / GPU (shader compiled by reading, not executed) and iOS/WKWebView.
  Please smoke-test: slider drag with a preset on iOS, export parity (preview vs file) with grain and
  vignette on a non-square photo, background removal then Exposure, Crop on a transparent PNG.
