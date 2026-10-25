"""The ONE place where untrusted upload bytes are handed to Pillow.

Pillow ships ~45 format plugins. Left to auto-detect, an upload is offered to all of them - including formats nobody asked
for (EPS, which can shell out to Ghostscript; TIFF / PSD / ICO / DDS / ... with their own parser attack surface). This module
makes the policy explicit and enforces it in one function:

1. **Format allow-list** - ``Image.open(..., formats=ALLOWED_IMAGE_FORMATS)``: only the JPEG, PNG and WebP plugins are even
   tried, so every other format answers "not a valid image" without its parser ever running.
2. **Header-only pixel limit** - ``Image.open`` reads just the header; width x height is checked against ``max_pixels`` right
   here, BEFORE ``load()`` / ``convert()`` / ``draft()`` can allocate a single pixel. Pillow's own decompression-bomb guard is
   aligned with the configured limits and its error is mapped to the same clean rejection.

Every decode path (``main._reject_if_huge``, ``LamaInpainter._decode_image``, ``DepthPortrait._decode``) goes through
``open_image``; ``tests/backend/test_image_formats.py`` fails if a bare ``Image.open`` appears anywhere else in ``backend/app``.
Both exception types are ``ValueError`` subclasses, so the existing ``except ValueError`` -> HTTP 400 handling keeps working.
"""

from __future__ import annotations

import io

from PIL import Image, ImageFile, UnidentifiedImageError

from backend.app.config import ERASE_MAX_PIXELS, PORTRAIT_MAX_PIXELS

# Pillow format ids handed to Image.open(formats=...). Matching is case-insensitive inside Pillow ("WebP" == "WEBP").
ALLOWED_IMAGE_FORMATS: list[str] = ["JPEG", "PNG", "WebP"]
FORMATS_HINT = "JPEG, PNG or WebP"

# What ``image.format`` may report AFTER a successful open. "MPO" is not a separate decoder: the JPEG plugin returns an MPO
# object for a JPEG that carries a Multi-Picture header (common for phone cameras), so it is the SAME JPEG parser and must
# be accepted, or real phone photos would be refused.
ACCEPTED_FORMAT_IDS = frozenset({"JPEG", "MPO", "PNG", "WEBP"})

# Pillow's decompression-bomb guard: warns above this many pixels, raises above twice this. Align it with our own limits
# (ours trigger first) instead of the library default, and never accept truncated files.
Image.MAX_IMAGE_PIXELS = max(ERASE_MAX_PIXELS, PORTRAIT_MAX_PIXELS)
ImageFile.LOAD_TRUNCATED_IMAGES = False


class UnsupportedImageError(ValueError):
    """Not a JPEG / PNG / WebP image (unknown, corrupt, empty or a disallowed format)."""


class ImageTooLargeError(ValueError):
    """Decoded size above the pixel limit (``width``/``height`` are 0 when only Pillow's bomb guard fired)."""

    def __init__(self, what: str, width: int, height: int, limit: int) -> None:
        self.width, self.height, self.limit = width, height, limit
        if width and height:
            message = (f"{what} is too large ({width}x{height}, {width * height / 1e6:.1f} megapixels); "
                       f"the limit is {limit / 1e6:g} megapixels")
        else:
            message = f"{what} is too large to process (limit {limit / 1e6:g} megapixels)"
        super().__init__(message)


def open_image(data: bytes, max_pixels: int | None = None, what: str = "image") -> Image.Image:
    """Open ``data`` lazily (header only) after enforcing the format allow-list and the pixel limit.

    Returns a Pillow image that has NOT been decoded yet; the caller owns it (use ``with open_image(...) as im``).
    Raises ``UnsupportedImageError`` / ``ImageTooLargeError`` (both ``ValueError``); ``what`` names the upload in the message
    ("Image", "Mask", "image" ...). ``max_pixels`` of ``None`` / 0 skips the pixel limit (format check still applies).
    """
    unsupported = f"{what} is not a valid image ({FORMATS_HINT} only)"
    if not data:
        raise UnsupportedImageError(unsupported)
    try:
        image = Image.open(io.BytesIO(data), formats=ALLOWED_IMAGE_FORMATS)
    except Image.DecompressionBombError as exc:
        raise ImageTooLargeError(what, 0, 0, max_pixels or Image.MAX_IMAGE_PIXELS) from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, EOFError, TypeError, IndexError) as exc:
        raise UnsupportedImageError(unsupported) from exc
    try:
        width, height = image.size
        if image.format not in ACCEPTED_FORMAT_IDS or width <= 0 or height <= 0:
            raise UnsupportedImageError(unsupported)
        if max_pixels and width * height > max_pixels:
            raise ImageTooLargeError(what, width, height, max_pixels)
    except ValueError:
        image.close()
        raise
    return image
