from __future__ import annotations

"""Glyph-to-image rendering for CNN classifier input.

Extracts glyph outlines from fontTools, flattens Bezier curves via
de Casteljau subdivision, draws on a PIL canvas, and binarizes via Otsu.
Output: 64x64 grayscale Image with values 0 or 255.
"""

import logging
import math

import numpy as np
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

logger = logging.getLogger(__name__)

CANVAS_SIZE = 64
TARGET_SIZE = 56  # glyph area within canvas (4px padding each side)
FLATTEN_FLATNESS = 0.5  # Bezier subdivision flatness in font units
MAX_FLATTEN_DEPTH = 8


class GlyphRenderError(Exception):
    """Raised when glyph rendering fails irrecoverably."""


def render_glyph(font: TTFont, glyph_name: str) -> Image.Image:
    """Render a single glyph to a binarized 64x64 grayscale image.

    Args:
        font: A fontTools TTFont instance.
        glyph_name: The glyph name (e.g. 'uni4E00').

    Returns:
        PIL Image, mode 'L', size 64x64, with values 0 or 255.

    Raises:
        GlyphRenderError: If the glyph cannot be rendered.
    """
    try:
        glyph_set = font.getGlyphSet()
        glyph = glyph_set[glyph_name]
    except Exception as e:
        raise GlyphRenderError(f"Glyph not found: {glyph_name}") from e

    polygons = _extract_polygons(glyph)
    if not polygons:
        return Image.new("L", (CANVAS_SIZE, CANVAS_SIZE), 0)

    canvas = _draw_polygons(polygons)
    return _apply_otsu(canvas)


# --------------- Polygon extraction ---------------


def _extract_polygons(glyph) -> list[list[tuple[float, float]]]:
    """Extract closed polygon contours from a glyph via RecordingPen."""
    pen = RecordingPen()
    glyph.draw(pen)

    polygons: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []

    for operator, args in pen.value:
        if operator == "moveTo":
            if current:
                polygons.append(current)
            current = [args[0]]
        elif operator == "lineTo":
            current.append(args[0])
        elif operator == "qCurveTo":
            # Quadratic Bezier: (control, end)
            pts = _flatten_quadratic_bezier(current[-1], args[0], args[1])
            current.extend(pts[1:])
        elif operator == "curveTo":
            # Cubic Bezier: (control1, control2, end)
            pts = _flatten_cubic_bezier(current[-1], args[0], args[1], args[2])
            current.extend(pts[1:])
        elif operator == "closePath":
            if len(current) >= 2:
                polygons.append(current)
            current = []
        elif operator == "addComponent":
            # Compound glyph component — skip transform handling for now
            pass

    if len(current) >= 2:
        polygons.append(current)

    return polygons


# --------------- Bezier flattening ---------------


def _flatten_quadratic_bezier(p0, p1, p2, flatness=FLATTEN_FLATNESS, depth=0):
    """Recursive de Casteljau subdivision for quadratic Bezier curves."""
    if depth > MAX_FLATTEN_DEPTH:
        return [p0, p2]

    dx = p2[0] - p0[0]
    dy = p2[1] - p0[1]
    if abs(dx) < 1e-9 and abs(dy) < 1e-9:
        return [p0, p2]

    dist = abs(dy * p1[0] - dx * p1[1] + p2[0] * p0[1] - p2[1] * p0[0])
    dist /= math.sqrt(dx * dx + dy * dy)

    if dist <= flatness:
        return [p0, p2]

    # De Casteljau at t=0.5
    q0 = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    q1 = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    r0 = ((q0[0] + q1[0]) / 2, (q0[1] + q1[1]) / 2)

    return _flatten_quadratic_bezier(p0, q0, r0, flatness, depth + 1)[:-1] + _flatten_quadratic_bezier(r0, q1, p2, flatness, depth + 1)


def _flatten_cubic_bezier(p0, p1, p2, p3, flatness=FLATTEN_FLATNESS, depth=0):
    """Recursive de Casteljau subdivision for cubic Bezier curves."""
    if depth > MAX_FLATTEN_DEPTH:
        return [p0, p3]

    # Approximate flatness: distance of control points from chord p0-p3
    dx = p3[0] - p0[0]
    dy = p3[1] - p0[1]
    chord_len_sq = dx * dx + dy * dy

    if chord_len_sq < 1e-9:
        return [p0, p3]

    d1 = abs(dy * p1[0] - dx * p1[1] + p3[0] * p0[1] - p3[1] * p0[0]) / math.sqrt(chord_len_sq)
    d2 = abs(dy * p2[0] - dx * p2[1] + p3[0] * p0[1] - p3[1] * p0[0]) / math.sqrt(chord_len_sq)

    if max(d1, d2) <= flatness:
        return [p0, p3]

    # De Casteljau at t=0.5
    m01 = ((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2)
    m12 = ((p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2)
    m23 = ((p2[0] + p3[0]) / 2, (p2[1] + p3[1]) / 2)
    m012 = ((m01[0] + m12[0]) / 2, (m01[1] + m12[1]) / 2)
    m123 = ((m12[0] + m23[0]) / 2, (m12[1] + m23[1]) / 2)
    m = ((m012[0] + m123[0]) / 2, (m012[1] + m123[1]) / 2)

    return (_flatten_cubic_bezier(p0, m01, m012, m, flatness, depth + 1)[:-1]
            + _flatten_cubic_bezier(m, m123, m23, p3, flatness, depth + 1))


# --------------- Drawing ---------------


def _draw_polygons(polygons: list[list[tuple[float, float]]]) -> Image.Image:
    """Draw flattened polygons on a 64x64 canvas, centered and scaled."""
    # Compute bounding box
    all_x = [p[0] for poly in polygons for p in poly]
    all_y = [p[1] for poly in polygons for p in poly]
    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)

    width = max_x - min_x
    height = max_y - min_y
    if width < 1e-6 and height < 1e-6:
        return Image.new("L", (CANVAS_SIZE, CANVAS_SIZE), 0)

    # Scale to fit TARGET_SIZE preserving aspect ratio
    scale = TARGET_SIZE / max(width, height)

    # Center offset
    offset_x = (CANVAS_SIZE - width * scale) / 2 - min_x * scale
    offset_y = (CANVAS_SIZE - height * scale) / 2 - min_y * scale

    canvas = Image.new("L", (CANVAS_SIZE, CANVAS_SIZE), 0)
    draw = ImageDraw.Draw(canvas)

    for poly in polygons:
        if len(poly) < 2:
            continue
        # TrueType uses Y-up (y increases upward), PIL uses Y-down.
        # Flip Y to preserve correct glyph orientation.
        scaled = [
            (p[0] * scale + offset_x, CANVAS_SIZE - (p[1] * scale + offset_y))
            for p in poly
        ]
        draw.polygon(scaled, fill=255)

    return canvas


# --------------- Otsu binarization ---------------


def _apply_otsu(image: Image.Image) -> Image.Image:
    """Apply Otsu's thresholding to produce a clean binary image."""
    arr = np.array(image, dtype=np.float32)

    hist, _ = np.histogram(arr, bins=256, range=(0, 256))
    total = arr.size
    sum_all = np.dot(np.arange(256, dtype=np.float64), hist.astype(np.float64))

    weight_bg = 0.0
    sum_bg = 0.0
    max_var = 0.0
    threshold = 128

    for t in range(256):
        weight_bg += hist[t]
        if weight_bg == 0:
            continue
        weight_fg = total - weight_bg
        if weight_fg == 0:
            break
        sum_bg += t * hist[t]
        mean_bg = sum_bg / weight_bg
        mean_fg = (sum_all - sum_bg) / weight_fg
        var_between = weight_bg * weight_fg * (mean_bg - mean_fg) ** 2
        if var_between > max_var:
            max_var = var_between
            threshold = t

    binary = (arr > threshold).astype(np.uint8) * 255
    return Image.fromarray(binary, mode="L")
