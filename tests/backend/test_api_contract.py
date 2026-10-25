"""HTTP contract tests for the FastAPI app, through Starlette's TestClient used as a CONTEXT MANAGER
(see conftest.client) so the real lifespan runs and both ONNX models are loaded.

What is pinned here is the contract the web UI depends on (js/config/api-client.js maps these statuses to
user messages): status codes, JSON error bodies, and - crucially - CORS headers on EVERY error, because a
missing header turns a readable 4xx/5xx into an opaque 'Failed to fetch' in the browser.
"""
from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from tests.backend.test_pipeline_golden import _jpeg, _mask, _mask_png, _png, _scene

ORIGIN = {"Origin": "http://frontend.test"}      # CORS headers are only emitted for requests that carry an Origin


def _tiny_scene() -> np.ndarray:
    return _scene(320, 240)


def _erase_files(image: bytes | None = None, mask: bytes | None = None):
    scene = _tiny_scene()
    return {
        "image": ("photo.png", image if image is not None else _png(scene), "image/png"),
        "mask": ("mask.png", mask if mask is not None else _mask_png(_mask(320, 240, (100, 80, 40, 30), "rect")), "image/png"),
    }


def _assert_cors(resp) -> None:
    assert resp.headers.get("access-control-allow-origin") in ("*", ORIGIN["Origin"]), dict(resp.headers)


def _assert_json_error(resp, status: int) -> str:
    assert resp.status_code == status, resp.text[:300]
    _assert_cors(resp)
    assert resp.headers["content-type"].startswith("application/json")
    detail = resp.json()["detail"]
    assert detail, "error body must carry a human-readable detail"
    return detail if isinstance(detail, str) else str(detail)


# ------------------------------------------------------------------------------------------ /health
def test_health_reports_loaded_models_and_dependencies(client):
    r = client.get("/health", headers=ORIGIN)
    assert r.status_code == 200
    _assert_cors(r)
    body = r.json()
    assert body["status"] == "ok"
    assert body["model_loaded"] is True
    assert body["portrait_model_loaded"] is True
    assert body["portrait_model_exists"] is True
    assert body["portrait_load_error"] is None
    assert "CPUExecutionProvider" in body["onnx_providers"]
    assert body["lama_provider"] == "CPUExecutionProvider"
    deps = body["dependencies"]
    for name in ("fastapi", "uvicorn", "onnxruntime", "pillow", "numpy", "opencv"):
        assert deps[name] not in ("missing", "", None), f"dependency {name} not reported: {deps}"


def test_health_degrades_when_lama_is_unloaded(client):
    saved = client.app.state.inpainter
    client.app.state.inpainter = None
    try:
        body = client.get("/health").json()
        assert body["status"] == "degraded" and body["model_loaded"] is False
    finally:
        client.app.state.inpainter = saved


# ------------------------------------------------------------------------------------------ /api/erase
def test_erase_happy_path_returns_png_of_original_size(client):
    r = client.post("/api/erase", files=_erase_files(), data={"ref_size": "0"}, headers=ORIGIN)
    assert r.status_code == 200, r.text[:300]
    _assert_cors(r)
    assert r.headers["content-type"] == "image/png"
    assert "server-timing" in r.headers
    with Image.open(io.BytesIO(r.content)) as im:
        assert im.size == (320, 240) and im.format == "PNG"


def test_erase_empty_upload_is_400_with_cors(client):
    files = _erase_files(image=b"")
    detail = _assert_json_error(client.post("/api/erase", files=files, headers=ORIGIN), 400)
    assert "non-empty" in detail


@pytest.mark.parametrize("which", ["image", "mask"])
def test_erase_undecodable_payload_is_400_with_cors(client, which):
    files = _erase_files(**{which: b"this is definitely not an image"})
    detail = _assert_json_error(client.post("/api/erase", files=files, headers=ORIGIN), 400)
    assert "not a valid image" in detail


def test_erase_missing_mask_field_is_422_with_cors(client):
    files = {"image": _erase_files()["image"]}
    r = client.post("/api/erase", files=files, headers=ORIGIN)
    _assert_json_error(r, 422)


def test_erase_bad_ref_size_is_422_with_cors(client):
    r = client.post("/api/erase", files=_erase_files(), data={"ref_size": "-5"}, headers=ORIGIN)
    _assert_json_error(r, 422)
    r = client.post("/api/erase", files=_erase_files(), data={"ref_size": "70000"}, headers=ORIGIN)
    _assert_json_error(r, 422)


def test_erase_oversize_upload_is_413_with_cors(client):
    from backend.app.config import MAX_UPLOAD_BYTES
    big = b"\0" * (MAX_UPLOAD_BYTES + 1)
    detail = _assert_json_error(client.post("/api/erase", files=_erase_files(image=big), headers=ORIGIN), 413)
    assert "25 MB" in detail


def test_erase_is_503_when_model_is_not_loaded(client):
    saved = client.app.state.inpainter
    client.app.state.inpainter = None
    try:
        detail = _assert_json_error(client.post("/api/erase", files=_erase_files(), headers=ORIGIN), 503)
        assert "not loaded" in detail
    finally:
        client.app.state.inpainter = saved


def test_erase_internal_failure_is_json_500_with_cors_and_ref(client, monkeypatch):
    def boom(*_a, **_k):
        raise RuntimeError("synthetic inference failure")
    monkeypatch.setattr(client.app.state.inpainter, "erase_profiled", boom)
    detail = _assert_json_error(client.post("/api/erase", files=_erase_files(), headers=ORIGIN), 500)
    assert "ref " in detail and "synthetic" not in detail      # id for the log, internals not leaked to the client


def test_cors_preflight_is_answered(client):
    r = client.options("/api/erase", headers={**ORIGIN, "Access-Control-Request-Method": "POST",
                                              "Access-Control-Request-Headers": "content-type"})
    assert r.status_code == 200
    _assert_cors(r)
    assert "POST" in r.headers["access-control-allow-methods"] or r.headers["access-control-allow-methods"] == "*"


# ------------------------------------------------------------------------------------------ /api/portrait
def _portrait_post(client, data: dict | None = None, image: bytes | None = None, name: str = "p.jpg", mime: str = "image/jpeg"):
    payload = image if image is not None else _jpeg(_tiny_scene())
    return client.post("/api/portrait", files={"image": (name, payload, mime)}, data=data or {}, headers=ORIGIN)


def test_portrait_blur_level_1_returns_untouched_lossless_png(client):
    # V24/G9: the result is the editor's working image, so it must come back as lossless PNG - and, with level 1 and
    # no smoothing (no depth pass), bit-identical to what the server decoded.
    r = _portrait_post(client, {"blur_level": "1"})
    assert r.status_code == 200, r.text[:300]
    _assert_cors(r)
    assert r.headers["content-type"] == "image/png"
    assert 'filename="portrait.png"' in r.headers["content-disposition"]
    sent = np.asarray(Image.open(io.BytesIO(_jpeg(_tiny_scene()))).convert("RGB"), dtype=np.int16)
    out = Image.open(io.BytesIO(r.content))
    assert out.format == "PNG" and out.mode == "RGB"
    got = np.asarray(out, dtype=np.int16)
    assert got.shape == sent.shape
    assert np.array_equal(got, sent)                 # no second lossy generation


def test_portrait_accepts_png_baseline_and_stays_lossless(client):
    # The browser now uploads its (PNG) working image: a PNG in must come back as the same pixels at level 1.
    scene = _tiny_scene()
    buf = io.BytesIO()
    Image.fromarray(scene, mode="RGB").save(buf, format="PNG")
    r = _portrait_post(client, {"blur_level": "1"}, image=buf.getvalue(), name="portrait-source.png", mime="image/png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert np.array_equal(np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB")), scene)


def test_portrait_real_blur_runs_end_to_end(client):
    r = _portrait_post(client, {"blur_level": "10", "skin_smooth": "30", "focus_x": "0.5", "focus_y": "0.4"})
    assert r.status_code == 200, r.text[:300]
    got = np.asarray(Image.open(io.BytesIO(r.content)).convert("RGB"), dtype=np.int16)
    sent = np.asarray(Image.open(io.BytesIO(_jpeg(_tiny_scene()))).convert("RGB"), dtype=np.int16)
    assert got.shape == sent.shape and np.abs(got - sent).mean() > 0.05


def test_portrait_keeps_transparency_as_png(client):
    rgba = np.dstack([_tiny_scene(), np.full((240, 320), 200, np.uint8)])
    buf = io.BytesIO()
    Image.fromarray(rgba, mode="RGBA").save(buf, format="PNG")
    r = _portrait_post(client, {"blur_level": "1"}, image=buf.getvalue(), name="p.png", mime="image/png")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    assert Image.open(io.BytesIO(r.content)).mode == "RGBA"


@pytest.mark.parametrize("field,value", [
    ("blur_level", "0"), ("blur_level", "31"), ("skin_smooth", "-1"), ("skin_smooth", "101"),
    ("focus_x", "1.5"), ("focus_y", "-0.1"), ("blur_level", "abc"),
])
def test_portrait_out_of_range_params_are_422_with_cors(client, field, value):
    _assert_json_error(_portrait_post(client, {field: value}), 422)


def test_portrait_empty_and_garbage_uploads_are_400_with_cors(client):
    assert "non-empty" in _assert_json_error(_portrait_post(client, image=b""), 400)
    assert "not a valid image" in _assert_json_error(_portrait_post(client, {"blur_level": "5"}, image=b"garbage"), 400)


def test_portrait_oversize_upload_is_413_with_cors(client):
    from backend.app.config import MAX_UPLOAD_BYTES
    detail = _assert_json_error(_portrait_post(client, image=b"\0" * (MAX_UPLOAD_BYTES + 1)), 413)
    assert "25 MB" in detail


def test_portrait_is_503_with_reason_when_model_cannot_load(client, monkeypatch):
    """Model missing at boot AND the lazy retry fails -> 503 that names the reason (never a dropped connection)."""
    import backend.app.main as main

    def cannot_load(*_a, **_k):
        raise RuntimeError("model file vanished")

    saved = client.app.state.portrait
    client.app.state.portrait = None
    monkeypatch.setattr(main, "DepthPortrait", cannot_load)
    try:
        detail = _assert_json_error(_portrait_post(client, {"blur_level": "5"}), 503)
        assert "failed to load" in detail and "model file vanished" in detail      # development profile: reason included
        health = client.get("/health").json()
        assert health["portrait_model_loaded"] is False and "model file vanished" in health["portrait_load_error"]
    finally:
        monkeypatch.undo()
        client.app.state.portrait = saved
        client.app.state.portrait_error = None


def test_portrait_lazy_reload_recovers_after_boot_failure(client):
    saved = client.app.state.portrait
    client.app.state.portrait = None
    try:
        r = _portrait_post(client, {"blur_level": "1"})
        assert r.status_code == 200, r.text[:300]            # load_portrait() ran again on demand
        assert client.app.state.portrait is not None
    finally:
        client.app.state.portrait = client.app.state.portrait or saved


def test_portrait_timeout_is_504_with_cors(client, monkeypatch):
    import backend.app.main as main
    monkeypatch.setattr(main, "PORTRAIT_TIMEOUT_S", 0.001)
    r = _portrait_post(client, {"blur_level": "12"})        # real depth inference takes far longer than 1 ms
    detail = _assert_json_error(r, 504)
    assert "timed out" in detail
