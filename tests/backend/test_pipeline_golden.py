"""Golden-output regression tests for the two ML pipelines (LaMa erase, DepthPortrait blur/skin).

A deterministic synthetic photo is pushed through the REAL ONNX models; the decoded RGB pixels of every
result are hashed (sha256, first 16 hex chars) and compared with tests/backend/golden.json.
Any pixel change anywhere in backend/app/lama.py, portrait.py or skin.py flips the hash.

    pytest tests/backend                       # compare; a missing golden entry is SKIPPED
    REQUIRE_GOLDEN=1 pytest tests/backend      # CI: missing / stale golden entries FAIL
    UPDATE_GOLDEN=1  pytest tests/backend      # (re)write golden.json, then review + commit it

Hashes are tied to the pinned versions in requirements-dev.txt (and the bundled models); golden.json records
them under "_meta" so a mismatch report can tell "code changed" from "environment changed".
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import cv2
import numpy as np
import pytest
from PIL import Image

GOLDEN_PATH = Path(__file__).with_name("golden.json")
HASH_LEN = 16

ERASE_CASES = [
    # id, (x, y, w, h), shape
    pytest.param("small_center", (300, 220, 40, 30), "rect", id="small_center"),
    pytest.param("wide_band_top_edge", (100, 0, 300, 24), "rect", id="wide_band_top_edge"),
    pytest.param("corner_bottom_right", (580, 430, 60, 50), "ellipse", id="corner_bottom_right"),
    pytest.param("large_blob", (150, 100, 340, 260), "ellipse", id="large_blob"),
]

PORTRAIT_CASES = [
    # id, blur_level, skin_smooth, (focus_x, focus_y)
    pytest.param("sharp_untouched", 1, 0, (0.5, 0.5), id="sharp_untouched"),
    pytest.param("blur12_center", 12, 0, (0.5, 0.5), id="blur12_center"),
    pytest.param("blur30_focus_left", 30, 0, (0.25, 0.6), id="blur30_focus_left"),
    pytest.param("skin60_only", 1, 60, (0.5, 0.4), id="skin60_only"),
    pytest.param("blur8_skin40_combo", 8, 40, (0.5, 0.4), id="blur8_skin40_combo"),
]

SCENE_W, SCENE_H = 640, 480


# --------------------------------------------------------------------------- synthetic input
def _scene(w: int = SCENE_W, h: int = SCENE_H) -> np.ndarray:
    """Deterministic RGB uint8 'photo': textured gradient backdrop, a person-like subject (skin-tone head,
    shirt, dark hair, eyes/lips) and a near object. Integer-only maths + cv2 rasterisation: no RNG, no
    platform-dependent floats, identical bytes everywhere."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.int64)
    noise = ((xx * 73856093) ^ (yy * 19349663)) % 13                       # integer hash noise (film grain)
    stripes = (((xx // 16) + (yy // 16)) % 2) * 14                          # soft checker => inpaintable texture
    img = np.empty((h, w, 3), dtype=np.int64)
    img[..., 0] = 70 + (xx * 110) // w + stripes + noise
    img[..., 1] = 110 + (yy * 90) // h + stripes + noise
    img[..., 2] = 150 - (xx * 60) // w + stripes + noise
    img = np.ascontiguousarray(np.clip(img, 0, 255).astype(np.uint8))

    cx = w // 2
    cv2.ellipse(img, (cx, h + 40), (210, 190), 0, 0, 360, (46, 78, 150), -1, cv2.LINE_8)        # shirt / shoulders
    cv2.rectangle(img, (cx - 34, int(h * 0.55)), (cx + 34, int(h * 0.72)), (214, 160, 128), -1)  # neck
    cv2.ellipse(img, (cx, int(h * 0.38)), (92, 118), 0, 0, 360, (226, 174, 142), -1, cv2.LINE_8) # face
    cv2.ellipse(img, (cx, int(h * 0.26)), (100, 70), 0, 180, 360, (38, 26, 20), -1, cv2.LINE_8)  # hair
    for ex in (-36, 36):
        cv2.ellipse(img, (cx + ex, int(h * 0.36)), (14, 7), 0, 0, 360, (250, 250, 250), -1, cv2.LINE_8)
        cv2.circle(img, (cx + ex, int(h * 0.36)), 4, (30, 20, 16), -1, cv2.LINE_8)
    cv2.ellipse(img, (cx, int(h * 0.50)), (30, 9), 0, 0, 180, (170, 70, 80), -1, cv2.LINE_8)     # lips
    cv2.circle(img, (int(w * 0.14), int(h * 0.78)), 46, (240, 200, 40), -1, cv2.LINE_8)          # near object
    cv2.rectangle(img, (int(w * 0.80), int(h * 0.15)), (int(w * 0.93), int(h * 0.45)), (200, 60, 60), -1)  # far block
    return img


def _png(rgb: np.ndarray) -> bytes:
    out = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(out, format="PNG", compress_level=6)
    return out.getvalue()


def _jpeg(rgb: np.ndarray, quality: int = 95) -> bytes:
    out = io.BytesIO()
    Image.fromarray(rgb, mode="RGB").save(out, format="JPEG", quality=quality, subsampling=0)
    return out.getvalue()


def _decode(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as im:
        return np.array(im.convert("RGB"), dtype=np.uint8)


def _mask(w: int, h: int, box: tuple[int, int, int, int], shape: str) -> np.ndarray:
    m = np.zeros((h, w), dtype=np.uint8)
    x, y, bw, bh = box
    if shape == "ellipse":
        cv2.ellipse(m, (x + bw // 2, y + bh // 2), (max(1, bw // 2), max(1, bh // 2)), 0, 0, 360, 255, -1)
    else:
        m[y:y + bh, x:x + bw] = 255
    return m


def _mask_png(mask: np.ndarray) -> bytes:
    out = io.BytesIO()
    Image.fromarray(mask, mode="L").save(out, format="PNG")
    return out.getvalue()


# --------------------------------------------------------------------------- golden plumbing
def _digest(rgb: np.ndarray) -> str:
    """sha256 over (shape + raw RGB bytes), truncated to 16 hex chars."""
    h, w, c = rgb.shape
    return hashlib.sha256(f"{h}x{w}x{c}:".encode() + np.ascontiguousarray(rgb).tobytes()).hexdigest()[:HASH_LEN]


def _file_digest(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()[:HASH_LEN]


def _env_meta() -> dict[str, str]:
    from backend.app.config import MODEL_PATH, PORTRAIT_MODEL_PATH

    def v(pkg: str) -> str:
        try:
            return version(pkg)
        except PackageNotFoundError:
            return "missing"

    return {
        "onnxruntime": v("onnxruntime"), "numpy": v("numpy"), "opencv": v("opencv-python-headless"),
        "pillow": v("Pillow"),
        "lama_model": _file_digest(MODEL_PATH), "portrait_model": _file_digest(PORTRAIT_MODEL_PATH),
    }


def _flag(name: str) -> bool:
    return os.environ.get(name) == "1"


def _load_golden() -> dict:
    if not GOLDEN_PATH.is_file():
        return {}
    return json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))


def _all_keys() -> set[str]:
    return ({f"erase/{p.values[0]}" for p in ERASE_CASES} | {f"portrait/{p.values[0]}" for p in PORTRAIT_CASES})


def _check_golden(key: str, rgb: np.ndarray) -> None:
    digest = _digest(rgb)
    if _flag("UPDATE_GOLDEN"):
        golden = _load_golden()
        golden[key] = digest
        golden["_meta"] = _env_meta()
        GOLDEN_PATH.write_text(json.dumps(dict(sorted(golden.items())), indent=2) + "\n", encoding="utf-8")
        return
    golden = _load_golden()
    expected = golden.get(key)
    if expected is None:
        msg = f"no golden hash for '{key}' in {GOLDEN_PATH.name} (got {digest}); run UPDATE_GOLDEN=1 pytest tests/backend"
        if _flag("REQUIRE_GOLDEN"):
            pytest.fail(msg)
        pytest.skip(msg)
    if digest != expected:
        now, then = _env_meta(), golden.get("_meta", {})
        drift = {k: (then.get(k), now[k]) for k in now if then.get(k) != now[k]}
        hint = (f"environment differs from the one golden.json was made with: {drift}" if drift
                else "environment is identical => the pipeline output really changed")
        pytest.fail(f"golden mismatch for '{key}': expected {expected}, got {digest}. {hint}")


# --------------------------------------------------------------------------- tests
def test_scene_is_deterministic_and_nontrivial():
    a, b = _scene(), _scene()
    assert a.shape == (SCENE_H, SCENE_W, 3) and a.dtype == np.uint8
    assert np.array_equal(a, b)
    assert len(np.unique(a.reshape(-1, 3), axis=0)) > 500        # real texture, not a flat fill
    # Pinned: protects the golden INPUT itself (a changed generator would otherwise look like a pipeline change).
    assert _digest(a) == _SCENE_DIGEST, f"synthetic scene changed: {_digest(a)}"


@pytest.mark.parametrize("name,box,shape", ERASE_CASES)
def test_erase(lama, name, box, shape):
    scene = _scene()
    mask = _mask(SCENE_W, SCENE_H, box, shape)
    png, _timer = lama.erase_profiled(_png(scene), _mask_png(mask))
    result = _decode(png)
    assert result.shape == scene.shape

    # Sanity first, so a golden can never be recorded from garbage output.
    hole = mask > 127
    assert (result[hole] != scene[hole]).any(), "hole pixels were not replaced"
    far = cv2.dilate(hole.astype(np.uint8), np.ones((81, 81), np.uint8)) == 0     # >40 px from the hole
    assert np.array_equal(result[far], scene[far]), "pixels far from the hole must stay byte-identical"

    _check_golden(f"erase/{name}", result)


def test_erase_empty_mask_is_identity(lama):
    scene = _scene()
    png, _ = lama.erase_profiled(_png(scene), _mask_png(np.zeros((SCENE_H, SCENE_W), np.uint8)))
    assert np.array_equal(_decode(png), scene)


def test_erase_is_deterministic_in_process(lama):
    scene, mask = _scene(), _mask_png(_mask(SCENE_W, SCENE_H, (300, 220, 40, 30), "rect"))
    first = lama.erase_profiled(_png(scene), mask)[0]
    assert first == lama.erase_profiled(_png(scene), mask)[0]


@pytest.mark.parametrize("name,blur,skin,focus", PORTRAIT_CASES)
def test_portrait(portrait, name, blur, skin, focus):
    scene = _scene()
    data, media_type = portrait.blur_background(_jpeg(scene), blur, focus[0], focus[1], skin)
    assert media_type == "image/png"                        # V24/G9: lossless - no second JPEG generation
    result = _decode(data)
    assert result.shape == scene.shape

    reference = _decode(_jpeg(scene))                       # what the server sees after JPEG decode
    diff = np.abs(result.astype(np.int16) - reference.astype(np.int16)).mean()
    if blur == 1 and skin == 0:
        assert np.array_equal(result, reference), "level 1 / skin 0 must return the decoded photo bit-for-bit"
    else:
        assert diff > 0.05, "blur/skin settings had no visible effect"

    _check_golden(f"portrait/{name}", result)


def test_portrait_is_deterministic_in_process(portrait):
    data = _jpeg(_scene())
    first = portrait.blur_background(data, 12, 0.5, 0.5, 30)[0]
    assert first == portrait.blur_background(data, 12, 0.5, 0.5, 30)[0]


def test_golden_file_is_complete_and_has_no_stale_keys():
    """Strict mode only: golden.json must cover EXACTLY the parameterised cases (no silently-skipped checks)."""
    if not _flag("REQUIRE_GOLDEN"):
        pytest.skip("only enforced with REQUIRE_GOLDEN=1")
    golden = {k for k in _load_golden() if k != "_meta"}
    assert golden == _all_keys(), f"missing: {sorted(_all_keys() - golden)}  stale: {sorted(golden - _all_keys())}"


_SCENE_DIGEST = "579e6f9f41dadcb7"
