"""One CPU, one heavy job: eraser + portrait share ONE slot pool; the eraser's queue wait is bounded; a request cancelled while it
holds a slot never leaks it (erase AND portrait); portrait ONNX threads follow the container's CPU quota.

No ONNX model is needed: the REAL /api/erase and /api/portrait routes run against fake model objects."""
from __future__ import annotations

import asyncio
import io
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import cv2
import httpx
import numpy as np
import pytest
from PIL import Image
from starlette.requests import Request

from backend.app import main
from backend.app import portrait as portrait_module


# --------------------------------------------------------------------------------------------- fakes
def _png(w: int = 16, h: int = 16) -> bytes:
    arr = (np.random.default_rng(5).random((h, w, 3)) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr, "RGB").save(buf, "PNG")
    return buf.getvalue()


class Tracker:
    """Counts heavy jobs running at the same moment ACROSS both fakes."""
    def __init__(self):
        self.active = 0
        self.peak = 0
        self.calls = {"erase": 0, "portrait": 0}
        self._lock = threading.Lock()

    def run(self, kind: str, hold: threading.Event | None, seconds: float):
        with self._lock:
            self.calls[kind] += 1
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            if hold is not None:
                assert hold.wait(10), "test never released the fake job"
            if seconds:
                time.sleep(seconds)
        finally:
            with self._lock:
                self.active -= 1


class FakeTimer:
    total = 0.0

    @staticmethod
    def server_timing() -> str:
        return "lama;dur=1"


class FakeInpainter:
    provider = "FakeProvider"

    def __init__(self, tracker: Tracker, hold=None, seconds=0.0):
        self.tracker, self.hold, self.seconds = tracker, hold, seconds

    def erase_profiled(self, image_bytes, mask_bytes, ref_size=0):
        self.tracker.run("erase", self.hold, self.seconds)
        return b"\x89PNG-erase", FakeTimer()


class FakePortrait:
    provider = "FakeProvider"

    def __init__(self, tracker: Tracker, hold=None, seconds=0.0):
        self.tracker, self.hold, self.seconds = tracker, hold, seconds

    def blur_background(self, image_bytes, blur_level, focus_x, focus_y, skin_smooth):
        self.tracker.run("portrait", self.hold, self.seconds)
        return b"\x89PNG-portrait", "image/png"


_STATE_KEYS = ("inpainter", "portrait", "portrait_error", "portrait_load_lock", "ai_slots", "erase_slots", "erase_waiting",
               "portrait_slots", "portrait_waiting")


def _run(scenario, *, inpainter, portrait, pool=1, monkeypatch, **patches):
    """Run ``scenario(client)`` on the real app (lifespan NOT run) with a SHARED slot pool, like main.lifespan builds it."""
    for name, value in patches.items():
        monkeypatch.setattr(main, name, value)
    state = main.app.state
    saved = {k: getattr(state, k, None) for k in _STATE_KEYS}

    async def go():
        shared = asyncio.Semaphore(pool)
        state.inpainter, state.portrait, state.portrait_error = inpainter, portrait, None
        state.portrait_load_lock = asyncio.Lock()
        state.ai_slots = state.erase_slots = state.portrait_slots = shared
        state.erase_waiting = state.portrait_waiting = 0
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url="http://test", timeout=30) as client:
            result = await scenario(client)
        return result, shared._value, state.erase_waiting, state.portrait_waiting

    try:
        return asyncio.run(go())
    finally:
        for key, value in saved.items():
            setattr(state, key, value)


def _erase(client):
    return client.post("/api/erase", files={"image": ("i.png", _png(), "image/png"), "mask": ("m.png", _png(), "image/png")})


def _portrait(client):
    return client.post("/api/portrait", files={"image": ("p.png", _png(), "image/png")}, data={"blur_level": "5"})


# --------------------------------------------------------------------------------------------- shared pool
def test_lifespan_wires_one_shared_semaphore_for_both_endpoints(monkeypatch):
    monkeypatch.setattr(main, "ensure_models", lambda: {})
    monkeypatch.setattr(main, "LamaInpainter", lambda: (_ for _ in ()).throw(RuntimeError("no model in this test")))
    monkeypatch.setattr(main, "load_portrait", lambda app: None)
    state = main.app.state
    saved = {k: getattr(state, k, None) for k in _STATE_KEYS}

    async def go():
        async with main.lifespan(main.app):
            assert state.erase_slots is state.portrait_slots is state.ai_slots
            assert state.ai_slots._value == main.AI_MAX_CONCURRENCY >= 1
            assert state.erase_waiting == 0 and state.portrait_waiting == 0

    try:
        asyncio.run(go())
    finally:
        for key, value in saved.items():
            setattr(state, key, value)


def test_an_erase_and_a_portrait_never_run_at_the_same_time(monkeypatch):
    tracker = Tracker()

    async def scenario(client):
        return await asyncio.gather(_erase(client), _portrait(client), _erase(client), _portrait(client))

    responses, slots_left, erase_waiting, portrait_waiting = _run(
        scenario, inpainter=FakeInpainter(tracker, seconds=0.15), portrait=FakePortrait(tracker, seconds=0.15),
        monkeypatch=monkeypatch, ERASE_MAX_QUEUE=4, PORTRAIT_MAX_QUEUE=4)
    assert [r.status_code for r in responses] == [200] * 4
    assert tracker.calls == {"erase": 2, "portrait": 2}
    assert tracker.peak == 1, "an erase and a portrait overlapped on the same CPU"
    assert slots_left == 1 and erase_waiting == 0 and portrait_waiting == 0


def test_the_pool_size_is_honoured_across_both_endpoints(monkeypatch):
    tracker = Tracker()

    async def scenario(client):
        return await asyncio.gather(_erase(client), _portrait(client), _erase(client), _portrait(client))

    responses, slots_left, *_ = _run(
        scenario, inpainter=FakeInpainter(tracker, seconds=0.2), portrait=FakePortrait(tracker, seconds=0.2),
        pool=2, monkeypatch=monkeypatch, ERASE_MAX_QUEUE=4, PORTRAIT_MAX_QUEUE=4)
    assert [r.status_code for r in responses] == [200] * 4
    assert tracker.peak == 2 and slots_left == 2


# --------------------------------------------------------------------------------------------- erase queue
def test_erase_waiting_behind_a_portrait_job_is_bounded_and_answers_503_busy(monkeypatch):
    tracker, hold = Tracker(), threading.Event()

    async def scenario(client):
        running_portrait = asyncio.create_task(_portrait(client)); await asyncio.sleep(0.15)   # holds the shared slot
        started = time.perf_counter()
        erase = await _erase(client)                                                           # waits ERASE_QUEUE_WAIT_S -> 503
        waited = time.perf_counter() - started
        hold.set()
        return erase, waited, await running_portrait

    (erase, waited, portrait), slots_left, erase_waiting, portrait_waiting = _run(
        scenario, inpainter=FakeInpainter(tracker), portrait=FakePortrait(tracker, hold=hold),
        monkeypatch=monkeypatch, ERASE_QUEUE_WAIT_S=0.3, ERASE_MAX_QUEUE=4, PORTRAIT_MAX_QUEUE=4)
    assert erase.status_code == 503 and "busy" in erase.json()["detail"].lower() and erase.headers["retry-after"] == "5"
    assert 0.25 <= waited < 3
    assert portrait.status_code == 200 and tracker.calls == {"erase": 0, "portrait": 1}
    assert slots_left == 1 and erase_waiting == 0 and portrait_waiting == 0


def test_erase_queue_full_still_answers_503_busy(monkeypatch):
    tracker, hold = Tracker(), threading.Event()

    async def scenario(client):
        first = asyncio.create_task(_erase(client)); await asyncio.sleep(0.15)
        second = asyncio.create_task(_erase(client)); await asyncio.sleep(0.15)
        third = await _erase(client)
        hold.set()
        return third, await first, await second

    (third, first, second), slots_left, erase_waiting, _ = _run(
        scenario, inpainter=FakeInpainter(tracker, hold=hold), portrait=None, monkeypatch=monkeypatch, ERASE_MAX_QUEUE=1)
    assert third.status_code == 503 and third.headers["retry-after"] == "5"
    assert first.status_code == 200 and second.status_code == 200 and tracker.calls["erase"] == 2
    assert slots_left == 1 and erase_waiting == 0


# --------------------------------------------------------------------------------------------- slot leaks
@pytest.mark.parametrize("kind", ["erase", "portrait"])
def test_a_request_cancelled_while_it_holds_a_slot_never_leaks_it(monkeypatch, kind):
    """Cancelled at the await between acquire() and the job start (what a disconnect / proxy abort does)."""
    tracker = Tracker()

    async def hang(self):                                   # Request.is_disconnected(): never answers
        await asyncio.sleep(30)

    monkeypatch.setattr(Request, "is_disconnected", hang)

    async def scenario(client):
        post = _erase if kind == "erase" else _portrait
        task = asyncio.create_task(post(client)); await asyncio.sleep(0.3)      # now parked in is_disconnected(), slot held
        assert main.app.state.erase_slots._value == 0, "test setup: the request should be holding the slot"
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0.05)

    _, slots_left, erase_waiting, portrait_waiting = _run(
        scenario, inpainter=FakeInpainter(tracker), portrait=FakePortrait(tracker), monkeypatch=monkeypatch,
        ERASE_MAX_QUEUE=4, PORTRAIT_MAX_QUEUE=4)
    assert slots_left == 1, "the slot leaked: every later heavy request would wait forever"
    assert erase_waiting == 0 and portrait_waiting == 0
    assert tracker.calls == {"erase": 0, "portrait": 0}


# --------------------------------------------------------------------------------------------- portrait threads
class _FakeSession:
    def get_inputs(self):
        return [SimpleNamespace(name="in")]

    def get_outputs(self):
        return [SimpleNamespace(name="out")]


def _build_portrait(monkeypatch, *, quota: int, override: int):
    seen = {}

    def fake_build_session(path, *, label, preference="auto", threads=None):
        seen["threads"] = threads
        return _FakeSession(), "CPUExecutionProvider"

    monkeypatch.setattr(portrait_module, "check_model_file", lambda path, label: Path(path))
    monkeypatch.setattr(portrait_module, "build_session", fake_build_session)
    monkeypatch.setattr(portrait_module, "effective_cpu_count", lambda: quota)
    monkeypatch.setattr(portrait_module, "PORTRAIT_THREADS", override)
    previous = cv2.getNumThreads()
    try:
        model = portrait_module.DepthPortrait(Path("unused.onnx"))
        return model, seen["threads"], cv2.getNumThreads()
    finally:
        cv2.setNumThreads(previous)


def test_a_single_vcpu_container_gets_exactly_one_portrait_thread(monkeypatch):
    model, threads, cv_threads = _build_portrait(monkeypatch, quota=1, override=0)
    assert threads == 1 and model.threads == 1, "old code forced max(2, cpus) = 2 threads onto one vCPU"
    assert cv_threads == 1, "OpenCV must not spawn a host-sized pool inside a 1-vCPU container"


def test_portrait_threads_follow_the_cpu_quota_on_bigger_plans(monkeypatch):
    _, threads, cv_threads = _build_portrait(monkeypatch, quota=4, override=0)
    assert threads == 4 and cv_threads == 4


def test_portrait_threads_env_override_wins(monkeypatch):
    _, threads, _ = _build_portrait(monkeypatch, quota=1, override=3)
    assert threads == 3


# --------------------------------------------------------------------------------------------- production guards
def _lifespan_warnings(monkeypatch, workers: str | None) -> list[str]:
    monkeypatch.setattr(main, "ensure_models", lambda: {})
    monkeypatch.setattr(main, "LamaInpainter", lambda: (_ for _ in ()).throw(RuntimeError("no model in this test")))
    monkeypatch.setattr(main, "load_portrait", lambda app: None)
    if workers is None:
        monkeypatch.delenv("WEB_CONCURRENCY", raising=False)
    else:
        monkeypatch.setenv("WEB_CONCURRENCY", workers)
    seen: list[str] = []
    real_warning = main.logger.warning
    monkeypatch.setattr(main.logger, "warning", lambda msg, *a, **k: (seen.append(msg % a if a else msg), real_warning(msg, *a, **k)))
    state = main.app.state
    saved = {k: getattr(state, k, None) for k in _STATE_KEYS}

    async def go():
        async with main.lifespan(main.app):
            pass

    try:
        asyncio.run(go())
    finally:
        for key, value in saved.items():
            setattr(state, key, value)
    return [m for m in seen if "WEB_CONCURRENCY" in m]


def test_running_more_than_one_worker_is_called_out_at_startup(monkeypatch):
    warned = _lifespan_warnings(monkeypatch, "3")
    assert len(warned) == 1 and "OWN slot pool" in warned[0] and "ONE worker" in warned[0]


@pytest.mark.parametrize("value", [None, "", "1", "abc"])
def test_a_single_worker_or_an_unset_variable_stays_quiet(monkeypatch, value):
    assert _lifespan_warnings(monkeypatch, value) == []


def test_retry_after_is_readable_by_a_cross_origin_page(monkeypatch):
    """The packaged app calls the API cross-origin: without Access-Control-Expose-Headers: Retry-After the browser hides the
    header on a 503 "busy" and the page can only guess how long to wait."""
    tracker, hold = Tracker(), threading.Event()
    assert "Retry-After" in main.EXPOSED_HEADERS

    async def scenario(client):
        headers = {"Origin": "https://localhost"}
        first = asyncio.create_task(client.post("/api/portrait", headers=headers, data={"blur_level": "5"},
                                                files={"image": ("p.png", _png(), "image/png")})); await asyncio.sleep(0.15)
        busy = await client.post("/api/portrait", headers=headers, data={"blur_level": "5"},
                                 files={"image": ("p.png", _png(), "image/png")})
        hold.set()
        await first
        return busy

    busy, slots_left, *_ = _run(scenario, inpainter=None, portrait=FakePortrait(tracker, hold=hold), monkeypatch=monkeypatch,
                                PORTRAIT_MAX_QUEUE=0)
    assert busy.status_code == 503 and busy.headers["retry-after"] == "5"
    exposed = [h.strip().lower() for h in busy.headers.get("access-control-expose-headers", "").split(",")]
    assert "retry-after" in exposed, busy.headers
    assert slots_left == 1
