"""Unit tests for backend/app/body_guard.py - pure ASGI, no FastAPI, no models, no pytest plugins.

The middleware is driven with hand-written ASGI ``receive`` / ``send`` callables, so these run anywhere
(``pytest tests/backend/test_body_guard.py``) and also stand-alone (``python tests/backend/test_body_guard.py``).
"""
from __future__ import annotations

import asyncio
import json

from backend.app.body_guard import BodyGuardMiddleware

MB = 1024 * 1024


class TooLarge(Exception):
    """Stand-in for Starlette's HTTPException(413) so these tests do not need Starlette."""


def _scope(path="/api/portrait", method="POST", content_length=None, extra=()):
    headers = [(b"host", b"t")]
    if content_length is not None:
        headers.append((b"content-length", str(content_length).encode()))
    headers += list(extra)
    return {"type": "http", "method": method, "path": path, "headers": headers}


def _receiver(chunks):
    queue = list(chunks)

    async def receive():
        if queue:
            body = queue.pop(0)
            return {"type": "http.request", "body": body, "more_body": bool(queue)}
        return {"type": "http.disconnect"}
    return receive


class Sink:
    def __init__(self):
        self.messages = []

    async def __call__(self, message):
        self.messages.append(message)

    @property
    def status(self):
        return next((m["status"] for m in self.messages if m["type"] == "http.response.start"), None)

    @property
    def headers(self):
        start = next((m for m in self.messages if m["type"] == "http.response.start"), {})
        return {k.decode(): v.decode() for k, v in start.get("headers", ())}

    @property
    def body(self):
        return b"".join(m.get("body", b"") for m in self.messages if m["type"] == "http.response.body")


def _ok_app(seen=None):
    """Reads the whole request body, answers 200 - like a route handler would."""
    async def app(scope, receive, send):
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            total += len(message["body"])
            if not message.get("more_body"):
                break
        if seen is not None:
            seen.append(total)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})
    return app


def _guard(app, **kw):
    kw.setdefault("limits", {"/api/portrait": 10 * MB, "/api/erase": 20 * MB})
    kw.setdefault("default_limit", 10 * MB)
    kw.setdefault("too_large", lambda limit: TooLarge(limit))
    return BodyGuardMiddleware(app, **kw)


def run(coro, timeout: float = 10.0):
    """asyncio.run with a hard timeout, so a hung scenario FAILS instead of blocking the whole suite."""
    return asyncio.run(asyncio.wait_for(coro, timeout))


# ---------------------------------------------------------------- Content-Length gate
def test_declared_length_over_limit_is_413_and_the_app_never_runs():
    seen = []
    guard, sink = _guard(_ok_app(seen)), Sink()
    run(guard(_scope(content_length=10 * MB + 1), _receiver([b"x"]), sink))
    assert sink.status == 413 and not seen
    assert sink.headers["connection"] == "close" and sink.headers["content-type"] == "application/json"
    assert "10 MB" in json.loads(sink.body)["detail"]
    assert guard.inflight == 0 and guard.inflight_bytes == 0


def test_declared_length_at_the_limit_is_accepted():
    seen = []
    guard, sink = _guard(_ok_app(seen)), Sink()
    run(guard(_scope(content_length=10 * MB), _receiver([b"a" * (10 * MB)]), sink))
    assert sink.status == 200 and seen == [10 * MB]


def test_per_route_limits_erase_allows_two_files():
    guard = _guard(_ok_app())
    s1, s2 = Sink(), Sink()
    run(guard(_scope("/api/erase", content_length=15 * MB), _receiver([b"a" * (15 * MB)]), s1))
    run(guard(_scope("/api/portrait", content_length=15 * MB), _receiver([b"a"]), s2))
    assert s1.status == 200 and s2.status == 413


def test_malformed_content_length_is_400():
    for raw in (b"abc", b"-5", b"1e9", b"", b"1 2"):
        guard, sink = _guard(_ok_app()), Sink()
        run(guard(_scope(extra=[(b"content-length", raw)]), _receiver([b"x"]), sink))
        assert sink.status == 400, raw


def test_conflicting_duplicate_content_length_is_400():
    guard, sink = _guard(_ok_app()), Sink()
    run(guard(_scope(extra=[(b"content-length", b"5"), (b"content-length", b"6")]), _receiver([b"x"]), sink))
    assert sink.status == 400


# ----------------------------------------------------------------- streaming counter
def test_chunked_body_without_content_length_is_cut_off_on_the_fly():
    chunks = [b"a" * MB] * 12                      # 12 MB, limit 10 MB, no Content-Length at all
    reads = []

    async def app(scope, receive, send):
        try:
            while True:
                message = await receive()
                reads.append(len(message["body"]))
                if not message.get("more_body"):
                    break
        except TooLarge:
            await send({"type": "http.response.start", "status": 413, "headers": [(b"content-type", b"application/json")]})
            await send({"type": "http.response.body", "body": b"{}"})
            return
        raise AssertionError("the 12 MB body must not be delivered")

    guard, sink = _guard(app), Sink()
    run(guard(_scope(), _receiver(chunks), sink))
    assert sink.status == 413
    assert len(reads) == 10                          # the 11th chunk crossed the limit and was never handed to the app
    assert sink.headers["connection"] == "close"     # injected into the app's own response
    assert guard.inflight == 0 and guard.inflight_bytes == 0


def test_lying_content_length_cannot_smuggle_a_bigger_body():
    chunks = [b"a" * MB] * 12                        # declares 1 MB, sends 12 MB

    async def app(scope, receive, send):
        try:
            while True:
                message = await receive()
                if not message.get("more_body"):
                    break
        except TooLarge:
            await send({"type": "http.response.start", "status": 413, "headers": []})
            await send({"type": "http.response.body", "body": b""})
            return
        raise AssertionError("must be cut off")

    guard, sink = _guard(app), Sink()
    run(guard(_scope(content_length=1 * MB), _receiver(chunks), sink))
    assert sink.status == 413


def test_exceeded_state_sticks_for_later_receive_calls():
    async def app(scope, receive, send):
        for _ in range(2):
            try:
                await receive()
            except TooLarge:
                continue
        await send({"type": "http.response.start", "status": 413, "headers": []})
        await send({"type": "http.response.body", "body": b""})
    guard, sink = _guard(app, limits={}, default_limit=1 * MB), Sink()
    run(guard(_scope(), _receiver([b"a" * (2 * MB), b"b"]), sink))
    assert sink.status == 413


# ------------------------------------------------------------------------ scope
def test_non_api_get_and_options_are_not_guarded():
    seen = []
    guard = _guard(_ok_app(seen))
    for scope in (_scope("/", method="POST", content_length=99 * MB), _scope("/api/portrait", method="GET", content_length=99 * MB),
                  _scope("/api/portrait", method="OPTIONS", content_length=99 * MB), _scope("/apix", content_length=99 * MB)):
        sink = Sink()
        run(guard(scope, _receiver([b"x"]), sink))
        assert sink.status == 200, scope["path"]


def test_websocket_and_lifespan_pass_through():
    called = []

    async def app(scope, receive, send):
        called.append(scope["type"])
    guard = _guard(app)
    run(guard({"type": "lifespan"}, None, None))
    assert called == ["lifespan"]


def test_trailing_slash_uses_the_route_limit():
    guard = _guard(_ok_app())
    sink = Sink()
    run(guard(_scope("/api/erase/", content_length=15 * MB), _receiver([b"x"]), sink))
    assert sink.status == 200


# ------------------------------------------------------------- in-flight cap
def _blocking_app(gate: asyncio.Event, entered: list):
    async def app(scope, receive, send):
        entered.append(1)
        await gate.wait()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b""})
    return app


def test_inflight_request_cap_503_with_retry_after_then_recovers():
    async def scenario():
        gate, entered = asyncio.Event(), []
        guard = _guard(_blocking_app(gate, entered), max_inflight=3, max_inflight_bytes=10_000 * MB)
        sinks = [Sink() for _ in range(3)]
        tasks = [asyncio.create_task(guard(_scope(content_length=1000), _receiver([b"x"]), s)) for s in sinks]
        await asyncio.sleep(0.05)
        assert guard.inflight == 3
        extra = Sink()
        await guard(_scope(content_length=1000), _receiver([b"x"]), extra)
        assert extra.status == 503 and extra.headers["retry-after"] == "5" and entered == [1, 1, 1]
        gate.set()
        await asyncio.gather(*tasks)
        assert [s.status for s in sinks] == [200, 200, 200]
        assert guard.inflight == 0 and guard.inflight_bytes == 0
        again = Sink()
        await guard(_scope(content_length=1000), _receiver([b"x"]), again)
        assert again.status == 200
    run(scenario())


def test_inflight_byte_budget_counts_declared_length_or_route_limit():
    async def budget_only():
        gate, entered = asyncio.Event(), []
        guard = _guard(_blocking_app(gate, entered), limits={"/api/portrait": 10 * MB}, default_limit=10 * MB, max_inflight=50, max_inflight_bytes=12 * MB)
        t1 = asyncio.create_task(guard(_scope(content_length=8 * MB), _receiver([b"x"]), Sink()))
        await asyncio.sleep(0.05)
        over = Sink()
        await guard(_scope(content_length=5 * MB), _receiver([b"x"]), over)        # 8 + 5 > 12 -> refused
        assert over.status == 503
        t2 = asyncio.create_task(guard(_scope(content_length=4 * MB), _receiver([b"x"]), Sink()))   # 8 + 4 = 12 -> admitted
        await asyncio.sleep(0.05)
        assert guard.inflight == 2 and guard.inflight_bytes == 12 * MB
        gate.set()
        await asyncio.gather(t1, t2)
        assert guard.inflight == 0 and guard.inflight_bytes == 0
        # unknown length reserves the whole route limit (10 MB): 8 + 10 > 12 -> refused
        gate2, entered2 = asyncio.Event(), []
        guard2 = _guard(_blocking_app(gate2, entered2), limits={"/api/portrait": 10 * MB}, default_limit=10 * MB, max_inflight=50, max_inflight_bytes=12 * MB)
        t3 = asyncio.create_task(guard2(_scope(content_length=8 * MB), _receiver([b"x"]), Sink()))
        await asyncio.sleep(0.05)
        chunked = Sink()
        await guard2(_scope(), _receiver([b"x"]), chunked)
        assert chunked.status == 503
        gate2.set()
        await t3
    run(budget_only())


def test_slot_is_released_when_the_app_raises():
    async def boom(scope, receive, send):
        raise RuntimeError("handler crashed")
    guard = _guard(boom)
    try:
        run(guard(_scope(content_length=10), _receiver([b"x"]), Sink()))
    except RuntimeError:
        pass
    assert guard.inflight == 0 and guard.inflight_bytes == 0


def test_slot_is_released_when_the_request_is_cancelled():
    async def scenario():
        gate = asyncio.Event()
        guard = _guard(_blocking_app(gate, []))
        task = asyncio.create_task(guard(_scope(content_length=10), _receiver([b"x"]), Sink()))
        await asyncio.sleep(0.05)
        assert guard.inflight == 1
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        assert guard.inflight == 0 and guard.inflight_bytes == 0
    run(scenario())


def test_budget_is_never_smaller_than_the_biggest_single_request():
    guard = _guard(_ok_app(), max_inflight_bytes=1)
    assert guard.max_inflight_bytes >= 20 * MB


if __name__ == "__main__":                     # stand-alone runner (no pytest needed)
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("  ok  ", name)
            except Exception as exc:           # noqa: BLE001
                failures += 1
                print("  FAIL", name, type(exc).__name__, exc)
    raise SystemExit(1 if failures else 0)
