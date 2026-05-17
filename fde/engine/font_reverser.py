"""Font Reverser (Solution B): main glyph-to-character mapping engine.

Takes a woff2/ttf byte stream, extracts glyph contours, and matches
them against the reference library via exact hash lookup and FAISS KNN.

Accuracy target (PRD §4.1):
    - Clean (no perturbation): ≥ 97% exact match
    - ±3 units perturbation:   ≥ 85% exact+KNN combined
"""

import logging
from io import BytesIO

from fontTools.ttLib import TTFont

from engine.faiss_index import (
    FAISSHashIndex,
    PER_POINT_DIST_THRESHOLD,
    IVF_BRUTE_FORCE_FALLBACK,
    distance_to_confidence,
)
from engine.glyph_normalizer import (
    extract_raw_coordinates,
    normalize_glyph,
    coords_to_vector,
)

logger = logging.getLogger(__name__)

# Maximum woff2 font file size (prevent decompression bombs)
MAX_WOFF2_SIZE = 5 * 1024 * 1024  # 5 MB


class FontReverser:
    """Solution B: build cmap → character mapping from obfuscated font."""

    def __init__(
        self,
        faiss_index: FAISSHashIndex,
        tolerance: float = 1.0,
    ):
        self._index = faiss_index
        self._tolerance = tolerance

    def build_mapping(self, woff2_bytes: bytes) -> dict[int, dict]:
        """Build a mapping from obfuscated codepoints to real characters.

        For each glyph in the font:
        1. Exact MD5 hash match → confidence 1.0
        2. FAISS KNN → accept if per-point distance < 2.5
        3. Brute-force fallback → if KNN distance >= 5.0

        Args:
            woff2_bytes: Raw woff2/ttf font file bytes.

        Returns:
            {unicode_codepoint: {"char": str, "method": "exact"|"knn"|"knn_bf",
                                 "score": float}}

        Raises:
            ValueError: If font file exceeds MAX_WOFF2_SIZE.
        """
        if len(woff2_bytes) > MAX_WOFF2_SIZE:
            raise ValueError(
                f"Font file too large: {len(woff2_bytes)} bytes "
                f"(max {MAX_WOFF2_SIZE})"
            )

        try:
            font = TTFont(BytesIO(woff2_bytes))
        except Exception as e:
            logger.warning("Failed to parse font: %s", e)
            return {}

        cmap = font.getBestCmap()
        if not cmap:
            logger.warning("No cmap table found in font")
            return {}

        mapping: dict[int, dict] = {}
        stats = {"exact": 0, "knn": 0, "knn_bf": 0, "miss": 0}

        # Only process CJK codepoints (simplify: U+2E80 - U+2FDF, U+3000-U+9FFF)
        cjk_codepoints = [
            cp
            for cp in cmap
            if (0x2E80 <= cp <= 0x2FDF)
            or (0x3000 <= cp <= 0x9FFF)
            or (0xFF00 <= cp <= 0xFFEF)
        ]

        for codepoint in cjk_codepoints:
            glyph_name = cmap[codepoint]

            try:
                raw_coords = extract_raw_coordinates(font, glyph_name)
            except Exception:
                logger.debug(
                    "Failed to extract coords for U+%04X (%s)", codepoint, glyph_name
                )
                stats["miss"] += 1
                continue

            if not raw_coords:
                stats["miss"] += 1
                continue

            contour = normalize_glyph(raw_coords, self._tolerance)

            # 1. Exact hash match
            matched = self._index.exact_match(contour.hash)
            if matched:
                mapping[codepoint] = {
                    "char": matched,
                    "method": "exact",
                    "score": 1.0,
                }
                stats["exact"] += 1
                continue

            # 2. FAISS KNN
            vector = coords_to_vector(contour.coords)
            candidates = self._index.knn_search(vector, k=3)

            if candidates:
                best_char, faiss_dist = candidates[0]
                n_points = len(contour.coords)
                pp_dist = FAISSHashIndex.per_point_distance(faiss_dist, n_points)

                if pp_dist < PER_POINT_DIST_THRESHOLD:
                    score = distance_to_confidence(pp_dist)
                    mapping[codepoint] = {
                        "char": best_char,
                        "method": "knn",
                        "score": score,
                    }
                    stats["knn"] += 1
                    continue

                # 3. Brute-force fallback
                if pp_dist >= IVF_BRUTE_FORCE_FALLBACK:
                    bf_result = self._index.brute_force_search(vector)
                    if bf_result:
                        bf_char, bf_dist = bf_result
                        bf_pp_dist = FAISSHashIndex.per_point_distance(
                            bf_dist, n_points
                        )
                        if bf_pp_dist < PER_POINT_DIST_THRESHOLD:
                            score = distance_to_confidence(bf_pp_dist)
                            mapping[codepoint] = {
                                "char": bf_char,
                                "method": "knn_bf",
                                "score": score,
                            }
                            stats["knn_bf"] += 1
                            continue

            stats["miss"] += 1

        total = sum(stats.values())
        if total > 0:
            exact_rate = stats["exact"] / total * 100
            combined_rate = (stats["exact"] + stats["knn"] + stats["knn_bf"]) / total * 100
            logger.info(
                "FontReverser: %d CJK glyphs → exact=%.1f%% combined=%.1f%% "
                "(exact=%d knn=%d knn_bf=%d miss=%d)",
                total, exact_rate, combined_rate,
                stats["exact"], stats["knn"], stats["knn_bf"], stats["miss"],
            )
        else:
            logger.warning("FontReverser: no CJK glyphs found in font")

        return mapping
