# Local MediaPipe segmenter assets (R18)

`js/core/segmenter-service.js` loads the segmenter ONLY from here - there is no CDN fallback:

```
vendor/mediapipe/vision_bundle.mjs
vendor/mediapipe/wasm/            (vision_wasm_*.js / .wasm)
vendor/mediapipe/selfie_multiclass_256x256.tflite
```

The binaries are not committed (about 15 MB, see `.gitignore`); `scripts/MEDIAPIPE.sha256` (committed) pins every file by SHA-256.

```
python scripts/fetch_mediapipe_assets.py --pin   # first time / after a version bump: download, inspect, commit MEDIAPIPE.sha256
python scripts/fetch_mediapipe_assets.py         # afterwards (local dev, Cordova build): download + verify against the manifest
python scripts/fetch_mediapipe_assets.py --check # offline: verify what is on disk
```

The Docker build runs the verify mode in its own stage and fails if anything is missing or does not match. For a Cordova build run it
before `cordova build` so the files are inside `www/vendor/mediapipe`.
