"""In-memory per-client rate limiting for the public API.

One process, one dict: no Redis, no extra dependency. Behind several workers each worker keeps its own
buckets (the effective limit is then RATE_LIMIT_PER_MIN x workers) - good enough to stop a single client
from monopolising the CPU-bound endpoints, which is the goal here.
"""

from __future__ import annotations

import logging
import math
import time
from collections import OrderedDict
from typing import Callable

from backend.app.config import RATE_LIMIT_PER_MIN, TRUST_PROXY, TRUSTED_PROXY_HOPS
from backend.app.security import MAX_TRUSTED_PROXY_HOPS, client_ip_from_forwarded, client_rate_key

logger = logging.getLogger("yofilter")

MAX_TRACKED_CLIENTS = 10_000     # prune when the table grows past this
STALE_AFTER_S = 120.0            # ... dropping clients not seen for this long


class TokenBucket:
    """Classic token bucket per client key: capacity == ``per_minute`` tokens, refilled continuously."""

    def __init__(self, per_minute: int, *, trust_proxy: bool = False, trusted_hops: int | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 max_clients: int = MAX_TRACKED_CLIENTS, stale_after: float = STALE_AFTER_S) -> None:
        self.per_minute = int(per_minute)
        # Number of reverse proxies of ours in front of the app. ``trusted_hops`` (TRUSTED_PROXY_HOPS) is authoritative
        # when given; the legacy ``trust_proxy=True`` flag means exactly one hop. 0 = never believe X-Forwarded-For.
        hops = (1 if trust_proxy else 0) if trusted_hops is None else int(trusted_hops)
        self.trusted_hops = max(0, min(hops, MAX_TRUSTED_PROXY_HOPS))
        self.trust_proxy = self.trusted_hops > 0
        self._warned_fallback = False
        self._clock = clock
        self._max_clients = max_clients
        self._stale_after = stale_after
        self._rate = self.per_minute / 60.0                       # tokens per second
        self._state: OrderedDict[str, list[float]] = OrderedDict()   # key -> [tokens, last_seen]; oldest first

    @property
    def enabled(self) -> bool:
        return self.per_minute > 0

    def __len__(self) -> int:
        return len(self._state)

    def client_key(self, headers, peer: str | None) -> str:
        """Bucket key of the requesting client.

        * No trusted proxy configured: the socket peer. X-Forwarded-For is ignored (anyone can forge it).
        * ``trusted_hops`` = N: the X-Forwarded-For entry N places from the RIGHT - the address our own outermost proxy
          saw. Entries to its left are client-supplied and ignored. If the header is missing / shorter than N / not an
          IP, the socket peer is used (a shared bucket for everyone behind that proxy rather than a spoofable one).
        * IPv6 clients are keyed by their /64 network, IPv4 clients by address, so rotating addresses inside one IPv6
          allocation cannot mint fresh buckets.
        """
        if not self.trust_proxy:
            return client_rate_key(None, peer, 0)
        lines = _header_lines(headers, "x-forwarded-for")
        if client_ip_from_forwarded(lines, self.trusted_hops) is None and not self._warned_fallback:
            self._warned_fallback = True                      # once per process: misconfigured hops / missing header
            logger.warning("Rate limiter: TRUSTED_PROXY_HOPS=%d but X-Forwarded-For has no usable client address; "
                           "falling back to the socket peer (all clients share one bucket). Check the hop count.",
                           self.trusted_hops)
        return client_rate_key(lines, peer, self.trusted_hops)

    def allow(self, key: str) -> tuple[bool, float]:
        """Take one token. Returns (allowed, seconds_until_a_token_is_available)."""
        if not self.enabled:
            return True, 0.0
        now = self._clock()
        entry = self._state.get(key)
        if entry is None:
            if len(self._state) >= self._max_clients:
                self._prune(now)
            tokens = float(self.per_minute)
        else:
            tokens = min(float(self.per_minute), entry[0] + (now - entry[1]) * self._rate)
        if tokens >= 1.0:
            self._state[key] = [tokens - 1.0, now]
            allowed, wait = True, 0.0
        else:
            self._state[key] = [tokens, now]
            allowed, wait = False, (1.0 - tokens) / self._rate
        self._state.move_to_end(key)                              # keeps the dict ordered by last use
        return allowed, wait

    def _prune(self, now: float) -> None:
        """Bound memory: drop clients idle for > 120 s; if an attacker is rotating addresses faster than
        that, evict the least-recently-used ones so the table can never exceed its cap."""
        while self._state:
            oldest_key, (_, seen) = next(iter(self._state.items()))
            if now - seen > self._stale_after:
                del self._state[oldest_key]
            else:
                break
        while len(self._state) >= self._max_clients:
            self._state.popitem(last=False)


def _header_lines(headers, name: str) -> list[str]:
    """Every line of a (possibly repeated) request header. Starlette's ``Headers.get`` returns only the FIRST line, which
    would let a client park a forged value in front of the one our proxy appended; ``getlist`` returns them all."""
    getlist = getattr(headers, "getlist", None)
    if getlist is not None:
        return list(getlist(name))
    value = headers.get(name, "")
    return [value] if value else []


limiter = TokenBucket(RATE_LIMIT_PER_MIN, trust_proxy=TRUST_PROXY, trusted_hops=TRUSTED_PROXY_HOPS)


async def rate_limit(request, call_next):
    """HTTP middleware: POSTs under /api/ cost one token; out of tokens -> 429 + Retry-After.
    Registered inside CORSMiddleware, so the 429 carries the proper CORS headers."""
    if request.method == "POST" and request.url.path.startswith("/api/") and limiter.enabled:
        peer = request.client.host if request.client else None
        allowed, wait = limiter.allow(limiter.client_key(request.headers, peer))
        if not allowed:
            from starlette.responses import JSONResponse     # lazy: keeps TokenBucket importable standalone
            retry_after = max(1, math.ceil(wait))
            return JSONResponse(
                status_code=429,
                content={"detail": f"Too many requests; try again in {retry_after}s."},
                headers={"Retry-After": str(retry_after)},
            )
    return await call_next(request)
