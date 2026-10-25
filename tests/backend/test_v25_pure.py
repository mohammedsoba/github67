"""V25 / G11-G12 - checks that need NEITHER FastAPI NOR the ONNX models (stdlib + backend.app.config/security only).

They run anywhere ``pytest`` runs, including a bare CI step before the heavy dependencies are installed.
No fixtures and no pytest imports on purpose: each test is a plain function.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from backend.app.config import NATIVE_APP_ORIGINS, PROJECT_DIR, resolve_allowed_origins
from backend.app.security import CORS_ALLOW_HEADERS, health_payload, is_api_path, security_headers


def _python(code: str, **env: str | None) -> str:
    """Run ``code`` in a fresh interpreter from the project root with a controlled environment."""
    environment = dict(os.environ)
    for key, value in env.items():
        if value is None:
            environment.pop(key, None)
        else:
            environment[key] = value
    out = subprocess.run([sys.executable, "-c", code], cwd=PROJECT_DIR, env=environment, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


# ------------------------------------------------------------------------------------------------ CORS origins
def test_origins_unset_dev_allows_any_origin():
    assert resolve_allowed_origins(None, production=False) == ["*"]
    assert resolve_allowed_origins("   ", production=False) == ["*"]


def test_origins_unset_in_production_denies_every_web_origin_and_keeps_only_the_android_app():
    assert resolve_allowed_origins(None, production=True) == ["https://localhost"] == NATIVE_APP_ORIGINS
    assert resolve_allowed_origins("", production=True) == ["https://localhost"]
    assert "*" not in resolve_allowed_origins(None, production=True)


def test_origins_explicit_list_is_exact_cleaned_and_never_widened():
    assert resolve_allowed_origins("https://a.example/, https://b.example ,", production=True) == ["https://a.example", "https://b.example"]
    assert resolve_allowed_origins("https://a.example", production=False) == ["https://a.example"]
    # an operator who explicitly writes * gets it (production start-up logs a warning)
    assert resolve_allowed_origins("https://a.example, *", production=True) == ["*"]


def test_production_env_flips_the_module_defaults():
    prod = _python("import json; from backend.app import config as c; print(json.dumps([c.IS_PRODUCTION, c.ALLOWED_ORIGINS]))",
                   YOFILTER_ENV="production", ENV=None, ALLOWED_ORIGINS=None)
    assert json.loads(prod) == [True, ["https://localhost"]]
    dev = _python("import json; from backend.app import config as c; print(json.dumps([c.IS_PRODUCTION, c.ALLOWED_ORIGINS]))",
                  YOFILTER_ENV="development", ENV=None, ALLOWED_ORIGINS=None)
    assert json.loads(dev) == [False, ["*"]]


def test_cors_request_header_allow_list_is_explicit():
    assert "*" not in CORS_ALLOW_HEADERS
    assert "Content-Type" in CORS_ALLOW_HEADERS          # multipart uploads


# ------------------------------------------------------------------------------------------------ security headers
def test_security_headers_production_set():
    page = security_headers("/", production=True)
    assert page["X-Content-Type-Options"] == "nosniff"
    assert "frame-ancestors 'none'" in page["Content-Security-Policy"]
    assert page["X-Frame-Options"] == "DENY" and page["Referrer-Policy"] == "no-referrer"
    assert "Strict-Transport-Security" not in page        # plain HTTP: HSTS would be meaningless
    api = security_headers("/api/erase", production=True, https=True)
    assert api["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"
    assert api["Strict-Transport-Security"].startswith("max-age=")


def test_page_csp_header_never_loosens_the_meta_policy():
    # the header carries ONLY directives a <meta> CSP cannot express or that only tighten; no script/connect/img sources
    page_csp = security_headers("/", production=True)["Content-Security-Policy"]
    assert not any(d in page_csp for d in ("script-src", "connect-src", "img-src", "style-src", "default-src"))


def test_security_headers_development_only_nosniff():
    assert security_headers("/", production=False) == {"X-Content-Type-Options": "nosniff"}
    assert security_headers("/health", production=False, https=True) == {"X-Content-Type-Options": "nosniff"}


def test_api_path_detection():
    assert is_api_path("/livez") and is_api_path("/readyz")
    assert is_api_path("/health") and is_api_path("/api/erase") and is_api_path("/api/portrait")
    assert not is_api_path("/") and not is_api_path("/js/app.js") and not is_api_path("/apiary")


# ------------------------------------------------------------------------------------------------ /health payload
def test_health_payload_production_is_exactly_three_fields_and_never_computes_diagnostics():
    def boom():
        raise AssertionError("diagnostics must not be evaluated in production")
    body = health_payload(True, model_loaded=True, portrait_loaded=False, detailed=boom)
    assert body == {"status": "degraded", "model_loaded": True, "portrait_model_loaded": False}   # any required model missing = degraded
    assert health_payload(True, model_loaded=False, portrait_loaded=False, detailed=boom)["status"] == "degraded"


def test_health_payload_development_adds_the_diagnostics():
    body = health_payload(False, model_loaded=True, portrait_loaded=True, detailed=lambda: {"model_path": "/x", "dependencies": {}})
    assert body["status"] == "ok" and body["model_path"] == "/x" and "dependencies" in body


# ------------------------------------------------------------------------------------------------ G12 version single source
def test_backend_reads_the_version_from_version_json():
    meta = json.loads((PROJECT_DIR / "version.json").read_text(encoding="utf-8"))
    out = _python("import json; from backend.app import config as c; print(json.dumps([c.APP_VERSION, c.APP_TITLE]))")
    assert json.loads(out) == [meta["version"], meta["api_title"]] == ["1.0.0", "YoFilter API"]


def _load_sync_module():
    spec = importlib.util.spec_from_file_location("sync_version", PROJECT_DIR / "scripts" / "sync_version.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_every_copy_of_the_version_is_in_sync():
    assert _load_sync_module().run(check=True) == 0


def test_sync_script_detects_drift_and_stamps_every_target_in_a_scratch_copy():
    module = _load_sync_module()
    scratch = Path(tempfile.mkdtemp(prefix="yofilter-sync-"))
    try:
        for rel in ("version.json", "config.xml", "index.html", "js/i18n/i18n.js", "js/config/app-config.js"):
            (scratch / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(PROJECT_DIR / rel, scratch / rel)
        module.ROOT = scratch
        (scratch / "version.json").write_text(json.dumps({"name": "YoFilter", "api_title": "YoFilter API", "version": "9.8.7"}), encoding="utf-8")
        assert module.run(check=True) == 1                      # drift is reported, nothing is changed
        assert "1.0.0" in (scratch / "config.xml").read_text(encoding="utf-8")
        assert module.run(check=False) == 0                     # stamped
        assert module.run(check=True) == 0
        assert 'version="9.8.7"' in (scratch / "config.xml").read_text(encoding="utf-8")
        assert "Version 9.8.7" in (scratch / "index.html").read_text(encoding="utf-8")
        i18n = (scratch / "js/i18n/i18n.js").read_text(encoding="utf-8")
        assert "appVersion: 'Version 9.8.7'" in i18n and "الإصدار 9.8.7" in i18n
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
