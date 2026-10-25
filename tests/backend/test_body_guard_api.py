"""Body guard wired into a REAL FastAPI app (needs fastapi + httpx; no models).

The unit tests (test_body_guard.py) use a stand-in exception. This suite pins the one assumption they cannot prove:
an HTTPException(413) raised from ``receive`` WHILE FastAPI is parsing the multipart body comes out as a clean JSON
413 with CORS headers - not as FastAPI's generic ``400 There was an error parsing the body``.

The app mirrors main.py's middleware order: guard INSIDE CORSMiddleware.
"""
from __future__ import annotations

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("multipart")

from fastapi import FastAPI, File, UploadFile                      # noqa: E402
from fastapi.middleware.cors import CORSMiddleware                 # noqa: E402
from fastapi.testclient import TestClient                          # noqa: E402

from backend.app.body_guard import BodyGuardMiddleware             # noqa: E402

KB = 1024
LIMIT = 256 * KB
ORIGIN = {"Origin": "http://frontend.test"}


def _build(max_inflight: int = 8):
    api = FastAPI()

    @api.post("/api/portrait")
    async def portrait(image: UploadFile = File(...)):
        data = await image.read()
        return {"size": len(data)}

    api.add_middleware(BodyGuardMiddleware, limits={"/api/portrait": LIMIT}, default_limit=LIMIT,
                       max_inflight=max_inflight, max_inflight_bytes=64 * LIMIT)
    api.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["GET", "POST", "OPTIONS"], allow_headers=["*"])
    return api


def _strip_content_length(inner):
    """Simulates a chunked upload / a lying client: the guard sees NO Content-Length and must count bytes."""
    async def app(scope, receive, send):
        if scope["type"] == "http":
            scope = {**scope, "headers": [h for h in scope["headers"] if h[0] != b"content-length"]}
        await inner(scope, receive, send)
    return app


def test_within_limit_upload_passes_through():
    client = TestClient(_build())
    r = client.post("/api/portrait", files={"image": ("a.jpg", b"x" * (100 * KB), "image/jpeg")}, headers=ORIGIN)
    assert r.status_code == 200 and r.json() == {"size": 100 * KB}


def test_declared_oversize_is_413_json_with_cors_and_connection_close():
    client = TestClient(_build())
    r = client.post("/api/portrait", files={"image": ("a.jpg", b"x" * (LIMIT + 10 * KB), "image/jpeg")}, headers=ORIGIN)
    assert r.status_code == 413, r.text[:200]
    assert r.headers["access-control-allow-origin"] in ("*", ORIGIN["Origin"])
    assert r.headers["content-type"].startswith("application/json") and r.json()["detail"]
    assert r.headers.get("connection", "").lower() == "close"


def test_streamed_oversize_without_content_length_is_413_not_400():
    client = TestClient(_strip_content_length(_build()))
    r = client.post("/api/portrait", files={"image": ("a.jpg", b"x" * (LIMIT + 10 * KB), "image/jpeg")}, headers=ORIGIN)
    assert r.status_code == 413, (r.status_code, r.text[:200])      # a 400 here means FastAPI swallowed the exception
    assert r.headers["access-control-allow-origin"] in ("*", ORIGIN["Origin"])
    assert r.json()["detail"]


def test_server_stays_healthy_after_rejections():
    client = TestClient(_strip_content_length(_build()))
    for _ in range(5):
        assert client.post("/api/portrait", files={"image": ("a.jpg", b"x" * (LIMIT + KB), "image/jpeg")}).status_code == 413
    ok = client.post("/api/portrait", files={"image": ("a.jpg", b"x" * KB, "image/jpeg")})
    assert ok.status_code == 200


def test_get_requests_are_untouched():
    api = _build()

    @api.get("/health")
    async def health():
        return {"status": "ok"}
    assert TestClient(api).get("/health").status_code == 200
