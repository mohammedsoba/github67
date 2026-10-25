"""Eraser selection-size guard: the rule, its error type and its (English + Arabic) wording in ONE place.

``/api/erase`` refuses a painted selection whose bounding box is wider than ``ERASE_MAX_SELECTION_WIDTH`` pixels with an
HTTP 400. The rule is enforced inside the erase pipeline (``LamaInpainter.erase_profiled``, in a worker slot) because the
width of the *painted* area can only be known after the mask is decoded; the route maps the error to the response body built
here. The browser applies the same limit before uploading (js/editing/erase-window.js), so this is the authoritative
backstop for other clients and for a stale page.

Pure Python (no cv2 / numpy / FastAPI): importable and unit-testable anywhere. ``SelectionTooLargeError`` is a ``ValueError``,
so any caller that already maps ``ValueError`` -> 400 keeps working even if it does not know this class.
"""

from __future__ import annotations

from backend.app.config import ERASE_MAX_SELECTION_WIDTH

ERROR_CODE = "SELECTION_TOO_LARGE"      # machine-readable; the client keys its localised message on this, never on the text

# The server does not know the user's language, so the 400 text carries both. The client shows its own localised string.
MESSAGE_EN = "Selection too large. Max width is {limit}px."
MESSAGE_AR = "المنطقة المحددة كبيرة جدًا. الحد الأقصى للعرض هو {limit} بكسل."
_SEPARATOR = " | "


def message_en(limit: int = ERASE_MAX_SELECTION_WIDTH) -> str:
    return MESSAGE_EN.format(limit=int(limit))


def message_ar(limit: int = ERASE_MAX_SELECTION_WIDTH) -> str:
    return MESSAGE_AR.format(limit=int(limit))


def bilingual_message(limit: int = ERASE_MAX_SELECTION_WIDTH) -> str:
    """``English | Arabic`` - what ``detail`` carries, so a plain client (curl, an old page) still shows both languages."""
    return message_en(limit) + _SEPARATOR + message_ar(limit)


class SelectionTooLargeError(ValueError):
    """The painted selection is wider than the eraser accepts (``width`` > ``limit``, both in photo pixels)."""

    def __init__(self, width: int, limit: int = ERASE_MAX_SELECTION_WIDTH) -> None:
        self.width, self.limit = int(width), int(limit)
        super().__init__(bilingual_message(self.limit))


def check_selection_width(width: int, limit: int = ERASE_MAX_SELECTION_WIDTH) -> None:
    """Raise ``SelectionTooLargeError`` when ``width`` is above ``limit``; exactly ``limit`` is still allowed."""
    if width > limit:
        raise SelectionTooLargeError(width, limit)


def error_body(exc: SelectionTooLargeError) -> dict[str, object]:
    """JSON body of the 400. ``detail`` stays a plain string (the shape every other error of this API uses and
    ``YoApi.httpError`` reads); the extra keys let a client localise the message and show the numbers."""
    return {
        "detail": str(exc),
        "code": ERROR_CODE,
        "message_en": message_en(exc.limit),
        "message_ar": message_ar(exc.limit),
        "max_width": exc.limit,
        "width": exc.width,
    }
