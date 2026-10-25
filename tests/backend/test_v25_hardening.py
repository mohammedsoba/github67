"""V25 / G11 - HTTP behaviour of the production profile. Needs FastAPI + both ONNX models (same fixtures as the other
API suites). The production flag is read at request time from ``backend.app.main`` so it is flipped with monkeypatch;
settings that are fixed at import time (docs URLs, default CORS list) are checked in a fresh interpreter instead."""
from __future__ import annotations

import json
import os
import subprocess
import sys

from backend.app.config import MODEL_PATH, PORTRAIT_MODEL_PATH, PROJECT_DIR
from tests.backend.test_api_contract import ORIGIN


def _fresh_app_facts(env_value: str) -> dict:
    code = ("import json; from backend.app.main import app; "
            "print(json.dumps({'docs': app.docs_url, 'redoc': app.redoc_url, 'openapi': app.openapi_url, 'title': app.title, 'version': app.version}))")
    environment = {**os.environ, "YOFILTER_ENV": env_value}
    environment.pop("ENV", None)
    out = subprocess.run([sys.executable, "-c", code], cwd=PROJECT_DIR, env=environment, capture_output=True, text=True, timeout=180)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_docs_are_off_in_production_and_on_in_development():
    prod = _fresh_app_facts("production")
    assert prod["docs"] is None and prod["redoc"] is None and prod["openapi"] is None
    dev = _fresh_app_facts("development")
    assert (dev["docs"], dev["redoc"], dev["openapi"]) == ("/docs", "/redoc", "/openapi.json")


def test_app_title_and_version_come_from_version_json():
    facts = _fresh_app_facts("development")
    meta = json.loads((PROJECT_DIR / "version.json").read_text(encoding="utf-8"))
    assert facts["title"] == "YoFilter API" and facts["version"] == meta["version"] == "1.0.0"


def test_production_health_exposes_only_status_and_the_two_model_flags(client, monkeypatch):
    from backend.app import main
    monkeypatch.setattr(main, "IS_PRODUCTION", True)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"status", "model_loaded", "portrait_model_loaded"}
    assert body["status"] == "ok" and body["model_loaded"] is True and body["portrait_model_loaded"] is True
    text = r.text
    for secret in (str(MODEL_PATH), str(PORTRAIT_MODEL_PATH), "onnxruntime", "CPUExecutionProvider", "fastapi"):
        assert secret not in text, f"/health leaks {secret!r} in production"


def test_development_health_keeps_the_full_diagnostics(client, monkeypatch):
    from backend.app import main
    monkeypatch.setattr(main, "IS_PRODUCTION", False)
    body = client.get("/health").json()
    assert {"model_path", "portrait_model_path", "dependencies", "onnx_providers", "lama_provider"} <= set(body)


def test_production_security_headers_on_page_api_and_error_responses(client, monkeypatch):
    from backend.app import main
    monkeypatch.setattr(main, "IS_PRODUCTION", True)
    page = client.get("/")
    assert page.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'none'" in page.headers["content-security-policy"]
    assert page.headers["x-frame-options"] == "DENY" and page.headers["referrer-policy"] == "no-referrer"
    api = client.get("/health")
    assert api.headers["content-security-policy"] == "default-src 'none'; frame-ancestors 'none'"
    err = client.post("/api/erase", files={"image": ("a.png", b"x", "image/png")})            # 422: mask missing
    assert err.status_code == 422 and err.headers["x-content-type-options"] == "nosniff"
    assert "content-security-policy" in err.headers
    secure = client.get("https://testserver/health")
    assert secure.headers["strict-transport-security"].startswith("max-age=")


def test_development_only_sends_nosniff(client, monkeypatch):
    from backend.app import main
    monkeypatch.setattr(main, "IS_PRODUCTION", False)
    r = client.get("/health")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "content-security-policy" not in r.headers and "x-frame-options" not in r.headers


def test_config_xml_is_not_served(client):
    for url in ("/config.xml", "/CONFIG.XML", "/version.json", "/backend/app/config.py"):
        assert client.get(url).status_code == 404, url
    assert client.get("/robots.txt").status_code == 200          # the intended root assets still work
    assert client.get("/favicon.ico").status_code == 200


def test_preflight_allows_only_the_listed_request_headers(client):
    ok = client.options("/api/erase", headers={**ORIGIN, "Access-Control-Request-Method": "POST",
                                               "Access-Control-Request-Headers": "content-type"})
    assert ok.status_code == 200
    bad = client.options("/api/erase", headers={**ORIGIN, "Access-Control-Request-Method": "POST",
                                                "Access-Control-Request-Headers": "x-evil-header"})
    assert bad.status_code == 400, "an unlisted request header must fail the preflight (no wildcard)"
