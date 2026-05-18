from __future__ import annotations

"""Glyph contour extraction and normalization for font de-obfuscation.

Extracts TrueType glyph coordinates, normalizes them to a canonical [0,100]
coordinate space, and produces content-addressable MD5 hashes suitable for
exact-match lookup in the reference library.
"""

import hashlib
import logging
from dataclasses import dataclass

import numpy as np
from fontTools.ttLib import TTFont
from fontTools.pens.pointPen import AbstractPointPen

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class GlyphContour:
    """Normalized glyph contour representation with content hash."""

    coords: tuple[tuple[float, float, int], ...]  # (x, y, on_curve_flag)
    hash: str  # MD5 hex digest of canonical serialization


# --------------- Point pen for extracting raw coordinates ---------------


class _CoordPen(AbstractPointPen):
    """PointPen that records all contour points into a flat list."""

    def __init__(self) -> None:
        self.coords: list[tuple[float, float, int]] = []

    def beginPath(self, identifier=None) -> None:
        pass

    def endPath(self) -> None:
        pass

    def addPoint(
        self,
        pt: tuple[float, float],
        segmentType=None,
        smooth: bool = False,
        name=None,
        identifier=None,
        **kwargs,
    ) -> None:
        """Record point coordinates.

        TrueType convention: segmentType is None for off-curve control points,
        and "move"/"line"/"curve"/"qcurve" for on-curve points.
        """
        x, y = pt
        on_curve = 0 if segmentType is None else 1
        self.coords.append((round(x, 2), round(y, 2), on_curve))


# --------------- Main API ---------------


def extract_raw_coordinates(
    font: TTFont,
    glyph_name: str,
    max_depth: int = 10,
    _visited: set | None = None,
) -> list[tuple[float, float, int]]:
    """Extract all contour point coordinates from a glyph.

    Handles simple glyphs directly. For compound glyphs, recursively
    resolves component references with the given max_depth limit.
    Cycle detection via _visited prevents infinite recursion on
    malformed fonts.

    Args:
        font: A fonttools TTFont instance.
        glyph_name: The glyph name to extract.
        max_depth: Maximum recursion depth for compound glyph expansion.
        _visited: Internal set for cycle detection (do not pass).

    Returns:
        List of (x, y, on_curve_flag) tuples. x/y are in font units.
        Empty list if glyph not found.
    """
    if _visited is None:
        _visited = set()

    if glyph_name in _visited:
        logger.warning("Cycle detected: glyph '%s' references itself", glyph_name)
        return []

    if max_depth <= 0:
        logger.warning(
            "Max depth exceeded for glyph '%s', returning partial results",
            glyph_name,
        )
        return []

    _visited.add(glyph_name)

    glyf = font.get("glyf")
    if glyf is None:
        return []

    try:
        glyph = glyf[glyph_name]
    except KeyError:
        return []

    coords: list[tuple[float, float, int]] = []

    if hasattr(glyph, "numberOfContours") and glyph.numberOfContours >= 0:
        # Simple glyph: extract coordinates via PointPen
        pen = _CoordPen()
        glyph.drawPoints(pen, glyf)
        coords = pen.coords
    elif hasattr(glyph, "components"):
        # Compound glyph: recursively resolve components
        for component in glyph.components:
            sub_coords = extract_raw_coordinates(
                font,
                component.glyphName,
                max_depth - 1,
                _visited.copy(),
            )
            # Apply component transformation matrix (scale + offset)
            if hasattr(component, "transformation"):
                matrix = component.transformation
                transformed: list[tuple[float, float, int]] = []
                for x, y, flag in sub_coords:
                    nx = matrix[0] * x + matrix[2] * y + matrix[4]
                    ny = matrix[1] * x + matrix[3] * y + matrix[5]
                    transformed.append((round(nx, 2), round(ny, 2), flag))
                coords.extend(transformed)
            else:
                coords.extend(sub_coords)

    _visited.discard(glyph_name)
    return coords


def normalize_glyph(
    raw_coords: list[tuple[float, float, int]],
    tolerance: float = 1.0,
) -> GlyphContour:
    """Normalize glyph coordinates to canonical form and compute hash.

    Pipeline:
    1. Find x/y min/max range.
    2. Linear map to [0, 100] coordinate space.
    3. Quantize: round(value / tolerance) * tolerance.
       With tolerance=1.0 this is equivalent to round(value, 1),
       matching PRD §5.3. Coarser tolerance absorbs more noise
       but reduces discriminability.
    4. MD5 hash computed from compact string representation.

    Point order is preserved from the font's original contour definition.
    This ensures FAISS vector dimensions align across same-font queries.
    Cross-font matching relies on Solution C (CNN) rather than KNN.

    Args:
        raw_coords: Raw (x, y, flag) tuples from extract_raw_coordinates.
        tolerance: Quantization tolerance (default 1.0).

    Returns:
        GlyphContour with normalized coordinates and MD5 hash.
    """
    if not raw_coords:
        return GlyphContour(coords=(), hash=hashlib.md5(b"").hexdigest())

    xs = [c[0] for c in raw_coords]
    ys = [c[1] for c in raw_coords]

    x_min, x_max = min(xs), max(xs)
    y_min, y_max = min(ys), max(ys)

    x_range = x_max - x_min or 1.0
    y_range = y_max - y_min or 1.0

    normalized: list[tuple[float, float, int]] = []
    for x, y, flag in raw_coords:
        # Map to [0, 100] (no rounding yet)
        nx = ((x - x_min) / x_range) * 100.0
        ny = ((y - y_min) / y_range) * 100.0

        # Quantize: round(value / tolerance) * tolerance.
        # With tolerance=1.0 this is equivalent to round(value, 1),
        # matching PRD §5.3「坐标量化精度：round(value, 1)」.
        nx = round(nx / tolerance) * tolerance
        ny = round(ny / tolerance) * tolerance

        normalized.append((nx, ny, flag))

    # Serialize in original contour order (NOT sorted).
    # Stable ordering is critical for FAISS: perturbed glyphs keep the
    # same contour sequence, so corresponding dimensions align.
    parts = [f"{x:.1f},{y:.1f},{flag}" for x, y, flag in normalized]
    serialized = ";".join(parts).encode("utf-8")

    return GlyphContour(
        coords=tuple(normalized),
        hash=hashlib.md5(serialized).hexdigest(),
    )


def coords_to_vector(
    coords: list[tuple[float, float, int]],
    max_points: int = 512,
) -> "np.ndarray":
    """Flatten normalized coordinates into a fixed-length float vector for FAISS.

    Each coordinate yields (x, y) — the on-curve flag is dropped since
    it is often unreliable across fonts. Vectors shorter than max_points
    are zero-padded; longer vectors are truncated.
    """
    vec = np.zeros(max_points * 2, dtype=np.float32)
    for i, (x, y, _) in enumerate(coords[:max_points]):
        vec[i * 2] = x
        vec[i * 2 + 1] = y
    return vec
