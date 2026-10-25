"""P1.3 - HTTP behaviour of the hardened server: CORS allow-list on success AND error responses,
429 / 503 / 499 paths, pixel cap, health fields. Uses the real app (models loaded via conftest.client);
a fresh app copy is not needed because every knob is patched at runtime."""
from __future__ import annotations

import asyncio
import io
import threading

import pytest
from PIL import Image

from backend.app import limits
from tests.backend.test_api_contract import ORIGIN, _erase_files

GOOD = {"Origin": "https://good.example"}
BAD = {"Origin": "https://evil.example"}


@pytest.fixture()
def restricted(monkeypatch):
    """Swap the CORS allow-list: the middleware instance is rebuilt around the live app."""
    from backend.app import main
    monkeypatch.setattr(main, "ALLOWED_ORIGINS", ["https://good.example"])
    main.app.user_middleware = [m for m in main.app.user_middleware if m.cls.__name__ != "CORSMiddleware"]
    from fastapi.middleware.cors import CORSMiddleware
    main.app.middleware_stack = None          # newer Starlette refuses add_middleware() while a built stack exists
    main.app.add_middleware(CORSMiddleware, allow_origins=["https://good.example"], allow_credentials=False,
                            allow_methods=main.CORS_ALLOW_METHODS, allow_headers=main.CORS_ALLOW_HEADERS,
                            expose_headers=main.EXPOSED_HEADERS, max_age=86400)
    main.app.middleware_stack = None
    yield main
    main.app.user_middleware = [m for m in main.app.user_middleware if m.cls.__name__ != "CORSMiddleware"]
    main.app.middleware_stack = None
    main.app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                            allow_methods=main.CORS_ALLOW_METHODS, allow_headers=main.CORS_ALLOW_HEADERS,
                            expose_headers=main.EXPOSED_HEADERS, max_age=86400)
    main.app.middleware_stack = None


def test_health_reports_queue_and_rate_limit(client):
    body = client.get("/health").json()
    assert body["erase_queue"] == 0
    assert isinstance(body["rate_limit_per_min"], int)


def test_cors_allow_list_on_success_error_and_preflight(client, restricted):
    ok = client.get("/health", headers=GOOD)
    assert ok.headers["access-control-allow-origin"] == "https://good.example"
    assert "access-control-allow-origin" not in client.get("/health", headers=BAD).headers
    # error responses (400 from the endpoint) follow the same rule - no leaked '*'
    err = client.post("/api/erase", files=_erase_files(image=b"nope"), headers=GOOD)
    assert err.status_code == 400 and err.headers["access-control-allow-origin"] == "https://good.example"
    err_bad = client.post("/api/erase", files=_erase_files(image=b"nope"), headers=BAD)
    assert err_bad.status_code == 400 and "access-control-allow-origin" not in err_bad.headers
    pre = client.options("/api/erase", headers={**GOOD, "Access-Control-Request-Method": "POST"})
    assert pre.status_code == 200 and pre.headers["access-control-max-age"] == "86400"
    assert "DELETE" not in pre.headers["access-control-allow-methods"]
    assert client.options("/api/erase", headers={**BAD, "Access-Control-Request-Method": "POST"}).status_code == 400


def test_429_has_retry_after_and_cors(client, restricted, monkeypatch):
    monkeypatch.setattr(limits, "limiter", limits.TokenBucket(2))
    codes = [client.post("/api/erase", files=_erase_files(image=b"x"), headers=GOOD).status_code for _ in range(3)]
    assert codes == [400, 400, 429]
    r = client.post("/api/erase", files=_erase_files(image=b"x"), headers=GOOD)
    assert r.status_code == 429 and int(r.headers["retry-after"]) >= 1
    assert r.headers["access-control-allow-origin"] == "https://good.example"
    assert client.get("/health").status_code == 200             # GETs are never limited


def test_pixel_cap_rejects_before_decode(client, monkeypatch):
    from backend.app import main
    monkeypatch.setattr(main, "ERASE_MAX_PIXELS", 1000)         # the 320x240 test scene is 76,800 px
    r = client.post("/api/erase", files=_erase_files(), headers=ORIGIN)
    assert r.status_code == 400 and "megapixels" in r.json()["detail"]


def test_reject_if_huge_ignores_garbage_and_accepts_small():
    from backend.app.main import _reject_if_huge
    _reject_if_huge(b"not an image", 10, "Image")               # left to the real decoder
    buf = io.BytesIO()
    Image.new("RGB", (10, 10)).save(buf, "PNG")
    _reject_if_huge(buf.getvalue(), 100, "Image")


def test_full_queue_answers_503_with_retry_after_and_no_500(client, monkeypatch):
    from backend.app import main
    state = client.app.state
    monkeypatch.setattr(limits, "limiter", limits.TokenBucket(0))
    monkeypatch.setattr(main, "ERASE_MAX_QUEUE", 2)
    gate = threading.Event()
    real = state.inpainter.erase_profiled
    monkeypatch.setattr(state.inpainter, "erase_profiled", lambda *a, **k: (gate.wait(10), real(*a, **k))[1])

    results: list[int] = []

    def fire():
        results.append(client.post("/api/erase", files=_erase_files(), headers=ORIGIN).status_code)

    threads = [threading.Thread(target=fire) for _ in range(6)]       # 1 running + 2 queued + 3 rejected
    for t in threads:
        t.start()
    deadline = threading.Event()
    for _ in range(100):                                               # let the rejections come back
        if results.count(503) >= 3:
            break
        deadline.wait(0.1)
    busy = client.post("/api/erase", files=_erase_files(), headers=ORIGIN)
    assert busy.status_code == 503 and busy.headers["retry-after"] == "5"
    assert busy.headers["access-control-allow-origin"] in ("*", ORIGIN["Origin"])
    gate.set()
    for t in threads:
        t.join(30)
    assert sorted(results) == [200, 200, 200, 503, 503, 503]
    assert 500 not in results
    assert state.erase_waiting == 0                                    # counter fully unwound
