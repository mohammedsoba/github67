
// API address of the bundled FastAPI backend.
// Leave it EMPTY: the frontend then calls relative paths ("/api/erase", "/api/portrait") on the origin
// that served the page, so any port works (uvicorn ... --port 8085). Only set a full URL such as
// "http://192.168.1.20:8085" if the page is hosted somewhere other than the backend. You can also
// override it per visit with  ?api=http://host:port  (see js/config/api-client.js).
const PRODUCTION_API_BASE = "";
window.PRODUCTION_API_BASE = PRODUCTION_API_BASE;

// HTTPS origin of the DEPLOYED YoFilter backend, used ONLY by packaged builds (Cordova / Capacitor / file://).
// Browser builds served by the backend ignore it (same origin, relative URLs).
// STAMPED - do not edit by hand. The single source is "native_api_base" in version.json; scripts/sync_version.py
// copies it here, into the index.html CSP connect-src and into config.xml (<access>), and a test fails on any drift:
//     python scripts/sync_version.py --native-api-base https://api.yourdomain.com
// "" = not configured: a packaged build then refuses to call the API and says so (no placeholder host is shipped).
const NATIVE_API_BASE = "https://web-production-7211e.up.railway.app";
window.NATIVE_API_BASE = NATIVE_API_BASE;

// ---- On-device portrait AI (V27 Edge AI) --------------------------------------------------------------------------
// The ~99 MB Depth-Anything-V2-Small model is NOT bundled in the APK. On the first on-device portrait run it is
// downloaded once from EDGE_MODEL_URL, verified against EDGE_MODEL_SHA256 / EDGE_MODEL_BYTES (same values as
// backend/models/MODELS.sha256 - a test keeps them in sync) and kept in the Cache API (js/core/edge-model.js).
// EDGE_MODEL_URL is STAMPED from "edge_model_url" in version.json by scripts/sync_version.py (also into the CSP
// connect-src and config.xml <access>). "" = not configured: portrait then always uses the server, exactly as before.
const EDGE_MODEL_URL = "";
const EDGE_MODEL_CONFIG = {
    url: EDGE_MODEL_URL,
    sha256: "d2b11a11c1d4a12b47608fa65a17ee9a4c605b55ee1730c8e3b526304f2562be",
    bytes: 99373606,
    minDeviceMemoryGB: 3          // below this (navigator.deviceMemory) the server is used instead of the on-device run
};
window.EDGE_MODEL_CONFIG = EDGE_MODEL_CONFIG;
