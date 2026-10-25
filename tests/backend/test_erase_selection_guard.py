"""Eraser selection-size guard: a painted selection wider than 1024 px is refused with HTTP 400 (English + Arabic message).

Two layers, like the rest of the suite:

* Pipeline tests need NO model and NO web stack: ``erase_profiled`` runs for real (decode, bbox, crop, blend, encode) with a
  stub in place of the ONNX session (same technique as test_erase_png_encoding.py). They also prove the guard fires BEFORE the
  network is ever called.
* Route tests go through the real app (``client`` fixture: skipped locally without models, a hard failure in CI) and pin the
  wire contract the browser depends on: status, JSON shape, CORS header, and that exactly 1024 px still works.

What is measured is the bounding box of the PAINTED pixels - not the dimensions of the uploaded mask image, which may legitimately
be wider than 1024 px (a big photo with a small selection).
"""
from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from backend.app.config import ERASE_MAX_SELECTION_WIDTH, MODEL_SIZE
from backend.app.erase_guard import (
    ERROR_CODE,
    SelectionTooLargeError,
    bilingual_message,
    check_selection_width,
    error_body,
    message_ar,
    message_en,
)
from backend.app.lama import LamaInpainter

ORIGIN = {"Origin": "http://frontend.test"}
EN = "Selection too large. Max width is 1024px."
AR = "المنطقة المحددة كبيرة جدًا. الحد الأقصى للعرض هو 1024 بكسل."


# ------------------------------------------------------------------------------------------------ helpers
def _png(arr: np.ndarray, mode: str) -> bytes:
    out = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(out, format="PNG", compress_level=1)
    return out.getvalue()


def _photo(w: int, h: int) -> bytes:
    rng = np.random.default_rng(3)
    return _png(rng.integers(0, 256, (h, w, 3), dtype=np.uint8), "RGB")


def _mask(w: int, h: int, x: int, y: int, bw: int, bh: int) -> bytes:
    m = np.zeros((h, w), np.uint8)
    m[y:y + bh, x:x + bw] = 255
    return _png(m, "L")


def _stub_inpainter() -> tuple[LamaInpainter, list[int]]:
    """Real pipeline, fake network. ``calls`` records every time the (stub) network is run."""
    calls: list[int] = []
    inpainter = object.__new__(LamaInpainter)           # skip __init__: it loads the ONNX model
    inpainter.threads, inpainter.provider = 1, "cpu"

    def run(image, mask):
        calls.append(1)
        return [np.full((1, 3, MODEL_SIZE, MODEL_SIZE), 128.0, np.float32)]

    inpainter._run = run
    return inpainter, calls


# ------------------------------------------------------------------------------------------------ rule + wording
def test_limit_is_1024_pixels():
    assert ERASE_MAX_SELECTION_WIDTH == 1024


def test_message_is_clear_in_english_and_arabic():
    assert message_en() == EN
    assert message_ar() == AR
    both = bilingual_message()
    assert EN in both and AR in both


def test_width_check_boundary_exactly_the_limit_is_allowed():
    check_selection_width(1)
    check_selection_width(1024)                         # "Max width is 1024px" -> 1024 itself is fine
    with pytest.raises(SelectionTooLargeError) as info:
        check_selection_width(1025)
    assert (info.value.width, info.value.limit) == (1025, 1024)


def test_error_is_a_value_error_so_legacy_400_mapping_still_catches_it():
    assert issubclass(SelectionTooLargeError, ValueError)
    assert str(SelectionTooLargeError(2000)) == bilingual_message()


def test_error_body_is_machine_readable_and_keeps_detail_a_string():
    body = error_body(SelectionTooLargeError(1500))
    assert isinstance(body["detail"], str) and EN in body["detail"] and AR in body["detail"]
    assert body["code"] == ERROR_CODE == "SELECTION_TOO_LARGE"
    assert (body["message_en"], body["message_ar"]) == (EN, AR)
    assert (body["max_width"], body["width"]) == (1024, 1500)


# ------------------------------------------------------------------------------------------------ pipeline
def test_pipeline_refuses_a_too_wide_selection_before_running_the_network():
    inpainter, calls = _stub_inpainter()
    with pytest.raises(SelectionTooLargeError) as info:
        inpainter.erase_profiled(_photo(1400, 200), _mask(1400, 200, 100, 50, 1025, 40))
    assert info.value.width == 1025 and info.value.limit == 1024
    assert calls == [], "the network must not run for a refused selection"


def test_pipeline_accepts_a_selection_of_exactly_1024_px():
    inpainter, calls = _stub_inpainter()
    png, _ = inpainter.erase_profiled(_photo(1400, 200), _mask(1400, 200, 100, 50, 1024, 40))
    assert calls == [1]
    with Image.open(io.BytesIO(png)) as im:
        assert im.size == (1400, 200)


def test_pipeline_measures_the_painted_box_not_the_mask_image_width():
    """A 3000 px wide mask image with a 200 px selection is perfectly fine (the client may upload the whole photo)."""
    inpainter, calls = _stub_inpainter()
    png, _ = inpainter.erase_profiled(_photo(3000, 120), _mask(3000, 120, 1400, 40, 200, 40))
    assert calls == [1]
    with Image.open(io.BytesIO(png)) as im:
        assert im.size == (3000, 120)


def test_pipeline_uses_the_bounding_box_of_scattered_strokes():
    """Two small strokes far apart: each is tiny but the selection (their joint bounding box) is 1100 px wide."""
    inpainter, calls = _stub_inpainter()
    m = np.zeros((200, 1400), np.uint8)
    m[80:100, 50:70] = 255
    m[80:100, 1130:1150] = 255                           # box spans x = 50 .. 1149 -> 1100 px
    with pytest.raises(SelectionTooLargeError) as info:
        inpainter.erase_profiled(_photo(1400, 200), _png(m, "L"))
    assert info.value.width == 1100 and calls == []


def test_pipeline_empty_mask_is_still_an_identity_not_an_error():
    inpainter, calls = _stub_inpainter()
    png, _ = inpainter.erase_profiled(_photo(1400, 200), _png(np.zeros((200, 1400), np.uint8), "L"))
    assert calls == []
    with Image.open(io.BytesIO(png)) as im:
        assert im.size == (1400, 200)


# ------------------------------------------------------------------------------------------------ route (real app)
def _assert_selection_400(resp) -> dict:
    assert resp.status_code == 400, resp.text[:300]
    assert resp.headers.get("access-control-allow-origin") in ("*", ORIGIN["Origin"]), dict(resp.headers)
    assert resp.headers["content-type"].startswith("application/json")
    body = resp.json()
    assert body["code"] == "SELECTION_TOO_LARGE"
    assert EN in body["detail"] and AR in body["detail"]
    assert (body["message_en"], body["message_ar"]) == (EN, AR)
    assert body["max_width"] == 1024
    return body


def _post(client, image: bytes, mask: bytes):
    return client.post("/api/erase", files={"image": ("photo.png", image, "image/png"),
                                            "mask": ("mask.png", mask, "image/png")}, headers=ORIGIN)


def test_route_too_wide_selection_is_400_json_english_and_arabic(client, monkeypatch):
    stub, calls = _stub_inpainter()
    monkeypatch.setattr(client.app.state.inpainter, "_run", stub._run)
    body = _assert_selection_400(_post(client, _photo(1400, 200), _mask(1400, 200, 100, 50, 1100, 40)))
    assert body["width"] == 1100
    assert calls == []


def test_route_selection_of_exactly_1024_px_still_succeeds(client, monkeypatch):
    stub, calls = _stub_inpainter()
    monkeypatch.setattr(client.app.state.inpainter, "_run", stub._run)
    r = _post(client, _photo(1400, 200), _mask(1400, 200, 100, 50, 1024, 40))
    assert r.status_code == 200, r.text[:300]
    assert r.headers["content-type"] == "image/png"
    assert calls == [1]


def test_route_other_400s_keep_their_plain_shape(client):
    """The new error must not leak into the older ones: an undecodable mask is still a plain {'detail': str} 400."""
    r = _post(client, _photo(64, 64), b"this is definitely not an image")
    assert r.status_code == 400
    body = r.json()
    assert "code" not in body and "not a valid image" in body["detail"]
