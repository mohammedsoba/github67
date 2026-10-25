# Vendored onnxruntime-web (on-device portrait)

`js/workers/depth-worker.js` imports the runtime from THIS folder (never from a CDN):

```
vendor/ort/ort.wasm.min.mjs
vendor/ort/ort-wasm-simd-threaded.mjs
vendor/ort/ort-wasm-simd-threaded.wasm
vendor/ort/ORT.sha256              <- committed: the integrity pins
```

The binaries are not committed (about 10 MB, see `.gitignore`). Fill the folder once:

```
python scripts/fetch_ort.py --pin     # first time only: download, inspect, commit ORT.sha256
python scripts/fetch_ort.py           # afterwards / in CI: download + verify against ORT.sha256
```

Without these files the on-device path cannot start; the worker fails to load, the card says so (with Retry) and portrait
keeps working through the server. See `docs/EDGE_AI_PORTRAIT.md`.
