"""The /api/erase result is a LOSSLESS PNG whose size is no longer "stored" (uncompressed).

No model needed: ``erase_profiled`` is driven with a stub in place of the ONNX session, so the whole real pipeline (decode, crop, blend,
encode) runs. The golden-pixel suites already prove the pixels; this file pins the wire format and the size policy.
"""
from __future__ import annotations

import io
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

from backend.app import lama
from backend.app.config import MODEL_SIZE
from backend.app.lama import LamaInpainter

ROOT = Path(__file__).resolve().parents[2]


def _scene(w: int = 1024, h: int = 768) -> np.ndarray:
    """Photo-like: smooth gradients + mild noise (so it neither compresses to nothing nor stays incompressible)."""
    rng = np.random.default_rng(7)
    yy, xx = np.mgrid[0:h, 0:w]
    base = np.stack([60 + xx * 120 // w, 90 + yy * 100 // h, 140 - xx * 50 // w], axis=-1).astype(np.float32)
    return np.clip(base + rng.normal(0, 2.0, base.shape), 0, 255).astype(np.uint8)


def _png(arr: np.ndarray, mode: str = "RGB") -> bytes:
    out = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(out, format="PNG", compress_level=1)
    return out.getvalue()


def _decode(data: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(data)) as im:
        assert im.format == "PNG"
        return np.array(im.convert("RGB"))


def _stub_inpainter() -> LamaInpainter:
    inpainter = object.__new__(LamaInpainter)          # skip __init__: it loads the ONNX model
    inpainter.threads, inpainter.provider = 1, "cpu"
    inpainter._run = lambda image, mask: [np.full((1, 3, MODEL_SIZE, MODEL_SIZE), 128.0, np.float32)]   # 0..255 range, like the bundled export
    return inpainter


def test_every_compress_level_is_lossless_and_level_zero_is_the_biggest():
    scene = _scene()
    sizes = {}
    for level in (0, 1, 6, 9):
        data = LamaInpainter._encode_png(scene, level)
        assert np.array_equal(_decode(data), scene), f"level {level} changed pixels"
        sizes[level] = len(data)
    assert sizes[0] >= scene.nbytes                          # stored deflate = the old behaviour
    assert sizes[1] < sizes[0] * 0.85, sizes                 # level 1 already removes most of the redundancy
    assert sizes[9] <= sizes[1], sizes


def test_out_of_range_levels_are_clamped_not_fatal():
    scene = _scene(64, 48)
    for level in (-5, 99):
        assert np.array_equal(_decode(LamaInpainter._encode_png(scene, level)), scene)


def test_default_level_comes_from_the_configured_constant(monkeypatch):
    scene = _scene(256, 192)
    monkeypatch.setattr(lama, "ERASE_PNG_COMPRESS_LEVEL", 0)
    stored = len(LamaInpainter._encode_png(scene))
    monkeypatch.setattr(lama, "ERASE_PNG_COMPRESS_LEVEL", 1)
    deflated = len(LamaInpainter._encode_png(scene))
    assert stored >= scene.nbytes and deflated < stored


def test_the_default_is_a_real_compression_level():
    from backend.app.config import ERASE_PNG_COMPRESS_LEVEL
    assert 1 <= ERASE_PNG_COMPRESS_LEVEL <= 9                # the old hard-coded 0 must not come back by accident


def test_erase_pipeline_returns_a_compressed_lossless_png_and_leaves_the_rest_of_the_photo_alone():
    scene = _scene()
    mask = np.zeros(scene.shape[:2], np.uint8)
    mask[300:360, 400:480] = 255
    png, timer = _stub_inpainter().erase_profiled(_png(scene), _png(mask, "L"))
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    result = _decode(png)
    assert result.shape == scene.shape
    assert len(png) < scene.nbytes * 0.85                    # was ~= scene.nbytes (+ headers) with compress_level=0
    assert not np.array_equal(result[300:360, 400:480], scene[300:360, 400:480])      # the hole was filled
    assert np.array_equal(result[:200], scene[:200]) and np.array_equal(result[:, :200], scene[:, :200])   # far away: bit-identical
    assert [name.split(" ")[0] for name, _ in timer.steps][-1] == "F"                  # the encode step is still timed (Server-Timing)


def test_empty_mask_returns_the_photo_unchanged_in_a_compressed_png():
    scene = _scene(512, 384)
    png, _ = _stub_inpainter().erase_profiled(_png(scene), _png(np.zeros(scene.shape[:2], np.uint8), "L"))
    assert np.array_equal(_decode(png), scene) and len(png) < scene.nbytes * 0.85


def _level_with_env(value: str | None) -> int:
    env = {k: v for k, v in os.environ.items() if k != "ERASE_PNG_COMPRESS_LEVEL"}
    if value is not None:
        env["ERASE_PNG_COMPRESS_LEVEL"] = value
    out = subprocess.run([sys.executable, "-c", "from backend.app.config import ERASE_PNG_COMPRESS_LEVEL as v; print(v)"],
                         cwd=ROOT, env=env, capture_output=True, text=True, check=True)
    return int(out.stdout.strip())


def test_env_override_is_parsed_defensively():
    assert _level_with_env(None) == 1
    assert _level_with_env("0") == 0                         # explicit opt-out for LAN / localhost
    assert _level_with_env("6") == 6
    assert _level_with_env("99") == 9 and _level_with_env("-4") == 0
    assert _level_with_env("abc") == 1 and _level_with_env("") == 1
