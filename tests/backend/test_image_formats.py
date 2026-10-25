"""Strict decoder allow-list (JPEG / PNG / WebP) + header-only pixel limits. Pure Pillow tests: no models, no FastAPI."""
from __future__ import annotations

import io
import pathlib
import re

import numpy as np
import pytest
from PIL import Image, ImageFile

from backend.app import imaging
from backend.app.imaging import ImageTooLargeError, UnsupportedImageError, open_image


def _save(fmt: str, size=(32, 24), mode="RGB", **kw) -> bytes:
    buf = io.BytesIO()
    Image.new(mode, size, 128 if mode in ("L", "P", "1") else (10, 120, 200)).save(buf, fmt, **kw)
    return buf.getvalue()


@pytest.mark.parametrize("fmt,mode", [("JPEG", "RGB"), ("PNG", "RGB"), ("PNG", "RGBA"), ("PNG", "L"), ("WEBP", "RGB"), ("WEBP", "RGBA")])
def test_allowed_formats_open(fmt, mode):
    with open_image(_save(fmt, mode=mode), 10_000) as im:
        assert im.size == (32, 24)


def test_mpo_phone_photo_is_still_accepted():
    """A JPEG with a Multi-Picture header is returned by the JPEG plugin as format 'MPO' - same parser, must not be refused."""
    a = Image.new("RGB", (32, 24), (1, 2, 3))
    buf = io.BytesIO()
    a.save(buf, "MPO", save_all=True, append_images=[Image.new("RGB", (32, 24), (9, 9, 9))])
    with open_image(buf.getvalue(), 10_000) as im:
        assert im.format in ("MPO", "JPEG") and im.size == (32, 24)


def _eps() -> bytes:
    return b"%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n%%EndComments\nshowpage\n"


@pytest.mark.parametrize("name,data", [
    ("gif", _save("GIF", mode="P")),
    ("bmp", _save("BMP")),
    ("tiff", _save("TIFF")),
    ("ico", _save("ICO", size=(16, 16))),
    ("ppm", _save("PPM")),
    ("tga", _save("TGA")),
    ("eps", _eps()),
    ("svg", b"<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/>"),
    ("garbage", b"garbage"),
    ("empty", b""),
    ("truncated-jpeg-header", _save("JPEG")[:6]),
])
def test_disallowed_or_broken_data_is_rejected_without_a_decoder_for_it(name, data):
    with pytest.raises(UnsupportedImageError, match="not a valid image"):
        open_image(data, 10_000_000, "Image")


def test_disallowed_format_parsers_never_run(monkeypatch):
    """The BMP / GIF / TIFF / EPS plugins' ``_open`` must not even be called when formats= is enforced."""
    from PIL import BmpImagePlugin, EpsImagePlugin, GifImagePlugin, TiffImagePlugin
    def boom(self):
        raise AssertionError("a disallowed plugin parsed the upload")
    for cls in (BmpImagePlugin.BmpImageFile, GifImagePlugin.GifImageFile, TiffImagePlugin.TiffImageFile, EpsImagePlugin.EpsImageFile):
        monkeypatch.setattr(cls, "_open", boom)
    for data in (_save("BMP"), _save("GIF", mode="P"), _save("TIFF"), _eps()):
        with pytest.raises(UnsupportedImageError):
            open_image(data, 10_000_000)


def test_pixel_limit_is_header_only_and_runs_before_any_decode(monkeypatch):
    def boom(self, *a, **k):
        raise AssertionError("pixels were decoded before the size check")
    monkeypatch.setattr(ImageFile.ImageFile, "load", boom)
    monkeypatch.setattr(Image.Image, "convert", boom)
    data = _save("PNG", size=(300, 200))
    with pytest.raises(ImageTooLargeError, match="too large") as err:
        open_image(data, 50_000, "Image")
    assert (err.value.width, err.value.height) == (300, 200) and "megapixels" in str(err.value)
    open_image(data, 60_000).close()                      # exactly at / under the limit passes (and still decodes nothing)


def test_pillow_bomb_guard_maps_to_the_same_rejection(monkeypatch):
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1_000)
    with pytest.raises(ImageTooLargeError, match="too large"):
        open_image(_save("PNG", size=(200, 200), mode="1"), 500)


def test_truncated_files_are_not_tolerated():
    assert ImageFile.LOAD_TRUNCATED_IMAGES is False
    data = _save("PNG", size=(64, 64))
    with open_image(data[: len(data) // 2], 100_000) as im:        # header intact, pixel data cut off
        with pytest.raises(OSError):
            im.load()


def test_lama_decode_uses_the_allow_list_and_the_limit(monkeypatch):
    from backend.app import lama
    dec = lama.LamaInpainter._decode_image
    assert dec(_save("PNG"), "image", "RGB").size == (32, 24)
    with pytest.raises(ValueError, match="image is not a valid image"):
        dec(_save("GIF", mode="P"), "image", "RGB")
    with pytest.raises(ValueError, match="mask is not a valid image"):
        dec(_save("BMP"), "mask", "L")
    with pytest.raises(ValueError, match="image image is empty"):
        dec(b"", "image", "RGB")
    monkeypatch.setattr(lama, "ERASE_MAX_PIXELS", 100)
    with pytest.raises(ValueError, match="too large"):
        dec(_save("PNG"), "image", "RGB")


def test_portrait_decode_uses_the_allow_list(monkeypatch):
    from backend.app import portrait
    rgb, alpha = portrait.DepthPortrait._decode(_save("WEBP"), max_side=0)
    assert rgb.shape == (24, 32, 3) and alpha is None
    for bad in (_save("TIFF"), _save("GIF", mode="P"), _eps(), b"garbage"):
        with pytest.raises(ValueError, match="not a valid image"):
            portrait.DepthPortrait._decode(bad, max_side=0)
    monkeypatch.setattr(portrait, "PORTRAIT_MAX_PIXELS", 100)
    with pytest.raises(ValueError, match="too large"):
        portrait.DepthPortrait._decode(_save("PNG"), max_side=0)


def test_portrait_jpeg_still_uses_the_fast_draft_path():
    from backend.app import portrait
    buf = io.BytesIO()
    Image.fromarray(np.full((800, 1200, 3), 90, np.uint8)).save(buf, "JPEG")
    rgb, _ = portrait.DepthPortrait._decode(buf.getvalue(), max_side=300)
    assert max(rgb.shape[:2]) == 300


def test_no_bare_image_open_outside_imaging_module():
    """Regression guard: every decode path must go through imaging.open_image (allow-list + header-only limit)."""
    root = pathlib.Path(imaging.__file__).resolve().parent
    offenders = [f"{p.name}:{n}" for p in root.glob("*.py") if p.name != "imaging.py"
                 for n, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
                 if re.search(r"\bImage\.open\(", line) and not line.lstrip().startswith("#")]
    assert offenders == []
