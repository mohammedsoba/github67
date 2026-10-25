#!/usr/bin/env python3
"""Stamp the single-source release settings (version.json) into every file that carries a copy of them.

    python scripts/sync_version.py                         # rewrite every stamped copy
    python scripts/sync_version.py --check                 # change nothing; exit 1 (and list the drift) if any copy differs
    python scripts/sync_version.py --native-api-base https://api.yourdomain.com
                                                           # write native_api_base into version.json, then stamp
    python scripts/sync_version.py --edge-model-url https://models.yourdomain.com/portrait_depth.onnx
                                                           # write edge_model_url into version.json, then stamp
    python scripts/sync_version.py --release               # --check, and ALSO exit 1 while native_api_base is empty
                                                           # (run before building the packaged Android app)

version.json holds three things this script distributes:

* ``version``         -> config.xml <widget version>, index.html About fallback text, js/i18n/i18n.js (EN + AR)
* ``native_api_base`` -> the ONE HTTPS origin of the deployed backend that a packaged (Cordova) build talks to:
                         js/config/app-config.js (NATIVE_API_BASE), the index.html CSP ``connect-src`` and the
                         config.xml ``<access origin>``. Empty (the default) means "not configured": none of the three
                         lists a host and the packaged app answers "AI server address is not set". The browser build
                         is served by the backend itself (same origin, relative URLs) and never needs this value.
* ``edge_model_url``  -> OPTIONAL HTTPS URL (no query/fragment) the on-device portrait model is downloaded from on first use
                         (js/core/edge-model.js): js/config/app-config.js (EDGE_MODEL_URL) plus ITS ORIGIN in the index.html
                         CSP ``connect-src`` and the config.xml ``<access origin>``. Empty = on-device AI off, server only.
                         The host must send CORS headers and Content-Length (see docs/EDGE_AI_PORTRAIT.md).
* ``name``/``api_title`` -> read by the backend at start-up (backend/app/config.py); no stamp needed.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$")
# Origin only (scheme + host [+ port]): it is pasted into a CSP source list and a Cordova <access origin>, where a
# path, query or wildcard would mean something different. HTTPS only - Android 9+ blocks cleartext traffic.
NATIVE_BASE_RE = re.compile(r"^https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$")
# Full file URL of the edge model: HTTPS, a path, and NO query / fragment (a signed URL would expire inside a shipped app).
EDGE_URL_RE = re.compile(r"^(https://[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?)(/[A-Za-z0-9._~%+/-]+)$")
RESERVED_TLDS = (".example", ".invalid", ".test", ".localhost")      # RFC 2606 / 6761 names: never a real deployment

CONFIG_XML_NOT_SET = ('<!-- NOT CONFIGURED: set "native_api_base" in version.json and run: python scripts/sync_version.py -->')


def version_value(meta: dict) -> str:
    return meta["version"]


def native_origin_value(meta: dict) -> str:        # app-config.js: the bare origin or ""
    return meta["native_api_base"]


def _origins(meta: dict) -> list[str]:
    """Distinct extra origins (native API host, edge-model host), in a stable order."""
    out: list[str] = []
    for origin in (meta["native_api_base"], meta["edge_model_origin"]):
        if origin and origin not in out:
            out.append(origin)
    return out


def csp_value(meta: dict) -> str:                  # index.html connect-src: " https://a https://b" or ""
    return "".join(" " + origin for origin in _origins(meta))


def edge_url_value(meta: dict) -> str:             # app-config.js: the full model URL or ""
    return meta["edge_model_url"]


def access_value(meta: dict) -> str:               # config.xml: the <access> elements, or a clear NOT CONFIGURED note
    base = meta["native_api_base"]
    parts = [f'<access origin="{base}" />' if base else CONFIG_XML_NOT_SET]
    edge = meta["edge_model_origin"]
    if edge and edge != base:
        parts.append(f'<access origin="{edge}" />')
    return "".join(parts)


# file -> [(regex with groups (before)(current value)(after), label, value function)]
TARGETS = {
    "config.xml": [
        (re.compile(r'(<widget\b[^>]*?\bversion=")([^"]*)(")'), "widget version", version_value),
        (re.compile(r"(<!-- yofilter:native-api:begin -->)(.*?)(<!-- yofilter:native-api:end -->)"), "native API <access>", access_value),
    ],
    "index.html": [
        (re.compile(r'(data-i18n="appVersion">Version )([^<]*)(</div>)'), "About page fallback text", version_value),
        (re.compile(r"(connect-src 'self' blob: data:)((?: https://[^\s;\"]+)*?)( https://\*\.aws\.cdn\.hf\.co )"),
         "CSP connect-src native API / edge model hosts", csp_value),
    ],
    "js/i18n/i18n.js": [
        (re.compile(r"(appVersion: 'Version )([^']*)(')"), "EN appVersion", version_value),
        (re.compile(r"(appVersion: 'الإصدار )([^']*)(')"), "AR appVersion", version_value),
    ],
    "js/config/app-config.js": [
        (re.compile(r'(const NATIVE_API_BASE = ")([^"]*)(";)'), "NATIVE_API_BASE", native_origin_value),
        (re.compile(r'(const EDGE_MODEL_URL = ")([^"]*)(";)'), "EDGE_MODEL_URL", edge_url_value),
    ],
}


def validate_native_base(value: object) -> str:
    """Normalise and validate ``native_api_base``; exits with a clear message when it is unusable."""
    if value is None:
        return ""
    if not isinstance(value, str):
        raise SystemExit("version.json: native_api_base must be a string")
    base = value.strip().rstrip("/")
    if not base:
        return ""
    if not NATIVE_BASE_RE.match(base):
        raise SystemExit(f"version.json: native_api_base {value!r} must be an HTTPS origin only, e.g. https://api.yourdomain.com "
                         "(no path, query, wildcard or http://)")
    host = base[len("https://"):].split(":")[0].lower()
    if host.endswith(RESERVED_TLDS) or host in {"localhost"}:
        raise SystemExit(f"version.json: native_api_base host {host!r} is a reserved / local name - use your real public host")
    return base


def validate_edge_url(value: object) -> tuple[str, str]:
    """Return (url, origin) for ``edge_model_url``; ("", "") when unset. Exits with a clear message when unusable."""
    if value is None:
        return "", ""
    if not isinstance(value, str):
        raise SystemExit("version.json: edge_model_url must be a string")
    url = value.strip()
    if not url:
        return "", ""
    match = EDGE_URL_RE.match(url)
    if not match:
        raise SystemExit(f"version.json: edge_model_url {value!r} must be an https:// file URL with a path and no query, "
                         "fragment or wildcard, e.g. https://models.yourdomain.com/portrait_depth.onnx")
    origin = match.group(1)
    host = origin[len("https://"):].split(":")[0].lower()
    if host.endswith(RESERVED_TLDS) or host in {"localhost"}:
        raise SystemExit(f"version.json: edge_model_url host {host!r} is a reserved / local name - use your real public host")
    return url, origin


def read_meta(root: Path | None = None) -> dict:
    data = json.loads(((root or ROOT) / "version.json").read_text(encoding="utf-8"))
    version = data.get("version", "")
    if not isinstance(version, str) or not VERSION_RE.match(version):
        raise SystemExit(f"version.json: '{version}' is not a semantic version (e.g. 1.0.0)")
    edge_url, edge_origin = validate_edge_url(data.get("edge_model_url", ""))
    return {"version": version, "native_api_base": validate_native_base(data.get("native_api_base", "")),
            "edge_model_url": edge_url, "edge_model_origin": edge_origin}


def set_native_base(value: str) -> None:
    """Write a validated native_api_base into version.json (all other keys and their order are kept)."""
    path = ROOT / "version.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["native_api_base"] = validate_native_base(value)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="")


def set_edge_model_url(value: str) -> None:
    """Write a validated edge_model_url into version.json (all other keys and their order are kept)."""
    path = ROOT / "version.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["edge_model_url"] = validate_edge_url(value)[0]
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="")


def run(check: bool, release: bool = False) -> int:
    meta = read_meta()
    drift: list[str] = []
    for rel, rules in TARGETS.items():
        path = ROOT / rel
        text = path.read_text(encoding="utf-8")
        for regex, label, value_of in rules:
            matches = regex.findall(text)
            if len(matches) != 1:
                drift.append(f"{rel}: expected exactly one {label}, found {len(matches)}")
                continue
            expected = value_of(meta)
            if matches[0][1] != expected:
                drift.append(f"{rel}: {label} is {matches[0][1]!r}, version.json says {expected!r}")
                text = regex.sub(lambda m: m.group(1) + expected + m.group(3), text)
        if not (check or release):
            path.write_text(text, encoding="utf-8", newline="")
    problems = list(drift)
    if release and not meta["native_api_base"]:
        problems.append("version.json: native_api_base is empty - a packaged Android build cannot reach any backend. "
                        "Run: python scripts/sync_version.py --native-api-base https://api.yourdomain.com")
    if (check or release) and problems:
        print("Release settings drift:\n  " + "\n  ".join(problems) + "\n-> run: python scripts/sync_version.py")
        return 1
    state = "in sync" if (check or release) else "stamped"
    api = meta["native_api_base"] or "not configured (web build only)"
    edge = meta["edge_model_url"] or "not configured (portrait uses the server)"
    print(f"version {meta['version']}: {state} | native API: {api} | edge model: {edge}")
    return 0


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--native-api-base" in args:
        index = args.index("--native-api-base")
        if index + 1 >= len(args):
            raise SystemExit("--native-api-base needs a value, e.g. https://api.yourdomain.com")
        set_native_base(args[index + 1])
    if "--edge-model-url" in args:
        index = args.index("--edge-model-url")
        if index + 1 >= len(args):
            raise SystemExit("--edge-model-url needs a value, e.g. https://models.yourdomain.com/portrait_depth.onnx")
        set_edge_model_url(args[index + 1])
    sys.exit(run(check="--check" in args, release="--release" in args))
