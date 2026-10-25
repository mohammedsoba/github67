"""Pure helpers for the production hardening (no FastAPI import, so they are unit-testable in isolation)."""

from __future__ import annotations

import ipaddress
from typing import Iterable

# Request headers a cross-origin page may send. The frontend only sends multipart/form-data (Content-Type is set
# by the browser) - nothing else needs to be allowed, so the old wildcard is gone.
CORS_ALLOW_HEADERS = ["Accept", "Accept-Language", "Content-Type", "X-Requested-With"]
CORS_ALLOW_METHODS = ["GET", "POST", "OPTIONS"]

# JSON / image API answers never need to load anything: lock them down completely.
API_CSP = "default-src 'none'; frame-ancestors 'none'"
# The page (and its static assets) keep the page-level CSP of index.html (<meta>, which also lists connect-src for the
# packaged build). A <meta> CSP cannot express frame-ancestors, so the HTTP header adds the directives the meta
# cannot carry. Both policies apply (their intersection), so this never loosens the meta policy.
PAGE_CSP = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'"



# Client-facing text when a model cannot be loaded. The raw reason (an exception message that can contain absolute
# filesystem paths, e.g. "model not found: /srv/app/backend/models/...") is written to the server log only.
PORTRAIT_UNAVAILABLE_MESSAGE = "Portrait background model failed to load"


def public_model_error(production: bool, message: str, reason: str | None = None) -> str:
    """Body text for a 503 caused by a model that is not loaded.

    Production: ALWAYS the generic ``message`` - never the reason (it may hold paths or raw exception text).
    Development: ``message (reason)`` so a developer sees what went wrong without opening the log.
    """
    if production or not reason:
        return message
    return f"{message} ({reason})"


PROBE_PATHS = frozenset({"/health", "/livez", "/readyz"})


def is_api_path(path: str) -> bool:
    return path in PROBE_PATHS or path.startswith("/api/")


def security_headers(path: str, production: bool, https: bool = False) -> dict[str, str]:
    """Headers to stamp on a response.

    ``X-Content-Type-Options`` is harmless everywhere and always sent. The rest (CSP incl. ``frame-ancestors``,
    legacy ``X-Frame-Options``, ``Referrer-Policy``, and HSTS on HTTPS requests) are production-profile only so a
    local dev server can still be embedded / inspected freely.
    """
    headers = {"X-Content-Type-Options": "nosniff"}
    if not production:
        return headers
    headers["Content-Security-Policy"] = API_CSP if is_api_path(path) else PAGE_CSP
    headers["X-Frame-Options"] = "DENY"
    headers["Referrer-Policy"] = "no-referrer"
    if https:
        headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return headers


def health_payload(production: bool, *, model_loaded: bool, portrait_loaded: bool, detailed) -> dict:
    """/health body. ``status`` is ``ok`` only when BOTH required models are loaded. Production: three booleans/status only - no paths, providers, error text or versions.
    ``detailed`` is a zero-argument callable so the expensive/leaky diagnostics are never even computed in production."""
    body: dict[str, object] = {"status": "ok" if (model_loaded and portrait_loaded) else "degraded", "model_loaded": model_loaded,
                               "portrait_model_loaded": portrait_loaded}
    if not production:
        body.update(detailed())
    return body


# --- Client identity for rate limiting ------------------------------------------------------------------------------------
# An IPv6 customer normally owns a whole /64 (often a /56 or /48) and can source traffic from any address in it, so keying
# the limiter on the full 128-bit address would give one client ~2**64 free buckets. IPv4 stays per-address.
IPV6_RATE_LIMIT_PREFIX = 64
MAX_TRUSTED_PROXY_HOPS = 10          # sanity cap for the TRUSTED_PROXY_HOPS setting
_MAX_IP_TEXT = 64                    # longer than any textual IP (+ port / zone): garbage, never parsed


def parse_ip(raw: object) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """Parse one address as it appears in X-Forwarded-For / a socket peer, or ``None`` when it is not an IP.

    Accepts ``1.2.3.4``, ``1.2.3.4:5678``, ``2001:db8::1``, ``[2001:db8::1]:443``, quoted forms and a zone id
    (``fe80::1%eth0``). An IPv4-mapped IPv6 address (``::ffff:1.2.3.4``) is returned as the IPv4 address it stands
    for, so a dual-stack socket and an IPv4 header value map to the same client.
    """
    if not isinstance(raw, str):
        return None
    text = raw.strip().strip('"').strip()
    if not text or len(text) > _MAX_IP_TEXT:
        return None
    if text.startswith("["):                                   # [v6] or [v6]:port
        end = text.find("]")
        if end == -1:
            return None
        text = text[1:end]
    elif text.count(":") == 1:                                 # v4:port (a bare v6 has 2+ colons)
        text = text.split(":", 1)[0]
    text = text.split("%", 1)[0]                               # zone id
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        return ip.ipv4_mapped
    return ip


def rate_limit_key(raw: object) -> str | None:
    """Limiter bucket key for one address: IPv4 -> the address, IPv6 -> its /64 network (``2001:db8:1:2::/64``).
    ``None`` when ``raw`` is not an IP address."""
    ip = parse_ip(raw)
    if ip is None:
        return None
    if isinstance(ip, ipaddress.IPv6Address):
        return str(ipaddress.IPv6Network((ip, IPV6_RATE_LIMIT_PREFIX), strict=False))
    return str(ip)


def forwarded_chain(values: Iterable[str] | str | None) -> list[str]:
    """Flatten one or several ``X-Forwarded-For`` header lines into the ordered list of hop entries (left = oldest).
    Repeated header lines are equivalent to one comma-joined line (RFC 9110 5.3); empty entries are dropped."""
    if values is None:
        return []
    if isinstance(values, str):
        values = [values]
    return [part.strip() for line in values for part in line.split(",") if part.strip()]


def client_ip_from_forwarded(values: Iterable[str] | str | None, trusted_hops: int) -> str | None:
    """The real client address out of ``X-Forwarded-For`` when exactly ``trusted_hops`` proxies of ours sit in front
    of the app, or ``None`` when it cannot be established (feature off, header absent / too short / not an IP).

    Every trusted proxy APPENDS the address it received the request from, so with N trusted proxies the entry N
    places from the RIGHT is the address our outermost proxy saw - the client. Everything left of it was supplied by
    the client (or an untrusted party) and is ignored, which is what makes the limit impossible to dodge by sending a
    forged header. ``trusted_hops=1`` is the plain "one reverse proxy" case (right-most entry).
    """
    if trusted_hops <= 0:
        return None
    chain = forwarded_chain(values)
    if len(chain) < trusted_hops:                              # fewer hops than expected: not our proxy chain
        return None
    return rate_limit_key(chain[-trusted_hops])


def client_rate_key(forwarded: Iterable[str] | str | None, peer: str | None, trusted_hops: int) -> str:
    """Final limiter key for a request: the forwarded client when it can be trusted, else the socket peer.
    Never raises; an unparsable peer is kept verbatim (it is a server-side value, not attacker-controlled text),
    no peer at all -> ``"unknown"``."""
    key = client_ip_from_forwarded(forwarded, trusted_hops)
    if key is not None:
        return key
    return rate_limit_key(peer) or peer or "unknown"
