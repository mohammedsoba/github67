"""Transparent gzip / Brotli compression of the static front end (pure ASGI: no Starlette import, so it is unit-testable alone).

Why not ``starlette.middleware.gzip.GZipMiddleware``?
    * It compresses any content type above the size threshold (event streams aside), at zlib level 9 by default - including the
      ``image/png`` answer of ``/api/erase`` (7-36 MB, already deflated: ~0 % gain for seconds of CPU on the one core the AI jobs
      also need), PNG / WOFF2 assets and the 16 MB ``.tflite`` model (7 % gain for ~0.5 s of CPU per download, measured).
    * It has no Brotli and no allow-list / path exclusion, and it leaves the strong ETag and ``Accept-Ranges`` of the identity file
      on the compressed bytes.

What this middleware does instead
    * Compresses only an ALLOW-LIST of text-like types (HTML, CSS, JS / MJS, JSON, SVG, ``application/wasm``, ...), never ``/api/``.
    * Picks ``br`` or ``gzip`` from ``Accept-Encoding`` (q-values honoured, ``br`` preferred; Brotli is optional: without the
      ``brotli`` wheel the server runs gzip-only instead of failing to boot).
    * STREAMS: the body is compressed chunk by chunk, so a 9 MB ``.wasm`` is never held in memory a second time.
    * Only touches ``200`` responses that are not already encoded (206 / 304 / errors / HEAD pass through untouched).
    * Keeps the response correct for caches: ``Vary: Accept-Encoding``, strong ETag -> weak (``W/"..."``), no ``Content-Length`` /
      ``Accept-Ranges`` on the compressed representation.

Placement: it is the OUTERMOST middleware (see main.py), so it compresses the final bytes after CORS and the security headers.
"""

from __future__ import annotations

import zlib
from typing import Any, Awaitable, Callable, Iterable, Mapping, Protocol

try:  # Optional: a missing wheel degrades to gzip-only (logged at start-up), it never breaks the import / the boot.
    import brotli
except ImportError:  # pragma: no cover - the tests exercise the no-Brotli path through the ``encoders=`` seam
    brotli = None  # type: ignore[assignment]

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
HeaderList = list[tuple[bytes, bytes]]

# --- What is worth compressing ---------------------------------------------------------------------------------------------
# Allow-list, not block-list: an unknown type (a future binary format) is left alone instead of burning CPU on it.
COMPRESSIBLE_TYPES = frozenset({
    "application/javascript", "application/json", "application/ld+json", "application/manifest+json", "application/wasm",
    "application/xml", "image/svg+xml", "image/x-icon", "image/vnd.microsoft.icon",
})
COMPRESSIBLE_PREFIXES = ("text/",)
COMPRESSIBLE_SUFFIXES = ("+json", "+xml")
NEVER_COMPRESS = frozenset({"text/event-stream"})        # a stream must reach the client chunk by chunk, not when a zlib block fills
DEFAULT_SKIP_PREFIXES = ("/api/",)                       # the AI endpoints answer PNGs (and small JSON errors): never worth touching
_MAX_ACCEPT_ENCODING_PARTS = 16                          # a legitimate header has 3-6; anything longer is garbage


def is_compressible(media_type: str) -> bool:
    """``True`` for a (lower-case, parameter-free) media type that benefits from gzip / Brotli."""
    if media_type in NEVER_COMPRESS:
        return False
    return (media_type in COMPRESSIBLE_TYPES or media_type.startswith(COMPRESSIBLE_PREFIXES)
            or media_type.endswith(COMPRESSIBLE_SUFFIXES))


# --- Content negotiation (RFC 9110 12.5.3) -----------------------------------------------------------------------------------
def parse_accept_encoding(value: str) -> dict[str, float]:
    """``"br;q=0.8, gzip, *;q=0"`` -> ``{"br": 0.8, "gzip": 1.0, "*": 0.0}``. A malformed q-value counts as 0 (= not acceptable)."""
    weights: dict[str, float] = {}
    for part in value.split(",")[:_MAX_ACCEPT_ENCODING_PARTS]:
        token, _, params = part.partition(";")
        token = token.strip().lower()
        if not token:
            continue
        weight = 1.0
        for param in params.split(";"):
            name, _, raw = param.partition("=")
            if name.strip().lower() == "q":
                try:
                    weight = float(raw.strip())
                except ValueError:
                    weight = 0.0
        weights[token] = weight if 0.0 <= weight <= 1.0 else 0.0     # also rejects NaN / inf / negatives
    return weights


def negotiate(accept_encoding: str | None, supported: Iterable[str]) -> str | None:
    """The best encoding of ``supported`` (server preference order breaks ties) the client accepts, or ``None`` = send identity."""
    if not accept_encoding:
        return None
    weights = parse_accept_encoding(accept_encoding)
    best: str | None = None
    best_weight = 0.0
    for name in supported:
        weight = weights.get(name, weights.get("*", 0.0))
        if weight > best_weight:
            best, best_weight = name, weight
    return best


# --- Encoders (streaming) --------------------------------------------------------------------------------------------------
class Encoder(Protocol):
    def compress(self, data: bytes) -> bytes: ...
    def finish(self) -> bytes: ...


class _GzipEncoder:
    """RFC 1952 gzip stream (zlib wbits 31)."""
    __slots__ = ("_z",)

    def __init__(self, level: int) -> None:
        self._z = zlib.compressobj(level, zlib.DEFLATED, 31)

    def compress(self, data: bytes) -> bytes:
        return self._z.compress(data)

    def finish(self) -> bytes:
        return self._z.flush()


class _BrotliEncoder:
    __slots__ = ("_c",)

    def __init__(self, quality: int) -> None:
        self._c = brotli.Compressor(quality=quality, lgwin=22)

    def compress(self, data: bytes) -> bytes:
        return self._c.process(data)

    def finish(self) -> bytes:
        return self._c.finish()


def build_encoders(gzip_level: int = 5, brotli_quality: int = 4) -> dict[str, Callable[[], Encoder]]:
    """``{"br": factory, "gzip": factory}`` in SERVER PREFERENCE order (``br`` only when the ``brotli`` wheel is installed)."""
    gzip_level = max(1, min(9, int(gzip_level)))
    brotli_quality = max(0, min(11, int(brotli_quality)))
    encoders: dict[str, Callable[[], Encoder]] = {}
    if brotli is not None:
        encoders["br"] = lambda: _BrotliEncoder(brotli_quality)
    encoders["gzip"] = lambda: _GzipEncoder(gzip_level)
    return encoders


# --- Header helpers (raw ASGI headers: list of (name, value) bytes pairs; names are matched case-insensitively) --------------------
def _first(headers: Iterable[tuple[bytes, bytes]], name: bytes) -> bytes | None:
    for key, value in headers:
        if key.lower() == name:
            return value
    return None


def _media_type(headers: HeaderList) -> str | None:
    value = _first(headers, b"content-type")
    return None if value is None else value.split(b";", 1)[0].strip().lower().decode("latin-1")


def _with_vary(headers: HeaderList) -> HeaderList:
    """Add ``Vary: Accept-Encoding`` unless a Vary header already covers it (a separate header line is legal and keeps CORS's ``Vary: Origin``)."""
    for key, value in headers:
        if key.lower() == b"vary":
            tokens = {token.strip().lower() for token in value.split(b",")}
            if b"*" in tokens or b"accept-encoding" in tokens:
                return headers
    return [*headers, (b"vary", b"Accept-Encoding")]


def _as_compressed(headers: HeaderList, encoding: str) -> HeaderList:
    """Headers of the compressed representation: no length / ranges (they described the identity bytes), weak ETag, Content-Encoding."""
    out: HeaderList = []
    for key, value in headers:
        lowered = key.lower()
        if lowered in (b"content-length", b"accept-ranges"):
            continue
        if lowered == b"etag" and not value.startswith(b"W/"):
            value = b"W/" + value                                   # different bytes than the strong validator promised
        out.append((key, value))
    out.append((b"content-encoding", encoding.encode("ascii")))
    return out


def _content_length(headers: HeaderList) -> int | None:
    raw = _first(headers, b"content-length")
    try:
        return int(raw) if raw is not None else None
    except ValueError:
        return None


# --- The middleware ------------------------------------------------------------------------------------------------------------
class CompressionMiddleware:
    """Pure ASGI middleware, see the module docstring. ``encoders`` is a test seam (name -> factory, in preference order)."""

    def __init__(
        self,
        app: Callable[[Scope, Receive, Send], Awaitable[None]],
        *,
        minimum_size: int = 1024,
        gzip_level: int = 5,
        brotli_quality: int = 4,
        skip_prefixes: tuple[str, ...] = DEFAULT_SKIP_PREFIXES,
        encoders: Mapping[str, Callable[[], Encoder]] | None = None,
    ) -> None:
        self.app = app
        self.minimum_size = max(0, int(minimum_size))
        self.skip_prefixes = tuple(skip_prefixes)
        self.encoders = dict(encoders) if encoders is not None else build_encoders(gzip_level, brotli_quality)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if (scope["type"] != "http" or scope.get("method") == "HEAD" or not self.encoders
                or str(scope.get("path", "")).startswith(self.skip_prefixes)):
            await self.app(scope, receive, send)
            return
        accept = _first(scope.get("headers", ()), b"accept-encoding")
        encoding = negotiate(accept.decode("latin-1") if accept else None, self.encoders)
        if encoding is not None:
            # A server that supports the pathsend extension lets FileResponse hand the file to the OS: the bytes would then never
            # pass through this middleware and compression would silently stop working after a server upgrade. Do not advertise it.
            extensions = {k: v for k, v in (scope.get("extensions") or {}).items()
                          if k not in ("http.response.pathsend", "http.response.zerocopysend")}
            scope = {**scope, "extensions": extensions}
        # Even when this client gets identity, the response is wrapped: eligible responses must still say ``Vary: Accept-Encoding``,
        # otherwise a shared cache could hand a gzip body to a client that cannot decode it.
        await self.app(scope, receive, _Responder(self, send, encoding))


class _Responder:
    """The ``send`` callable the application sees. Holds the response start until the first body message (so the decision to
    compress can look at the size), then either forwards untouched or compresses chunk by chunk.

    Modes: ``idle`` (nothing yet) -> ``buffered`` (start held) -> ``passthrough`` | ``compress``.
    If the application fails before its first body message, nothing was sent, so Starlette can still answer a clean 500."""

    __slots__ = ("_mw", "_send", "_encoding", "_mode", "_start", "_encoder")

    def __init__(self, middleware: CompressionMiddleware, send: Send, encoding: str | None) -> None:
        self._mw, self._send, self._encoding = middleware, send, encoding
        self._mode = "idle"
        self._start: Message | None = None
        self._encoder: Encoder | None = None

    async def __call__(self, message: Message) -> None:
        kind = message["type"]
        if self._mode == "passthrough":
            await self._send(message)
        elif self._mode == "compress":
            await self._send_compressed(message)
        elif kind == "http.response.start" and self._mode == "idle":
            self._start, self._mode = message, "buffered"
        elif self._mode == "buffered" and kind == "http.response.body":
            await self._decide(message)
        elif self._mode == "buffered":
            # Anything else (pathsend, trailers, ...) before a body: release the held start untouched and get out of the way.
            self._mode = "passthrough"
            await self._send(self._start)  # type: ignore[arg-type]
            await self._send(message)
        else:
            await self._send(message)                   # 1xx informational responses etc.

    async def _decide(self, first_body: Message) -> None:
        start = self._start
        assert start is not None
        headers: HeaderList = [(bytes(k), bytes(v)) for k, v in start.get("headers", ())]
        media_type = _media_type(headers)
        no_transform = b"no-transform" in (_first(headers, b"cache-control") or b"").lower()
        eligible = (start["status"] == 200 and media_type is not None and is_compressible(media_type)
                    and _first(headers, b"content-encoding") is None and not no_transform)
        if not eligible:
            await self._release_untouched(start, headers, first_body)
            return
        headers = _with_vary(headers)
        body = first_body.get("body", b"") or b""
        more = bool(first_body.get("more_body", False))
        length = _content_length(headers)
        too_small = (length < self._mw.minimum_size) if length is not None else (not more and len(body) < self._mw.minimum_size)
        if self._encoding is None or too_small:
            await self._release_untouched(start, headers, first_body)
            return
        self._encoder = self._mw.encoders[self._encoding]()
        self._mode = "compress"
        await self._send({**start, "headers": _as_compressed(headers, self._encoding)})
        await self._send_compressed(first_body)

    async def _release_untouched(self, start: Message, headers: HeaderList, first_body: Message) -> None:
        self._mode = "passthrough"
        await self._send({**start, "headers": headers})
        await self._send(first_body)

    async def _send_compressed(self, message: Message) -> None:
        if message["type"] != "http.response.body":
            await self._send(message)
            return
        encoder = self._encoder
        assert encoder is not None
        more = bool(message.get("more_body", False))
        out = encoder.compress(message.get("body", b"") or b"")
        if not more:
            out += encoder.finish()
            self._encoder = None
        if out or not more:                             # an empty intermediate chunk carries nothing; the final message is always sent
            await self._send({"type": "http.response.body", "body": out, "more_body": more})
