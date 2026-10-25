"""Portrait load protection - downscale-at-decode + bounded queue. Needs NEITHER ONNX model: the API tests drive the REAL
/api/portrait endpoint (main.py) with a fake portrait object; the decode tests call the REAL DepthPortrait._decode.

Covers: photos shrink to PORTRAIT_MAX_SIDE before any array exists (PNG, JPEG via draft(), EXIF-rotated, alpha, palette);
small photos are untouched; queue overflow -> 503 + Retry-After; queue wait is bounded; the compute timeout does NOT count
queue time; the concurrency cap holds; slots / waiting counter are never leaked.
"""
from __future__ import annotations

import asyncio
import io
import threading
import time

import httpx
import numpy as np
import pytest
from PIL import Image

from backend.app import main
from backend.app.portrait import DepthPortrait


# --------------------------------------------------------------------------------------------- helpers
def _png(w: int, h: int, mode: str = "RGB") -> bytes:
    rng = np.random.default_rng(7)
    channels = {"RGB": 3, "RGBA": 4}[mode]
    arr = (rng.random((h, w, channels)) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(buf, "PNG", compress_level=1)
    return buf.getvalue()


def _jpeg(w: int, h: int, orientation: int | None = None) -> bytes:
    arr = (np.random.default_rng(3).random((h, w, 3)) * 255).astype(np.uint8)
    img = Image.fromarray(arr, "RGB")
    buf = io.BytesIO()
    if orientation:
        exif = Image.Exif()
        exif[0x0112] = orientation
        img.save(buf, "JPEG", quality=80, exif=exif)
    else:
        img.save(buf, "JPEG", quality=80)
    return buf.getvalue()


# --------------------------------------------------------------------------------------------- _fit_size / _decode
@pytest.mark.parametrize("w,h,limit,expected", [
    (4000, 3000, 2048, (2048, 1536)),
    (3000, 4000, 2048, (1536, 2048)),
    (2048, 1000, 2048, (2048, 1000)),      # already fits
    (1000, 800, 2048, (1000, 800)),
    (4000, 3000, 0, (4000, 3000)),         # 0 = never downscale
    (10000, 1, 2048, (2048, 1)),           # never collapses to 0 px
])
def test_fit_size(w, h, limit, expected):
    assert DepthPortrait._fit_size(w, h, limit) == expected


def test_large_png_is_shrunk_to_the_limit_keeping_the_aspect_ratio():
    rgb, alpha = DepthPortrait._decode(_png(3000, 2000), max_side=1000)
    assert alpha is None and rgb.shape == (667, 1000, 3) and rgb.dtype == np.uint8


def test_large_jpeg_is_shrunk_via_draft_and_lands_exactly_on_the_limit():
    rgb, alpha = DepthPortrait._decode(_jpeg(4000, 3000), max_side=1024)
    assert alpha is None and rgb.shape == (768, 1024, 3)


def test_exif_rotated_jpeg_is_oriented_and_the_long_side_is_the_limit():
    rgb, _ = DepthPortrait._decode(_jpeg(4000, 3000, orientation=6), max_side=1000)   # 6 = rotate 90 deg: portrait result
    assert rgb.shape[0] == 1000 and rgb.shape[1] == 750


def test_photo_that_already_fits_is_returned_pixel_identical_to_the_old_path():
    data = _png(300, 200)
    rgb, alpha = DepthPortrait._decode(data, max_side=2048)
    expected = np.asarray(Image.open(io.BytesIO(data)).convert("RGB"), dtype=np.uint8)
    assert alpha is None and np.array_equal(rgb, expected)


def test_limit_zero_keeps_the_original_size():
    rgb, _ = DepthPortrait._decode(_png(1500, 900), max_side=0)
    assert rgb.shape == (900, 1500, 3)


def test_alpha_channel_is_shrunk_together_with_the_colour_channels():
    rgb, alpha = DepthPortrait._decode(_png(2000, 1000, "RGBA"), max_side=500)
    assert rgb.shape == (250, 500, 3) and alpha is not None and alpha.shape == (250, 500)


def test_palette_image_with_transparency_keeps_its_alpha_after_shrinking():
    img = Image.new("P", (1200, 800))
    img.putpalette([i for c in range(256) for i in (c, 255 - c, 128)])
    buf = io.BytesIO()
    img.save(buf, "PNG", transparency=0)
    rgb, alpha = DepthPortrait._decode(buf.getvalue(), max_side=600)
    assert rgb.shape == (400, 600, 3) and alpha is not None and alpha.shape == (400, 600)


def test_default_limit_comes_from_config(monkeypatch):
    from backend.app import portrait as portrait_module
    monkeypatch.setattr(portrait_module, "PORTRAIT_MAX_SIDE", 640)
    rgb, _ = DepthPortrait._decode(_png(1600, 1000))
    assert rgb.shape == (400, 640, 3)


def test_pixel_cap_still_rejects_before_decoding(monkeypatch):
    from backend.app import portrait as portrait_module
    monkeypatch.setattr(portrait_module, "PORTRAIT_MAX_PIXELS", 100)
    with pytest.raises(ValueError, match="too large"):
        DepthPortrait._decode(_png(50, 50), max_side=0)


def test_garbage_bytes_are_a_clean_value_error():
    with pytest.raises(ValueError):
        DepthPortrait._decode(b"definitely not an image", max_side=1000)


# --------------------------------------------------------------------------------------------- API: queue behaviour
class FakePortrait:
    """Stands in for DepthPortrait: blocks until released, records peak parallelism."""
    provider = "FakeProvider"

    def __init__(self, hold: threading.Event | None = None, seconds: float = 0.0, fail: Exception | None = None):
        self.hold, self.seconds, self.fail = hold, seconds, fail
        self.calls = 0
        self.active = 0
        self.peak = 0
        self._lock = threading.Lock()

    def blur_background(self, image_bytes, blur_level, focus_x, focus_y, skin_smooth):
        with self._lock:
            self.calls += 1
            self.active += 1
            self.peak = max(self.peak, self.active)
        try:
            if self.hold is not None:
                assert self.hold.wait(10), "test never released the fake job"
            if self.seconds:
                time.sleep(self.seconds)
            if self.fail:
                raise self.fail
            return b"\x89PNG-fake", "image/png"
        finally:
            with self._lock:
                self.active -= 1


def _run_api(scenario, fake, *, concurrency=1, monkeypatch=None, **patches):
    """Run ``scenario(client)`` against the real app with the portrait model replaced by ``fake`` (lifespan NOT run)."""
    for name, value in patches.items():
        monkeypatch.setattr(main, name, value)
    state = main.app.state
    saved = {k: getattr(state, k, None) for k in ("portrait", "portrait_slots", "portrait_waiting", "portrait_load_lock", "portrait_error")}

    async def go():
        state.portrait = fake
        state.portrait_slots = asyncio.Semaphore(concurrency)
        state.portrait_waiting = 0
        state.portrait_load_lock = asyncio.Lock()
        state.portrait_error = None
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=30) as client:
            result = await scenario(client)
        return result, state.portrait_slots._value, state.portrait_waiting

    try:
        return asyncio.run(go())
    finally:
        for key, value in saved.items():
            setattr(state, key, value)


def _post(client: httpx.AsyncClient, **form):
    return client.post("/api/portrait", files={"image": ("p.png", _png(16, 16), "image/png")},
                       data={"blur_level": "5", **{k: str(v) for k, v in form.items()}})


def _release_later(event: threading.Event, delay: float):
    threading.Timer(delay, event.set).start()


def test_overflowing_the_queue_answers_503_busy_with_retry_after_and_nothing_is_dropped(monkeypatch):
    hold = threading.Event()
    fake = FakePortrait(hold=hold)

    async def scenario(client):
        first = asyncio.create_task(_post(client)); await asyncio.sleep(0.15)      # takes the only slot
        second = asyncio.create_task(_post(client)); await asyncio.sleep(0.15)     # fills the 1-place queue
        third = await _post(client)                                                # queue full -> told to retry
        hold.set()
        return third, await first, await second

    (third, first, second), slots_left, waiting = _run_api(scenario, fake, monkeypatch=monkeypatch, PORTRAIT_MAX_QUEUE=1)
    assert third.status_code == 503 and third.headers["retry-after"] == "5"
    assert "busy" in third.json()["detail"].lower()
    assert first.status_code == 200 and second.status_code == 200           # accepted requests are never dropped
    assert fake.calls == 2 and fake.peak == 1                              # the rejected one never reached the model
    assert slots_left == 1 and waiting == 0                                # nothing leaked


def test_concurrency_cap_holds_with_two_slots(monkeypatch):
    fake = FakePortrait(seconds=0.2)

    async def scenario(client):
        return await asyncio.gather(*[_post(client) for _ in range(5)])

    responses, slots_left, waiting = _run_api(scenario, fake, concurrency=2, monkeypatch=monkeypatch, PORTRAIT_MAX_QUEUE=10)
    assert [r.status_code for r in responses] == [200] * 5
    assert fake.peak == 2 and fake.calls == 5
    assert slots_left == 2 and waiting == 0


def test_waiting_for_a_slot_is_bounded_and_the_running_job_is_unaffected(monkeypatch):
    hold = threading.Event()
    fake = FakePortrait(hold=hold)

    async def scenario(client):
        first = asyncio.create_task(_post(client)); await asyncio.sleep(0.15)
        started = time.perf_counter()
        second = await _post(client)                                        # waits PORTRAIT_QUEUE_WAIT_S, then 503
        waited = time.perf_counter() - started
        hold.set()
        return second, waited, await first

    (second, waited, first), slots_left, waiting = _run_api(
        scenario, fake, monkeypatch=monkeypatch, PORTRAIT_QUEUE_WAIT_S=0.3, PORTRAIT_MAX_QUEUE=4)
    assert second.status_code == 503 and "busy" in second.json()["detail"].lower() and second.headers["retry-after"] == "5"
    assert 0.25 <= waited < 3
    assert first.status_code == 200
    assert fake.calls == 1 and slots_left == 1 and waiting == 0


def test_compute_timeout_does_not_count_the_time_spent_in_the_queue(monkeypatch):
    fake = FakePortrait(seconds=0.35)       # each job 0.35 s < 0.5 s timeout; the 2nd request has waited 0.35 s first

    async def scenario(client):
        first = asyncio.create_task(_post(client)); await asyncio.sleep(0.1)
        second = await _post(client)
        return await first, second

    (first, second), slots_left, waiting = _run_api(
        scenario, fake, monkeypatch=monkeypatch, PORTRAIT_TIMEOUT_S=0.5, PORTRAIT_QUEUE_WAIT_S=10, PORTRAIT_MAX_QUEUE=4)
    assert first.status_code == 200
    assert second.status_code == 200, "old behaviour: 0.35 s queue + 0.35 s compute > 0.5 s -> a false 504"
    assert slots_left == 1 and waiting == 0


def test_real_compute_timeout_is_504_and_the_slot_returns_only_when_the_thread_is_done(monkeypatch):
    fake = FakePortrait(seconds=0.6)

    async def scenario(client):
        response = await _post(client)
        slot_value_right_after_504 = main.app.state.portrait_slots._value
        await asyncio.sleep(0.8)                                            # let the (uncancellable) thread finish
        return response, slot_value_right_after_504

    (response, during), slots_left, waiting = _run_api(
        scenario, fake, monkeypatch=monkeypatch, PORTRAIT_TIMEOUT_S=0.2, PORTRAIT_MAX_QUEUE=4)
    assert response.status_code == 504
    assert during == 0, "a timed-out job still occupies its slot until its thread really ends"
    assert slots_left == 1 and waiting == 0


def test_model_errors_free_the_slot_and_keep_their_status_codes(monkeypatch):
    for exc, status in ((ValueError("image is not a valid image"), 400), (RuntimeError("boom"), 500), (MemoryError(), 500)):
        fake = FakePortrait(fail=exc)

        async def scenario(client):
            return await _post(client)

        response, slots_left, waiting = _run_api(scenario, fake, monkeypatch=monkeypatch)
        assert response.status_code == status, (exc, response.text)
        assert slots_left == 1 and waiting == 0


def test_oversized_photo_is_rejected_before_it_is_queued_or_decoded(monkeypatch):
    fake = FakePortrait()

    async def scenario(client):
        return await client.post("/api/portrait", files={"image": ("big.png", _png(40, 40), "image/png")}, data={"blur_level": "5"})

    response, slots_left, waiting = _run_api(scenario, fake, monkeypatch=monkeypatch, PORTRAIT_MAX_PIXELS=100)
    assert response.status_code == 400 and "megapixel" in response.json()["detail"]
    assert fake.calls == 0 and slots_left == 1 and waiting == 0


def test_happy_path_still_returns_the_png_with_its_headers(monkeypatch):
    fake = FakePortrait()

    async def scenario(client):
        return await _post(client)

    response, slots_left, waiting = _run_api(scenario, fake, monkeypatch=monkeypatch)
    assert response.status_code == 200 and response.headers["content-type"] == "image/png"
    assert response.content == b"\x89PNG-fake" and "server-timing" in response.headers
    assert slots_left == 1 and waiting == 0
