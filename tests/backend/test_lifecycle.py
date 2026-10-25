"""Probe split (/livez vs /readyz), /health 503, and the non-blocking background model start-up."""
from __future__ import annotations

import asyncio
import json
import threading
from types import SimpleNamespace

from backend.app import lifecycle
from backend.app.lifecycle import (EXIT_CODE_MODEL_LOAD_FAILURE, evaluate_readiness, health_http_status, liveness_body,
                                   missing_models, readiness_body)


# ------------------------------------------------------------------------------------------------ pure state machine
def test_readiness_state_order():
    ev = lambda **kw: evaluate_readiness(**{"boot_finished": True, "lama_loaded": True, "portrait_loaded": True, **kw})
    assert ev(boot_finished=False).status == "starting"
    assert ev(boot_finished=False, lama_loaded=False, portrait_loaded=False).status == "starting"
    assert ev(lama_loaded=False).status == "unavailable"
    assert ev(portrait_loaded=False).status == "unavailable"
    assert ev(warmup_pending=True).status == "warming_up"
    assert ev(lama_loaded=False, warmup_pending=True).status == "unavailable"        # a missing model wins over warm-up
    ready = ev()
    assert ready.status == "ready" and ready.ready and ready.http_status == 200
    assert all(ev(**kw).http_status == 503 for kw in ({"boot_finished": False}, {"lama_loaded": False}, {"warmup_pending": True}))


def test_health_status_code_needs_every_required_model():
    assert health_http_status(True, True) == 200
    assert health_http_status(True, False) == 503 and health_http_status(False, True) == 503 and health_http_status(False, False) == 503


def test_probe_bodies_leak_nothing_in_production():
    assert liveness_body() == {"status": "alive"}
    r = evaluate_readiness(boot_finished=True, lama_loaded=True, portrait_loaded=False)

    def boom():
        raise AssertionError("diagnostics must not be evaluated in production")
    assert readiness_body(r, True, boom) == {"status": "unavailable", "ready": False, "model_loaded": True, "portrait_model_loaded": False}
    assert readiness_body(r, False, lambda: {"model_path": "/x"})["model_path"] == "/x"


# ------------------------------------------------------------------------------------------------ app level (helpers)
_KEYS = ("inpainter", "portrait", "portrait_error", "boot_finished", "warmup_pending", "ai_slots", "erase_slots", "portrait_slots",
         "erase_waiting", "portrait_waiting", "portrait_load_lock")


def _request(app, path: str):
    from starlette.requests import Request
    return Request({"type": "http", "app": app, "method": "GET", "path": path, "headers": [], "query_string": b""})


async def _probe(main, path: str) -> tuple[int, dict, dict]:
    request = _request(main.app, path)
    endpoint = {"/livez": lambda: main.livez(), "/readyz": lambda: main.readyz(request), "/health": lambda: main.health(request)}[path]
    response = await endpoint()
    return response.status_code, json.loads(response.body), dict(response.headers)


class _Saved:
    def __init__(self, state):
        self.state, self.saved = state, {k: getattr(state, k, None) for k in _KEYS}

    def restore(self):
        for key, value in self.saved.items():
            setattr(self.state, key, value)


async def _wait_for(predicate, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        assert asyncio.get_running_loop().time() < deadline, "timed out"
        await asyncio.sleep(0.01)


def _fake_model():
    return SimpleNamespace(provider="CPUExecutionProvider", warmed_up=True, warm_up=lambda: 0.0)


# ------------------------------------------------------------------------------------------------ background start-up
def test_port_opens_before_models_load_and_readyz_follows(monkeypatch):
    from backend.app import main
    gate = threading.Event()

    def slow_ensure():
        gate.wait(10)
        return {}

    def fake_load_portrait(app):
        app.state.portrait = _fake_model()

    monkeypatch.setattr(main, "BLOCK_STARTUP_ON_MODELS", False)
    monkeypatch.setattr(main, "LAMA_WARMUP_PASSES", 0)
    monkeypatch.setattr(main, "ensure_models", slow_ensure)
    monkeypatch.setattr(main, "LamaInpainter", _fake_model)
    monkeypatch.setattr(main, "load_portrait", fake_load_portrait)
    saved = _Saved(main.app.state)

    async def go():
        async with main.lifespan(main.app):                 # entering the block == the server accepts connections
            assert main.app.state.boot_finished is False    # ... while the models are still loading
            assert (await _probe(main, "/livez"))[:2] == (200, {"status": "alive"})
            code, body, headers = await _probe(main, "/readyz")
            assert code == 503 and body["status"] == "starting" and headers["retry-after"] == "5"
            assert (await _probe(main, "/health"))[0] == 503
            gate.set()
            await _wait_for(lambda: main.app.state.boot_finished)
            code, body, _ = await _probe(main, "/readyz")
            assert (code, body["status"], body["ready"]) == (200, "ready", True)
            assert (await _probe(main, "/health"))[0] == 200

    try:
        asyncio.run(go())
    finally:
        gate.set()
        saved.restore()


def test_readyz_waits_for_the_warm_up_pass(monkeypatch):
    from backend.app import main
    release = threading.Event()
    model = _fake_model()
    model.warm_up = lambda: release.wait(10)

    monkeypatch.setattr(main, "BLOCK_STARTUP_ON_MODELS", False)
    monkeypatch.setattr(main, "LAMA_WARMUP_PASSES", 1)
    monkeypatch.setattr(main, "READY_WAITS_FOR_WARMUP", True)
    monkeypatch.setattr(main, "ensure_models", lambda: {})
    monkeypatch.setattr(main, "LamaInpainter", lambda: model)
    monkeypatch.setattr(main, "load_portrait", lambda app: setattr(app.state, "portrait", _fake_model()))
    saved = _Saved(main.app.state)

    async def go():
        async with main.lifespan(main.app):
            await _wait_for(lambda: main.app.state.boot_finished)
            code, body, _ = await _probe(main, "/readyz")
            assert (code, body["status"]) == (503, "warming_up")
            assert (await _probe(main, "/health"))[0] == 200            # models ARE loaded: /health only cares about that
            release.set()
            await _wait_for(lambda: not main.app.state.warmup_pending)
            assert (await _probe(main, "/readyz"))[0] == 200

    try:
        asyncio.run(go())
    finally:
        release.set()
        saved.restore()


def test_a_model_that_fails_to_load_keeps_readyz_and_health_at_503(monkeypatch):
    from backend.app import main

    def broken():
        raise RuntimeError("model file corrupt")

    monkeypatch.setattr(main, "BLOCK_STARTUP_ON_MODELS", False)
    monkeypatch.setattr(main, "LAMA_WARMUP_PASSES", 0)
    monkeypatch.setattr(main, "ensure_models", lambda: {})
    monkeypatch.setattr(main, "LamaInpainter", broken)
    monkeypatch.setattr(main, "load_portrait", lambda app: setattr(app.state, "portrait", _fake_model()))
    saved = _Saved(main.app.state)

    async def go():
        async with main.lifespan(main.app):
            await _wait_for(lambda: main.app.state.boot_finished)
            code, body, _ = await _probe(main, "/readyz")
            assert (code, body["status"], body["model_loaded"], body["portrait_model_loaded"]) == (503, "unavailable", False, True)
            code, body, _ = await _probe(main, "/health")
            assert code == 503 and body["status"] == "degraded"
            assert (await _probe(main, "/livez"))[0] == 200              # a missing model never makes the process "dead"

    try:
        asyncio.run(go())
    finally:
        saved.restore()


# ------------------------------------------------------------------------------------------------ exit on a failed model load
def test_missing_models_names_what_is_not_loaded():
    assert missing_models(lama_loaded=True, portrait_loaded=True) == []
    assert missing_models(lama_loaded=False, portrait_loaded=True) == ["LaMa eraser"]
    assert missing_models(lama_loaded=True, portrait_loaded=False) == ["portrait depth"]
    assert missing_models(lama_loaded=False, portrait_loaded=False) == ["LaMa eraser", "portrait depth"]
    assert EXIT_CODE_MODEL_LOAD_FAILURE == 1            # Railway's ON_FAILURE policy only restarts on a NON-zero status


def test_exit_process_raises_system_exit_with_the_code():
    import pytest
    from backend.app import main
    with pytest.raises(SystemExit) as raised:
        main._exit_process(1)
    assert raised.value.code == 1


def _boot_and_collect_exits(monkeypatch, *, exit_enabled: bool, lama, portrait_loads: bool) -> list[int]:
    from backend.app import main
    exits: list[int] = []
    monkeypatch.setattr(main, "BLOCK_STARTUP_ON_MODELS", False)
    monkeypatch.setattr(main, "LAMA_WARMUP_PASSES", 0)
    monkeypatch.setattr(main, "EXIT_ON_MODEL_LOAD_FAILURE", exit_enabled)
    monkeypatch.setattr(main, "_exit_process", exits.append)                 # observe instead of dying
    monkeypatch.setattr(main, "ensure_models", lambda: {})
    monkeypatch.setattr(main, "LamaInpainter", lama)
    monkeypatch.setattr(main, "load_portrait", lambda app: setattr(app.state, "portrait", _fake_model() if portrait_loads else None))
    saved = _Saved(main.app.state)

    async def go():
        async with main.lifespan(main.app):
            await _wait_for(lambda: main.app.state.boot_finished)

    try:
        asyncio.run(go())
    finally:
        saved.restore()
    return exits


def _broken():
    raise RuntimeError("model file corrupt")


def test_failed_model_load_exits_with_status_1_when_enabled(monkeypatch):
    assert _boot_and_collect_exits(monkeypatch, exit_enabled=True, lama=_broken, portrait_loads=True) == [1]


def test_failed_portrait_load_exits_with_status_1_when_enabled(monkeypatch):
    assert _boot_and_collect_exits(monkeypatch, exit_enabled=True, lama=_fake_model, portrait_loads=False) == [1]


def test_healthy_boot_never_exits(monkeypatch):
    assert _boot_and_collect_exits(monkeypatch, exit_enabled=True, lama=_fake_model, portrait_loads=True) == []


def test_failed_model_load_keeps_the_degraded_server_when_exit_is_disabled(monkeypatch):
    assert _boot_and_collect_exits(monkeypatch, exit_enabled=False, lama=_broken, portrait_loads=True) == []


def test_failed_warm_up_does_not_exit(monkeypatch):
    from backend.app import main
    model = _fake_model()

    def failing_warm_up():
        raise RuntimeError("warm-up blew up")
    model.warm_up = failing_warm_up
    monkeypatch.setattr(main, "LAMA_WARMUP_PASSES", 1)
    assert _boot_and_collect_exits(monkeypatch, exit_enabled=True, lama=lambda: model, portrait_loads=True) == []


# ------------------------------------------------------------------------------------------------ real app (models present)
def test_probes_on_the_real_app(client, monkeypatch):
    from backend.app import main
    monkeypatch.setattr(main, "IS_PRODUCTION", True)
    live = client.get("/livez")
    assert live.status_code == 200 and live.json() == {"status": "alive"} and live.headers["cache-control"] == "no-store"
    ready = client.get("/readyz")
    assert ready.status_code == 200 and ready.json() == {"status": "ready", "ready": True, "model_loaded": True, "portrait_model_loaded": True}
    assert "content-security-policy" in ready.headers and client.get("/health").status_code == 200


def test_health_and_readyz_turn_503_when_any_model_is_missing(client):
    state = client.app.state
    saved = (state.inpainter, state.portrait)
    try:
        state.portrait = None
        assert client.get("/health").status_code == 503 and client.get("/readyz").status_code == 503
        assert client.get("/livez").status_code == 200
        state.portrait, state.inpainter = saved[1], None
        assert client.get("/health").status_code == 503 and client.get("/readyz").status_code == 503
    finally:
        state.inpainter, state.portrait = saved


def test_api_calls_during_start_up_get_a_retryable_503(client):
    import io
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (16, 16)).save(buf, "PNG")
    png = buf.getvalue()
    state = client.app.state
    saved = (state.inpainter, state.portrait, state.boot_finished)
    state.inpainter = state.portrait = None
    state.boot_finished = False
    try:
        erase = client.post("/api/erase", files={"image": ("a.png", png, "image/png"), "mask": ("m.png", png, "image/png")})
        portrait = client.post("/api/portrait", files={"image": ("a.png", png, "image/png")}, data={"blur_level": "5"})
        for r in (erase, portrait):
            assert r.status_code == 503 and r.headers["retry-after"] == "5" and "starting" in r.json()["detail"]
    finally:
        state.inpainter, state.portrait, state.boot_finished = saved
