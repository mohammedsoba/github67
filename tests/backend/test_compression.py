"""HTTP compression (backend/app/compression.py) and its wiring in main.py.

Part 1 is pure ASGI + stdlib: no FastAPI, no models, no network. Part 2 needs Starlette (skipped when it is missing). Part 3 is
a static check of main.py. Part 4 uses the real app (``client`` fixture, needs the models like the other API suites).
"""
from __future__ import annotations

import asyncio
import gzip
import re
import zlib
from pathlib import Path

import pytest

from backend.app.compression import (
    CompressionMiddleware,
    build_encoders,
    is_compressible,
    negotiate,
    parse_accept_encoding,
)

ROOT = Path(__file__).resolve().parents[2]
TEXT = (b"function eraseThing(a, b) { return a + b; }\n" * 200)          # ~8.8 KB of very compressible JS
JS = b"text/javascript; charset=utf-8"


class FakeBrotli:
    """Stand-in encoder (the real wheel is optional): proves negotiation / headers / streaming without the library."""
    def __init__(self) -> None:
        self._first = True

    def compress(self, data: bytes) -> bytes:
        out = (b"BR:" if self._first else b"") + data[::-1]
        self._first = False
        return out

    def finish(self) -> bytes:
        return b":END"


def gzip_only():
    return {k: v for k, v in build_encoders().items() if k == "gzip"}


def with_fake_br():
    return {"br": FakeBrotli, **gzip_only()}


def make_app(body=TEXT, ctype: bytes = JS, status: int = 200, chunks: int = 1, headers=(), content_length: bool = True, record=None):
    """An ASGI app that answers ``body`` (split into ``chunks`` messages) like Starlette's FileResponse would."""
    async def app(scope, receive, send):
        if record is not None:
            record.append(scope)
        hdrs = [(b"content-type", ctype), *headers]
        if content_length:
            hdrs.append((b"content-length", str(len(body)).encode()))
        await send({"type": "http.response.start", "status": status, "headers": hdrs})
        size = max(1, -(-len(body) // chunks))
        pieces = [body[i:i + size] for i in range(0, len(body), size)] or [b""]
        for index, piece in enumerate(pieces):
            await send({"type": "http.response.body", "body": piece, "more_body": index < len(pieces) - 1})
    return app


def call(app, *, accept: str | None = "gzip", path: str = "/js/app.js", method: str = "GET", scope_type: str = "http", **mw_kwargs):
    """Drive the middleware once; returns (status, {header: value}, body_bytes, messages)."""
    mw_kwargs.setdefault("encoders", gzip_only())
    middleware = CompressionMiddleware(app, **mw_kwargs)
    headers = [(b"accept-encoding", accept.encode())] if accept is not None else []
    scope = {"type": scope_type, "method": method, "path": path, "headers": headers,
             "extensions": {"http.response.pathsend": {}, "http.response.template": {}}}
    sent: list[dict] = []

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))
    start = next(m for m in sent if m["type"] == "http.response.start")
    out_headers: dict[str, str] = {}
    for key, value in start["headers"]:
        out_headers.setdefault(key.decode().lower(), value.decode())
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], out_headers, body, sent


# ================================================================= Part 1: pure ASGI =====================================
def test_gzip_round_trip_and_headers():
    status, h, body, _ = call(make_app(headers=[(b"etag", b'"abc"'), (b"accept-ranges", b"bytes")]))
    assert status == 200
    assert h["content-encoding"] == "gzip"
    assert "content-length" not in h and "accept-ranges" not in h          # both described the identity bytes
    assert h["vary"] == "Accept-Encoding"
    assert h["etag"] == 'W/"abc"'                                          # different bytes -> the validator turns weak
    assert gzip.decompress(body) == TEXT and len(body) < len(TEXT) / 5


def test_identity_when_the_client_sends_no_accept_encoding_but_vary_is_still_set():
    status, h, body, _ = call(make_app(), accept=None)
    assert body == TEXT and "content-encoding" not in h
    assert h["content-length"] == str(len(TEXT)) and h["vary"] == "Accept-Encoding"


def test_images_fonts_and_models_are_never_touched():
    for ctype in (b"image/png", b"image/jpeg", b"image/webp", b"font/woff2", b"application/octet-stream"):
        status, h, body, _ = call(make_app(b"\x89PNG" * 5000, ctype=ctype))
        assert "content-encoding" not in h and "vary" not in h, ctype
        assert body == b"\x89PNG" * 5000 and h["content-length"] == "20000"


def test_api_paths_are_skipped_even_for_a_compressible_type():
    _, h, body, _ = call(make_app(b'{"detail": "x"}' * 500, ctype=b"application/json"), path="/api/erase")
    assert "content-encoding" not in h and "vary" not in h


def test_small_bodies_are_sent_as_they_are():
    small = b"a" * 100
    _, h, body, _ = call(make_app(small), minimum_size=1024)                                  # Content-Length known
    assert body == small and "content-encoding" not in h and h["vary"] == "Accept-Encoding"
    _, h, body, _ = call(make_app(small, content_length=False), minimum_size=1024)             # unknown length, single message
    assert body == small and "content-encoding" not in h


def test_unknown_length_streamed_body_is_compressed_chunk_by_chunk():
    _, h, body, sent = call(make_app(TEXT * 20, chunks=7, content_length=False))
    assert h["content-encoding"] == "gzip" and gzip.decompress(body) == TEXT * 20
    bodies = [m for m in sent if m["type"] == "http.response.body"]
    assert bodies[-1]["more_body"] is False and all(m["more_body"] for m in bodies[:-1])      # one terminated stream


def test_wasm_and_json_and_svg_are_compressed():
    for ctype in (b"application/wasm", b"application/json", b"image/svg+xml", b"text/html; charset=utf-8", b"text/css; charset=utf-8"):
        _, h, body, _ = call(make_app(TEXT, ctype=ctype))
        assert h["content-encoding"] == "gzip", ctype


def test_event_streams_are_never_buffered_into_a_compressor():
    assert not is_compressible("text/event-stream")
    _, h, _, _ = call(make_app(TEXT, ctype=b"text/event-stream"))
    assert "content-encoding" not in h


def test_responses_that_are_not_a_plain_200_pass_through():
    for status in (206, 304, 404, 500):
        _, h, body, _ = call(make_app(TEXT, status=status))
        assert "content-encoding" not in h, status
    _, h, body, _ = call(make_app(TEXT, headers=[(b"content-encoding", b"br")]))               # already encoded: never twice
    assert h["content-encoding"] == "br" and body == TEXT
    _, h, _, _ = call(make_app(TEXT, headers=[(b"cache-control", b"public, No-Transform")]))
    assert "content-encoding" not in h


def test_head_and_non_http_scopes_are_not_wrapped():
    called = []

    async def app(scope, receive, send):
        called.append(scope["type"])

    for scope_type, method in (("lifespan", "GET"), ("websocket", "GET"), ("http", "HEAD")):
        middleware = CompressionMiddleware(app, encoders=gzip_only())
        asyncio.run(middleware({"type": scope_type, "method": method, "path": "/", "headers": [(b"accept-encoding", b"gzip")]}, None, None))
    assert called == ["lifespan", "websocket", "http"]


def test_vary_merges_with_cors_and_is_not_duplicated():
    _, h, _, sent = call(make_app(headers=[(b"vary", b"Origin")]))
    values = [v for k, v in sent[0]["headers"] if k == b"vary"]
    assert values == [b"Origin", b"Accept-Encoding"]                                           # CORS's header is kept, ours added
    _, _, _, sent = call(make_app(headers=[(b"vary", b"Accept-Encoding, Origin")]))
    assert [v for k, v in sent[0]["headers"] if k == b"vary"] == [b"Accept-Encoding, Origin"]


def test_existing_weak_etag_is_not_double_prefixed():
    _, h, _, _ = call(make_app(headers=[(b"etag", b'W/"abc"')]))
    assert h["etag"] == 'W/"abc"'


def test_pathsend_extension_is_hidden_so_fileresponse_streams_through_the_middleware():
    seen: list[dict] = []
    call(make_app(record=seen))
    assert "http.response.pathsend" not in seen[0]["extensions"] and "http.response.template" in seen[0]["extensions"]
    seen.clear()
    call(make_app(record=seen), accept=None)                                  # identity client: scope is left alone
    assert "http.response.pathsend" in seen[0]["extensions"]


def test_a_pathsend_response_is_forwarded_untouched():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", JS)]})
        await send({"type": "http.response.pathsend", "path": "/x"})
    _, h, _, sent = call(app)
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.pathsend"] and "content-encoding" not in h


def test_an_app_that_fails_before_its_first_body_has_sent_nothing():
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", JS)]})
        raise RuntimeError("boom")
    sent: list[dict] = []

    async def collect(message):
        sent.append(message)

    middleware = CompressionMiddleware(app, encoders=gzip_only())
    with pytest.raises(RuntimeError):
        asyncio.run(middleware({"type": "http", "method": "GET", "path": "/", "headers": [(b"accept-encoding", b"gzip")]}, None, collect))
    assert sent == []                                  # the held start was never released: the server can still answer a clean 500


# ---------------------------------------------------------------- negotiation
def test_parse_accept_encoding():
    assert parse_accept_encoding("br;q=0.8, gzip, *;q=0") == {"br": 0.8, "gzip": 1.0, "*": 0.0}
    assert parse_accept_encoding("gzip;q=oops, deflate;q=2, x;q=nan") == {"gzip": 0.0, "deflate": 0.0, "x": 0.0}
    assert parse_accept_encoding(",,") == {}


def test_negotiation_rules():
    assert negotiate("gzip, deflate, br", ["br", "gzip"]) == "br"                  # server preference on equal q
    assert negotiate("gzip, br;q=0.5", ["br", "gzip"]) == "gzip"                   # client weights win
    assert negotiate("br;q=0, gzip", ["br", "gzip"]) == "gzip"
    assert negotiate("gzip;q=0", ["br", "gzip"]) is None
    assert negotiate("*", ["br", "gzip"]) == "br"
    assert negotiate("*;q=0, gzip", ["br", "gzip"]) == "gzip"
    assert negotiate("identity", ["br", "gzip"]) is None
    assert negotiate("br", ["gzip"]) is None                                        # Brotli not installed: fall back to identity
    assert negotiate(None, ["gzip"]) is None and negotiate("", ["gzip"]) is None


def test_a_brotli_capable_client_gets_br_through_the_encoder_seam():
    _, h, body, _ = call(make_app(b"hello world " * 200), accept="gzip, br", encoders=with_fake_br())
    assert h["content-encoding"] == "br" and body.startswith(b"BR:") and body.endswith(b":END")
    _, h, body, _ = call(make_app(b"hello world " * 200), accept="gzip", encoders=with_fake_br())
    assert h["content-encoding"] == "gzip"


def test_real_brotli_round_trip():
    brotli = pytest.importorskip("brotli")
    _, h, body, _ = call(make_app(TEXT * 10, chunks=5), accept="br", encoders=build_encoders())
    assert h["content-encoding"] == "br" and brotli.decompress(body) == TEXT * 10


def test_real_gzip_output_is_a_valid_gzip_stream():
    _, _, body, _ = call(make_app(TEXT * 3, chunks=3))
    assert body[:2] == b"\x1f\x8b" and zlib.decompress(body, 31) == TEXT * 3


def test_static_files_helpers_choose_sane_types():
    for ctype in ("text/html", "text/css", "text/javascript", "application/javascript", "application/wasm", "application/json",
                  "image/svg+xml", "application/problem+json", "application/atom+xml"):
        assert is_compressible(ctype), ctype
    for ctype in ("image/png", "image/jpeg", "image/webp", "font/woff2", "application/octet-stream", "application/pdf", "video/mp4"):
        assert not is_compressible(ctype), ctype


# ================================================================= Part 2: Starlette integration ==========================
def _mini_client(tmp_path):
    pytest.importorskip("starlette")
    pytest.importorskip("httpx")
    from starlette.applications import Starlette
    from starlette.responses import Response
    from starlette.routing import Mount, Route
    from starlette.staticfiles import StaticFiles
    from starlette.testclient import TestClient

    (tmp_path / "app.js").write_bytes(TEXT)
    (tmp_path / "pic.png").write_bytes(b"\x89PNG\r\n" + bytes(range(256)) * 80)
    png = b"\x89PNG" + bytes(range(256)) * 400

    async def erase(request):
        return Response(png, media_type="image/png")

    app = Starlette(routes=[Route("/api/erase", erase, methods=["GET"]), Mount("/js", StaticFiles(directory=tmp_path))])
    app.add_middleware(CompressionMiddleware, encoders=gzip_only())
    return TestClient(app), png


def test_starlette_static_file_is_gzipped_and_revalidation_still_works(tmp_path):
    client, _ = _mini_client(tmp_path)
    r = client.get("/js/app.js", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers["content-encoding"] == "gzip" and r.content == TEXT         # httpx inflated it
    assert r.headers["vary"] == "Accept-Encoding" and r.headers["etag"].startswith("W/")
    again = client.get("/js/app.js", headers={"Accept-Encoding": "gzip", "If-None-Match": r.headers["etag"]})
    assert again.status_code == 304                                                                          # weak validator accepted by StaticFiles
    plain = client.get("/js/app.js", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in plain.headers and plain.content == TEXT


def test_starlette_png_assets_and_api_results_are_never_recompressed(tmp_path):
    client, png = _mini_client(tmp_path)
    for url, expected in (("/js/pic.png", None), ("/api/erase", png)):
        r = client.get(url, headers={"Accept-Encoding": "gzip"})
        assert r.status_code == 200 and "content-encoding" not in r.headers, url
        if expected is not None:
            assert r.content == expected


def test_starlette_range_requests_are_not_compressed(tmp_path):
    client, _ = _mini_client(tmp_path)
    r = client.get("/js/app.js", headers={"Accept-Encoding": "gzip", "Range": "bytes=0-99"})
    assert r.status_code == 206 and "content-encoding" not in r.headers and r.content == TEXT[:100]


# ================================================================= Part 3: main.py wiring (static) ========================
MAIN = (ROOT / "backend" / "app" / "main.py").read_text(encoding="utf-8")


def test_compression_is_the_outermost_middleware_in_main():
    last_layer = max(MAIN.index("app.add_middleware(\n    CORSMiddleware"), MAIN.index("async def add_security_headers"))
    wiring = MAIN.index("app.add_middleware(\n        CompressionMiddleware")
    assert wiring > last_layer, "registered last = outermost: it must see the final headers (CORS, security)"
    assert "starlette.middleware.gzip" not in MAIN and "add_middleware(GZipMiddleware" not in MAIN   # the stock one gzips the PNG result at level 9
    assert re.search(r"if HTTP_COMPRESSION:\n    app\.add_middleware", MAIN)     # HTTP_COMPRESSION=0 really switches it off


def test_the_eraser_response_is_still_a_png_and_api_is_in_the_default_skip_list():
    from backend.app.compression import DEFAULT_SKIP_PREFIXES
    assert "/api/" in DEFAULT_SKIP_PREFIXES
    assert 'media_type="image/png"' in MAIN


# ================================================================= Part 4: the real app (needs the models) ================
def test_real_app_serves_the_frontend_compressed_and_the_erase_png_untouched(client):
    r = client.get("/", headers={"Accept-Encoding": "gzip"})
    assert r.status_code == 200 and r.headers.get("content-encoding") == "gzip" and b"<html" in r.content.lower()
    js = client.get("/js/core/state.js", headers={"Accept-Encoding": "gzip"})
    assert js.status_code == 200 and js.headers.get("content-encoding") == "gzip"
    png = client.get("/icon.png", headers={"Accept-Encoding": "gzip"})
    assert png.status_code == 200 and "content-encoding" not in png.headers
    live = client.get("/livez", headers={"Accept-Encoding": "gzip"})
    assert live.status_code == 200 and "content-encoding" not in live.headers          # tiny JSON: below the minimum size
