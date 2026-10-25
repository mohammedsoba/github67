"""P1.3 - rate limiter (pure unit tests, no models, no FastAPI needed)."""
from __future__ import annotations

from backend.app.limits import TokenBucket


class Clock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


def test_bucket_allows_burst_then_blocks_with_retry_after():
    clock = Clock()
    b = TokenBucket(30, clock=clock)
    assert all(b.allow("a")[0] for _ in range(30))
    ok, wait = b.allow("a")
    assert not ok and 1.9 <= wait <= 2.1            # 30/min = one token per 2 s
    assert b.allow("other")[0]                      # clients are independent


def test_bucket_refills_over_time():
    clock = Clock()
    b = TokenBucket(30, clock=clock)
    for _ in range(30):
        b.allow("a")
    assert not b.allow("a")[0]
    clock.t += 2.0
    assert b.allow("a")[0]
    assert not b.allow("a")[0]
    clock.t += 3600                                  # long idle never banks more than the capacity
    assert sum(b.allow("a")[0] for _ in range(40)) == 30


def test_zero_disables_the_limiter():
    b = TokenBucket(0)
    assert all(b.allow("a")[0] for _ in range(1000)) and len(b) == 0


def test_forwarded_header_only_trusted_when_enabled_and_uses_rightmost_hop():
    headers = {"x-forwarded-for": "6.6.6.6, 203.0.113.9"}   # left entry is attacker-supplied
    assert TokenBucket(5, trust_proxy=False).client_key(headers, "10.0.0.1") == "10.0.0.1"
    assert TokenBucket(5, trust_proxy=True).client_key(headers, "10.0.0.1") == "203.0.113.9"
    assert TokenBucket(5, trust_proxy=True).client_key({}, "10.0.0.1") == "10.0.0.1"
    assert TokenBucket(5).client_key({}, None) == "unknown"


def test_memory_is_bounded_stale_pruned_and_hard_capped():
    clock = Clock()
    b = TokenBucket(30, clock=clock, max_clients=100)
    for i in range(100):
        b.allow(f"old{i}")
    clock.t += 121                                   # all stale
    b.allow("new")
    assert len(b) == 1
    for i in range(500):                             # address rotation inside the 120 s window
        b.allow(f"x{i}")
    assert len(b) <= 100


# --- V30: TRUSTED_PROXY_HOPS + IPv6 /64 keying --------------------------------------------------------------------------
import importlib

from backend.app import security


class _Headers:
    """Minimal stand-in for starlette.datastructures.Headers (get + getlist, case-insensitive)."""
    def __init__(self, *pairs):
        self._pairs = [(k.lower(), v) for k, v in pairs]

    def get(self, name, default=None):
        for k, v in self._pairs:
            if k == name.lower():
                return v
        return default

    def getlist(self, name):
        return [v for k, v in self._pairs if k == name.lower()]


def test_hops_pick_the_nth_entry_from_the_right():
    h = {"x-forwarded-for": "6.6.6.6, 203.0.113.9, 198.51.100.7"}
    assert TokenBucket(5, trusted_hops=1).client_key(h, "10.0.0.1") == "198.51.100.7"
    assert TokenBucket(5, trusted_hops=2).client_key(h, "10.0.0.1") == "203.0.113.9"
    assert TokenBucket(5, trusted_hops=3).client_key(h, "10.0.0.1") == "6.6.6.6"
    assert TokenBucket(5, trusted_hops=4).client_key(h, "10.0.0.1") == "10.0.0.1"      # header shorter than the chain
    assert TokenBucket(5, trusted_hops=0).client_key(h, "10.0.0.1") == "10.0.0.1"      # never trusted
    assert TokenBucket(5, trusted_hops=0, trust_proxy=True).trust_proxy is False       # explicit hops win
    assert TokenBucket(5, trust_proxy=True).trusted_hops == 1                          # legacy flag == one hop


def test_forged_left_entries_cannot_change_the_key():
    real = "203.0.113.9"
    keys = {TokenBucket(5, trusted_hops=1).client_key({"x-forwarded-for": f"1.1.1.{i}, {real}"}, "10.0.0.1")
            for i in range(50)}
    assert keys == {real}


def test_repeated_header_lines_are_one_chain():
    h = _Headers(("X-Forwarded-For", "6.6.6.6"), ("X-Forwarded-For", "203.0.113.9"))
    assert TokenBucket(5, trusted_hops=1).client_key(h, "10.0.0.1") == "203.0.113.9"   # not the forged first line


def test_unusable_forwarded_value_falls_back_to_the_peer():
    b = TokenBucket(5, trusted_hops=1)
    assert b.client_key({"x-forwarded-for": "garbage"}, "10.0.0.1") == "10.0.0.1"
    assert b.client_key({"x-forwarded-for": ""}, "10.0.0.1") == "10.0.0.1"
    assert b.client_key({"x-forwarded-for": "9" * 500}, None) == "unknown"


def test_ipv6_clients_share_one_bucket_per_64():
    b = TokenBucket(5, trusted_hops=1)
    k1 = b.client_key({"x-forwarded-for": "2001:db8:1:2:aaaa:bbbb:cccc:dddd"}, "10.0.0.1")
    k2 = b.client_key({"x-forwarded-for": "2001:db8:1:2::1"}, "10.0.0.1")
    k3 = b.client_key({"x-forwarded-for": "2001:db8:1:3::1"}, "10.0.0.1")              # next /64 = different client
    assert k1 == k2 == "2001:db8:1:2::/64" and k3 == "2001:db8:1:3::/64"


def test_rotating_ipv6_addresses_cannot_dodge_the_limit():
    clock = Clock()
    b = TokenBucket(5, trusted_hops=1, clock=clock)
    allowed = sum(b.allow(b.client_key({"x-forwarded-for": f"2001:db8:9:9::{i:x}"}, "10.0.0.1"))[0] for i in range(1, 200))
    assert allowed == 5 and len(b) == 1


def test_ipv6_peer_is_keyed_by_64_even_without_a_proxy():
    b = TokenBucket(5)
    assert b.client_key({}, "2001:db8:5:5:1:2:3:4") == "2001:db8:5:5::/64"


def test_address_forms_are_normalised():
    assert security.rate_limit_key("203.0.113.9:5555") == "203.0.113.9"
    assert security.rate_limit_key("[2001:db8::1]:443") == "2001:db8::/64"
    assert security.rate_limit_key('"2001:db8::1"') == "2001:db8::/64"
    assert security.rate_limit_key("fe80::1%eth0") == "fe80::/64"
    assert security.rate_limit_key("::ffff:203.0.113.9") == "203.0.113.9"               # dual-stack socket == IPv4 header
    assert security.rate_limit_key("2001:DB8::1") == security.rate_limit_key("2001:db8:0:0:0:0:0:2")
    assert security.rate_limit_key("not-an-ip") is None and security.rate_limit_key(None) is None


def test_config_derives_hops_from_env(monkeypatch):
    from backend.app import config
    try:
        for env, expected in [({"TRUST_PROXY": "1"}, 1), ({}, 0), ({"TRUSTED_PROXY_HOPS": "2"}, 2),
                              ({"TRUSTED_PROXY_HOPS": "2", "TRUST_PROXY": "1"}, 2), ({"TRUSTED_PROXY_HOPS": "0", "TRUST_PROXY": "1"}, 0),
                              ({"TRUSTED_PROXY_HOPS": "999"}, 10), ({"TRUSTED_PROXY_HOPS": "abc"}, 0)]:
            monkeypatch.delenv("TRUST_PROXY", raising=False)
            monkeypatch.delenv("TRUSTED_PROXY_HOPS", raising=False)
            for k, v in env.items():
                monkeypatch.setenv(k, v)
            importlib.reload(config)
            assert config.TRUSTED_PROXY_HOPS == expected, env
            assert config.TRUST_PROXY is (expected > 0)
    finally:
        monkeypatch.undo()
        importlib.reload(config)
