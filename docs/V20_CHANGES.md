# YoFilter V20 - Part 2, Task 1 (R17-R21, Y1-Y9)

New files: `js/core/segmenter-service.js`, `backend/app/slots.py`, `css/settings.css`, `css/touch-layout.css`,
`scripts/fetch_mediapipe_assets.py`, `vendor/mediapipe/README.md`.
New tests: `segmenter_service_test.js`, `v20_static_test.js`, `presets_test.js` (UI, 11 suites pass),
`tests/backend/test_slots.py` (4 tests pass).

| Task | What changed | Files |
|---|---|---|
| R17 | One queued `YoSegmenter` service; every caller gets its own result via a Promise. The global `onPortraitSegmentationResults` hijack is gone. | segmenter-service.js, ai-mask.js, bg-removal.js, portrait-mode.js |
| R18 | Local assets first (`./vendor/mediapipe/`), CDN second, skipped when offline; load/segment timeouts; localized (EN/AR) plain-language errors (offline / timeout / failed). Fetch script fills the vendor folder. | segmenter-service.js, scripts/fetch_mediapipe_assets.py, vendor/mediapipe, i18n.js |
| R19 | Privacy policy + About feature text now state exactly what leaves the device (Magic Eraser, Portrait) and the first-time model download; false "fully offline" claims removed (EN/AR, HTML defaults, toast). | i18n.js, i18n-patch.js, index.html |
| R20 | HTTPS native API base (`NATIVE_API_BASE`), placeholder is refused with a clear message; CSP meta; config.xml: real e-mail, no wildcard access/navigation, cleartext off, legacy storage permission limited to API 28, `cordova-plugin-photo-library` (MediaStore); gallery save writes a Blob (no base64). | app-config.js, api-client.js, index.html, config.xml, modals-export.js |
| R21 | `run_in_owned_slot`: a slot is released only when the worker thread really finishes (timeout / disconnect no longer leak slots). Used by /api/portrait and /api/erase. | backend/app/slots.py, main.py |
| Y1 | Thumbnails use the filter at its real strength and a tiny cached UNEDITED copy of the photo. | presets.js |
| Y2 | Applying a preset first removes the previous preset's slider values (stateless, derived from `chosenPreset`). | presets.js |
| Y3 | Toast wraps to max 3 lines, sits below the safe-area/notch, above Settings/About, `role="status"`. | components.css, index.html |
| Y4 | Settings/About: no inline styles, safe-area insets, dialog ARIA, focus in/out, Escape and Android Back close the top layer. | settings.css, index.html, navigation.js, init.js |
| Y5 | Zoom no longer blocked; `touch-action` on every drag surface. | index.html, touch-layout.css |
| Y6 | 44px hit areas (invisible pseudo-elements on dense controls, min-height on coarse pointers). | touch-layout.css |
| Y7 | Compact phones (<=720px tall): nav pill in the flow, taller panel, scrollable content. | touch-layout.css |
| Y8 | Curves canvas scales; pointer coordinates converted; touchcancel; Reset curve; translated R/G/B. | curves.js, index.html, touch-layout.css, i18n.js, startup-lang.js |
| Y9 | Slider labels wrap (2 lines) and the value keeps its own room; works in RTL. | touch-layout.css |

## You still have to do (cannot be done from here)
1. Replace `https://api.yofilter.example` with your real HTTPS server in THREE places: `js/config/app-config.js`
   (NATIVE_API_BASE), `index.html` CSP `connect-src`, and `config.xml` `<access>`.
2. Run `python scripts/fetch_mediapipe_assets.py` once (needs internet) to bundle the segmenter model; then the two
   CDN `<access>` lines and the CDN entries in the CSP can be removed.
3. Rebuild the Cordova app (`cordova plugin add` runs from config.xml) and test saving to the gallery on Android 10+/iOS.
4. Visual check at 360x640 (Edit / Curves / Frame tabs, English and Arabic) - layout was reasoned from the CSS, not rendered.
