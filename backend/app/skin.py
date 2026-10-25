"""iPhone-style natural skin smoothing for the Portrait pipeline.

Goal: even out blemishes and rough tone on skin while keeping real skin texture,
so the result looks like a good camera app and not like a plastic filter.

Pipeline (all in float32, analysed at <= WORK_SIZE px, applied at full resolution)
    1. Skin probability  - an adaptive colour model learned from each detected face
                           (OpenCV Haar cascades, no extra model download), or a
                           generic YCrCb skin prior when no face is found.
    2. Region gate       - soft face / neck ellipses from the detector; without a
                           face, the portrait subject mask from the depth pipeline.
    3. Feature guard     - eyes, eyebrows, nostrils and hair (dark detail), lips
                           (strong red/magenta), and every strong edge are carved
                           out of the mask so they stay perfectly sharp.
    4. Smoothing         - frequency separation in Lab:
                           * L : two-scale guided filter removes blemishes, then a
                                 share of the fine texture is added back (pores
                                 survive, so the skin does not look plastic).
                           * a/b: a wider guided filter evens out redness and
                                 blotchy tone without touching luminance detail.
                           * a faint soft-focus glow gives the "beauty" warmth.
    5. Apply             - only the *difference* (smoothed - original) is upsampled
                           and added to the full-resolution photo, weighted by the
                           mask, so un-masked pixels stay byte-identical.

``smooth_skin`` never raises for ordinary input; callers still wrap it so that a
failure falls back to the untouched photo instead of failing the request.
"""

from __future__ import annotations

import logging
import threading
from typing import List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger("yofilter.skin")

WORK_SIZE = 1600.0          # longest side used for analysis / smoothing
_FACE_DETECT_SIZE = 720.0   # longest side used for Haar face detection

_cascade_lock = threading.Lock()
_cascades: dict = {}


# ----------------------------------------------------------------- small helpers
def _smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / max(edge1 - edge0, 1e-6), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _box(x: np.ndarray, r: int) -> np.ndarray:
    return cv2.boxFilter(x, -1, (2 * r + 1, 2 * r + 1), borderType=cv2.BORDER_REFLECT)


def _guided(guide: np.ndarray, src: np.ndarray, r: int, eps: float) -> np.ndarray:
    """Single-channel guided filter (He et al.): smooths ``src`` but never across edges of ``guide``."""
    r = max(1, int(r))
    mean_i = _box(guide, r)
    mean_p = _box(src, r)
    cov = _box(guide * src, r) - mean_i * mean_p
    var = _box(guide * guide, r) - mean_i * mean_i
    a = cov / (var + eps)
    b = mean_p - a * mean_i
    return _box(a, r) * guide + _box(b, r)


def _gauss(x: np.ndarray, sigma: float) -> np.ndarray:
    return cv2.GaussianBlur(x, (0, 0), max(0.3, float(sigma)))


# ------------------------------------------------------------------ face finding
def _load_cascade(name: str) -> Optional[cv2.CascadeClassifier]:
    if name in _cascades:
        return _cascades[name]
    classifier = None
    try:
        path = cv2.data.haarcascades + name
        candidate = cv2.CascadeClassifier(path)
        if not candidate.empty():
            classifier = candidate
        else:
            logger.warning("[skin] Haar cascade %s could not be loaded; falling back to colour-only skin detection", name)
    except Exception:                                          # cv2.data missing in exotic builds
        logger.warning("[skin] Haar cascade %s is unavailable", name, exc_info=True)
    _cascades[name] = classifier
    return classifier


def _iou(a: Tuple[int, int, int, int], b: Tuple[int, int, int, int]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    ix = max(0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0, min(ay + ah, by + bh) - max(ay, by))
    inter = ix * iy
    union = aw * ah + bw * bh - inter
    return inter / union if union > 0 else 0.0


def _find_faces(gray: np.ndarray) -> List[Tuple[int, int, int, int]]:
    """Face boxes (x, y, w, h) in the pixel space of ``gray``. Empty list when none / detector unavailable."""
    height, width = gray.shape
    scale = min(1.0, _FACE_DETECT_SIZE / max(height, width))
    small = cv2.resize(gray, (max(1, int(width * scale)), max(1, int(height * scale))), interpolation=cv2.INTER_AREA) \
        if scale < 1.0 else gray
    small = cv2.equalizeHist(small)
    min_side = max(24, int(min(small.shape) * 0.06))
    found: List[Tuple[int, int, int, int]] = []
    with _cascade_lock:
        frontal = _load_cascade("haarcascade_frontalface_alt2.xml")
        profile = _load_cascade("haarcascade_profileface.xml")
        try:
            if frontal is not None:
                for box in frontal.detectMultiScale(small, 1.1, 5, minSize=(min_side, min_side)):
                    found.append(tuple(int(v) for v in box))
            if profile is not None:
                flipped = cv2.flip(small, 1)
                candidates = [tuple(int(v) for v in b) for b in profile.detectMultiScale(small, 1.1, 6, minSize=(min_side, min_side))]
                candidates += [(small.shape[1] - x - w, y, w, h)
                               for x, y, w, h in (tuple(int(v) for v in b)
                                                  for b in profile.detectMultiScale(flipped, 1.1, 6, minSize=(min_side, min_side)))]
                for box in candidates:
                    if all(_iou(box, other) < 0.2 for other in found):
                        found.append(box)
        except cv2.error:
            logger.warning("[skin] face detection failed", exc_info=True)
            return []
    inv = 1.0 / scale
    return [(int(x * inv), int(y * inv), int(w * inv), int(h * inv)) for x, y, w, h in found]


# --------------------------------------------------------------- skin + regions
def _skin_prior(ycc: np.ndarray) -> np.ndarray:
    """Generic, deliberately wide YCrCb skin prior (covers light to dark skin tones), 0..1."""
    y = ycc[..., 0].astype(np.float32)
    cr = ycc[..., 1].astype(np.float32)
    cb = ycc[..., 2].astype(np.float32)
    prior = (_smoothstep(128, 136, cr) * (1.0 - _smoothstep(172, 180, cr))
             * _smoothstep(72, 82, cb) * (1.0 - _smoothstep(126, 134, cb))
             * _smoothstep(30, 65, y))
    return prior.astype(np.float32)


def _face_regions(shape: Tuple[int, int], faces: List[Tuple[int, int, int, int]]) -> np.ndarray:
    """Soft 0..1 map of face (weight 1) and neck (weight ~0.75) ellipses."""
    height, width = shape
    region = np.zeros((height, width), np.float32)
    for x, y, w, h in faces:
        cx = x + w / 2.0
        face = np.zeros_like(region)
        cv2.ellipse(face, (int(cx), int(y + 0.46 * h)), (max(1, int(0.60 * w)), max(1, int(0.80 * h))), 0, 0, 360, 1.0, -1)
        neck = np.zeros_like(region)
        cv2.ellipse(neck, (int(cx), int(y + 1.12 * h)), (max(1, int(0.46 * w)), max(1, int(0.50 * h))), 0, 0, 360, 0.75, -1)
        region = np.maximum(region, np.maximum(face, neck))
    return _gauss(region, max(1.0, 0.05 * max((f[2] for f in faces), default=40)))


def _mouth_zone(shape: Tuple[int, int], faces: List[Tuple[int, int, int, int]]) -> np.ndarray:
    """Soft 0..1 map of where the mouth is for each detected face (lower-centre of the box)."""
    height, width = shape
    zone = np.zeros((height, width), np.float32)
    for x, y, w, h in faces:
        cv2.ellipse(zone, (int(x + w / 2.0), int(y + 0.80 * h)), (max(1, int(0.40 * w)), max(1, int(0.20 * h))), 0, 0, 360, 1.0, -1)
    return _gauss(zone, max(1.0, 0.04 * max((f[2] for f in faces), default=40)))


def _adaptive_skin(ycc: np.ndarray, prior: np.ndarray, faces: List[Tuple[int, int, int, int]]) -> np.ndarray:
    """Skin probability from a Cb/Cr Gaussian learned on each face's cheeks and forehead."""
    height, width = prior.shape
    cbcr = ycc[..., [2, 1]].astype(np.float32)
    out = np.zeros((height, width), np.float32)
    for x, y, w, h in faces:
        x0, x1 = max(0, int(x + 0.22 * w)), min(width, int(x + 0.78 * w))
        y0, y1 = max(0, int(y + 0.18 * h)), min(height, int(y + 0.85 * h))
        if x1 - x0 < 4 or y1 - y0 < 4:
            continue
        sample = cbcr[y0:y1, x0:x1].reshape(-1, 2)
        weight = prior[y0:y1, x0:x1].reshape(-1)
        sample = sample[weight > 0.5]
        if sample.shape[0] < 150:
            continue
        mean = np.median(sample, axis=0)
        cov = np.cov(sample.T) + np.eye(2, dtype=np.float32) * 3.0       # floor: never an over-tight model
        inv = np.linalg.inv(cov).astype(np.float32)
        # Evaluate only near this face (a different skin tone elsewhere gets its own model).
        ex0, ex1 = max(0, int(x - 0.9 * w)), min(width, int(x + 1.9 * w))
        ey0, ey1 = max(0, int(y - 0.7 * h)), min(height, int(y + 2.6 * h))
        diff = cbcr[ey0:ey1, ex0:ex1] - mean.astype(np.float32)
        d2 = np.einsum("...i,ij,...j->...", diff, inv, diff)
        out[ey0:ey1, ex0:ex1] = np.maximum(out[ey0:ey1, ex0:ex1], 1.0 - _smoothstep(4.0, 14.0, d2))
    return out


def _estimate_face_width(skin_weight: np.ndarray, short_side: int) -> float:
    """Face-scale guess without a detector: equivalent diameter of the biggest skin blob."""
    blob = (skin_weight > 0.5).astype(np.uint8)
    count, _, stats, _ = cv2.connectedComponentsWithStats(blob, connectivity=8)
    if count > 1:
        area = float(stats[1:, cv2.CC_STAT_AREA].max())
        width = 0.85 * float(np.sqrt(4.0 * area / np.pi))
        return float(np.clip(width, 0.06 * short_side, 0.70 * short_side))
    return 0.22 * short_side


# ------------------------------------------------------------------------ main
def smooth_skin(rgb: np.ndarray, subject: np.ndarray, strength: int) -> np.ndarray:
    """Return ``rgb`` (uint8 HxWx3) with natural skin smoothing applied.

    subject  - float HxW 0..1 portrait subject mask (1 = in focus / subject), used to
               limit smoothing when no face is detected.
    strength - 0..100 (0 returns the input untouched).
    """
    strength = int(min(max(strength, 0), 100))
    if strength <= 0 or rgb.ndim != 3 or rgb.shape[2] != 3:
        return rgb
    s = strength / 100.0
    height, width = rgb.shape[:2]

    # ---- analysis resolution
    scale = min(1.0, WORK_SIZE / max(height, width))
    size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    small = cv2.resize(rgb, size, interpolation=cv2.INTER_AREA) if scale < 1.0 else rgb
    sh, sw = small.shape[:2]
    subj = cv2.resize(subject.astype(np.float32), size, interpolation=cv2.INTER_AREA) if scale < 1.0 \
        else subject.astype(np.float32)

    gray = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY)
    ycc = cv2.cvtColor(small, cv2.COLOR_RGB2YCrCb)
    faces = _find_faces(gray)

    # ---- 1 + 2. skin probability and region gate
    prior = _skin_prior(ycc)
    subject_gate = _smoothstep(0.35, 0.9, subj)
    if faces:
        skin = np.maximum(_adaptive_skin(ycc, prior, faces) * (0.55 + 0.45 * prior), 0.0)
        # Where no face model applies (hands, an undetected second face) use the generic prior, gently.
        skin = np.maximum(skin, prior * 0.6)
        gate = np.maximum(_face_regions((sh, sw), faces), 0.45 * subject_gate)
        face_w = float(max(f[2] for f in faces))
    else:
        skin = prior
        gate = 0.9 * subject_gate
        face_w = _estimate_face_width(skin * gate, min(sh, sw))
    # Blemishes are colour outliers: close them so they count as skin (the feature guard still
    # carves out eyes, lips and hair afterwards).
    close_k = 2 * int(np.clip(round(face_w / 22.0), 2, 40)) + 1
    skin = cv2.morphologyEx(skin.astype(np.float32), cv2.MORPH_CLOSE,
                            cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (close_k, close_k)))
    w0 = np.clip(skin * gate, 0.0, 1.0).astype(np.float32)
    if float(w0.max()) < 0.05:
        return rgb                                              # no skin found: leave the photo alone

    # ---- scales (relative to the face so a selfie and a full-body shot both look right)
    r1 = int(np.clip(round(face_w / 110.0), 2, 14))
    r2 = int(np.clip(round(face_w / 30.0), 3, 48))

    # ---- Lab working copy
    rgb01 = small.astype(np.float32) / 255.0
    lab = cv2.cvtColor(rgb01, cv2.COLOR_RGB2Lab)
    L = lab[..., 0] / 100.0
    A, B = lab[..., 1], lab[..., 2]

    # ---- 3. feature guard: eyes / brows / nostrils / hair, lips, strong edges
    sigma_loc = max(4.0, 2.0 * r2)
    den = _gauss(w0, sigma_loc)
    local_l = np.where(den > 0.03, _gauss(L * w0, sigma_loc) / np.maximum(den, 1e-3), L)
    # Eyes, brows, nostrils and hair are far darker than any blemish, so only strong contrast is guarded.
    dark = _smoothstep(0.18, 0.34, local_l - L)

    ref = w0 > 0.5
    a_ref = float(np.median(A[ref])) if ref.any() else float(np.median(A))
    lips = _smoothstep(a_ref + 9.0, a_ref + 17.0, A)
    # Lips: red inside the detected mouth zone; without a face, only blobs bigger than a pimple (opening).
    if faces:
        lips = lips * _mouth_zone((sh, sw), faces)
    else:
        open_k = 2 * max(2, int(r2 * 0.7)) + 1
        lips = cv2.morphologyEx(lips, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_k, open_k)))

    soft_l = _gauss(L, 1.2)
    gx = cv2.Sobel(soft_l, cv2.CV_32F, 1, 0, ksize=3) / 8.0
    gy = cv2.Sobel(soft_l, cv2.CV_32F, 0, 1, ksize=3) / 8.0
    edge = _smoothstep(0.022, 0.07, np.sqrt(gx * gx + gy * gy))

    # Busy fine detail (hair strands, lashes, brows) has far more local contrast than skin pores.
    detail = L - _gauss(L, 1.4)
    busy = _smoothstep(0.028, 0.065, np.sqrt(np.maximum(_gauss(detail * detail, max(2.0, 1.5 * r1)), 0.0)))

    protect = np.maximum(np.maximum(np.maximum(dark, lips), edge), 0.9 * busy)
    grow = 2 * r1 + 1
    protect = cv2.dilate(protect, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (grow, grow)))
    protect = np.clip(_gauss(protect, max(0.8, 0.8 * r1)), 0.0, 1.0)

    weight = np.clip(w0 * (1.0 - protect), 0.0, 1.0)
    weight = np.clip(_guided(L, weight, 2 * r1, 1e-3), 0.0, 1.0)      # follow real edges (jaw, hairline)
    if float(weight.max()) < 0.02:
        return rgb

    # ---- 4. smoothing in Lab (frequency separation)
    eps1 = (0.020 + 0.045 * s) ** 2
    eps2 = (0.040 + 0.070 * s) ** 2
    base = _guided(L, L, r1, eps1)                              # blemish-level smoothing
    coarse = _guided(L, base, r2, eps2)                         # larger spots / uneven tone
    smooth_l = base + (coarse - base) * (0.60 * s)
    keep = 0.64 - 0.24 * s                                      # share of fine texture that survives
    out_l = smooth_l + keep * (L - base)

    eps_c = (0.06 + 0.10 * s) ** 2
    even = 0.70 + 0.30 * s
    a_s = _guided(L, A, int(round(r2 * 2.0)), eps_c)
    b_s = _guided(L, B, int(round(r2 * 2.0)), eps_c)
    out_a = A + (a_s - A) * even
    out_b = B + (b_s - B) * even

    glow = _gauss(out_l, max(2.0, 1.6 * r2))                    # faint soft-focus warmth
    out_l = out_l + (glow - out_l) * (0.18 * s)
    out_l = out_l + 0.015 * s * 4.0 * out_l * (1.0 - out_l)     # tiny mid-tone lift
    out_l = np.clip(out_l, 0.0, 1.0)

    smoothed = cv2.cvtColor(np.stack([out_l * 100.0, out_a, out_b], axis=2).astype(np.float32), cv2.COLOR_Lab2RGB)
    original = cv2.cvtColor(lab, cv2.COLOR_Lab2RGB)             # same round-trip, so rounding error cancels
    delta = (smoothed - original) * 255.0

    # ---- 5. apply at full resolution
    amount = float(s ** 0.6)
    if scale < 1.0:
        delta = cv2.resize(delta, (width, height), interpolation=cv2.INTER_LINEAR)
        weight = cv2.resize(weight, (width, height), interpolation=cv2.INTER_LINEAR)
    result = rgb.astype(np.float32) + delta * (weight * amount)[..., None]
    return np.clip(np.rint(result), 0, 255).astype(np.uint8)
