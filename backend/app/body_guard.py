"""Request-body guard: reject oversized / excess uploads BEFORE they are parsed, buffered or spooled.

Why this exists
    FastAPI/Starlette parse the whole multipart body (spooling it to /tmp and then to RAM through ``UploadFile.read``)
    before a route handler runs. The handler-level 25 MB / "busy" checks therefore fire only after the bandwidth, the
    disk and the memory have already been spent. This is a pure ASGI middleware (not ``BaseHTTPMiddleware``), so it
    sits in front of the body and sees every ``http.request`` chunk as it arrives.

What it does (POST / PUT / PATCH under ``/api/`` only)
    1. Content-Length gate   - a declared length above the route limit is answered ``413`` at once; the body is never read.
                               A malformed Content-Length is ``400``.
    2. Streaming byte counter - the length may be missing (chunked) or a lie: every chunk is counted and the request is
                               cut off with ``413`` the moment the running total passes the limit.
    3. In-flight cap         - at most ``max_inflight`` requests AND ``max_inflight_bytes`` reserved bytes are admitted
                               at the same time (uploading, queued for a model slot, or processing - all of them hold
                               their upload in RAM). Beyond that: ``503`` + ``Retry-After``.

Response conventions (match the rest of the API): JSON ``{"detail": ...}``; ``Connection: close`` on every early
rejection so the server stops reading the rest of the body. Placed INSIDE CORSMiddleware (see main.py) so the 413 / 503
still carry CORS and security headers and the browser shows the real message instead of "Failed to fetch".
"""

from __future__ import annotations

import json
from typing import Any, Awaitable, Callable, Mapping, MutableMapping

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

GUARDED_METHODS = frozenset({"POST", "PUT", "PATCH"})


def _mb(n: int) -> str:
    return f"{n / (1024 * 1024):g}"


def _default_too_large(limit: int) -> Exception:
    """Raised from inside ``receive`` while the route is still reading the body.

    It MUST be an ``HTTPException``: FastAPI re-raises those untouched while parsing the body, whereas any other
    exception would be rewritten into a generic ``400 There was an error parsing the body``. The normal exception
    handler then renders the same JSON 413 as every other error.
    """
    from starlette.exceptions import HTTPException      # lazy: this module stays importable (and unit-testable) without Starlette

    return HTTPException(status_code=413, detail=f"Request body is larger than the {_mb(limit)} MB limit for this endpoint")


class _RequestState:
    __slots__ = ("received", "exceeded")

    def __init__(self) -> None:
        self.received = 0
        self.exceeded = False


class BodyGuardMiddleware:
    def __init__(
        self,
        app: Callable[[Scope, Receive, Send], Awaitable[None]],
        *,
        limits: Mapping[str, int],
        default_limit: int,
        max_inflight: int = 8,
        max_inflight_bytes: int = 256 * 1024 * 1024,
        prefix: str = "/api/",
        retry_after: int = 5,
        too_large: Callable[[int], Exception] = _default_too_large,
    ) -> None:
        self.app = app
        self.limits = {path.rstrip("/"): int(value) for path, value in limits.items()}
        self.default_limit = int(default_limit)
        self.max_inflight = max(1, int(max_inflight))
        # A single legitimate request must always fit in the budget, otherwise the largest route could never be served.
        self.max_inflight_bytes = max(int(max_inflight_bytes), self.default_limit, *self.limits.values())
        self.prefix = prefix
        self.retry_after = int(retry_after)
        self._too_large = too_large
        self.inflight = 0              # requests currently admitted
        self.inflight_bytes = 0        # bytes reserved by them (declared Content-Length, or the route limit when unknown)

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _declared_length(scope: Scope) -> tuple[int | None, bool]:
        """(Content-Length or None, malformed?). Duplicate headers with different values count as malformed."""
        values = {value.strip() for name, value in scope.get("headers", ()) if name == b"content-length"}
        if not values:
            return None, False
        if len(values) > 1:
            return None, True
        raw = next(iter(values))
        if not raw.isdigit():
            return None, True
        return int(raw), False

    @staticmethod
    async def _reject(send: Send, status: int, detail: str, extra: list[tuple[bytes, bytes]] | None = None) -> None:
        body = json.dumps({"detail": detail}).encode("utf-8")
        headers = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode("ascii")),
                   (b"connection", b"close")]            # do not wait for / read the rest of the upload
        headers += extra or []
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    # --------------------------------------------------------------------- ASGI
    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = str(scope.get("path", "")).rstrip("/")
        if (scope["type"] != "http" or scope.get("method") not in GUARDED_METHODS
                or not (path + "/").startswith(self.prefix)):
            await self.app(scope, receive, send)
            return

        limit = self.limits.get(path, self.default_limit)
        declared, malformed = self._declared_length(scope)
        if malformed:
            await self._reject(send, 400, "Invalid Content-Length header")
            return
        if declared is not None and declared > limit:
            await self._reject(send, 413, f"Request body is larger than the {_mb(limit)} MB limit for this endpoint")
            return

        reserve = limit if declared is None else declared
        # No await between this check and the increments below: race-free on the single event loop.
        if self.inflight >= self.max_inflight or self.inflight_bytes + reserve > self.max_inflight_bytes:
            await self._reject(send, 503, "The server is busy receiving other uploads; please retry in a few seconds",
                               [(b"retry-after", str(self.retry_after).encode("ascii"))])
            return

        self.inflight += 1
        self.inflight_bytes += reserve
        state = _RequestState()

        async def counting_receive() -> Message:
            if state.exceeded:
                raise self._too_large(limit)
            message = await receive()
            if message["type"] == "http.request":
                state.received += len(message.get("body", b"") or b"")
                if state.received > limit:
                    state.exceeded = True
                    raise self._too_large(limit)
            return message

        async def guarded_send(message: Message) -> None:
            if state.exceeded and message["type"] == "http.response.start":
                # Cut-off upload: tell the server to close the connection instead of draining the remaining body.
                headers = [(k, v) for k, v in message.get("headers", ()) if k.lower() != b"connection"]
                message = {**message, "headers": headers + [(b"connection", b"close")]}
            await send(message)

        try:
            await self.app(scope, counting_receive, guarded_send)
        finally:                                    # also on exceptions and on cancellation (client gone)
            self.inflight -= 1
            self.inflight_bytes -= reserve
