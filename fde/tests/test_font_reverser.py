"""Unit tests for glyph normalizer, font resolver, and font reverser.

Run:  cd fde && python -m pytest tests/test_font_reverser.py -v
"""

import hashlib
import sys
from pathlib import Path

import pytest

# Ensure fde package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.glyph_normalizer import (
    GlyphContour,
    coords_to_vector,
    extract_raw_coordinates,
    normalize_glyph,
)


class TestGlyphNormalizer:
    """Tests for normalize_glyph and related functions."""

    def test_empty_coords_returns_empty_hash(self):
        contour = normalize_glyph([], tolerance=1.0)
        assert contour.coords == ()
        assert contour.hash == hashlib.md5(b"").hexdigest()

    def test_same_coords_same_hash(self):
        coords = [(0.0, 0.0, 1), (100.0, 0.0, 0), (100.0, 100.0, 1), (0.0, 100.0, 1)]
        c1 = normalize_glyph(coords, tolerance=1.0)
        c2 = normalize_glyph(coords, tolerance=1.0)
        assert c1.hash == c2.hash

    def test_different_coords_different_hash(self):
        """Different shapes must produce different hashes even after bbox normalization."""
        # Right triangle: corner at (100, 100)
        c1 = normalize_glyph([(0.0, 0.0, 1), (100.0, 0.0, 1), (100.0, 100.0, 1)], tolerance=1.0)
        # Different shape: corner at (100, 50) — middle point has different y
        c2 = normalize_glyph([(0.0, 0.0, 1), (100.0, 50.0, 1), (100.0, 100.0, 1)], tolerance=1.0)
        assert c1.hash != c2.hash

    def test_noise_within_tolerance_same_hash(self):
        """Small noise on font-unit-scale coords (~1000 units) quantizes away.

        Real font glyphs span ~1000+ font units. Adding ±1 unit of noise
        changes normalized [0,100] values by <0.1, which tolerance=1.0 absorbs.
        """
        # Triangle spanning 1000 font units
        coords_a = [(0.0, 0.0, 1), (1000.0, 0.0, 1), (1000.0, 1000.0, 1)]
        # Same shape with ±1 unit noise (0.1% of range)
        coords_b = [(1.0, 0.5, 1), (999.0, 0.0, 1), (1000.5, 999.5, 1)]
        c1 = normalize_glyph(coords_a, tolerance=1.0)
        c2 = normalize_glyph(coords_b, tolerance=1.0)
        assert c1.hash == c2.hash

    def test_noise_beyond_tolerance_different_hash(self):
        """Noise > tolerance should produce different quantized values."""
        coords_a = [(0.0, 0.0, 1), (100.0, 0.0, 1)]
        coords_b = [(2.0, 2.0, 1), (98.0, 0.0, 1)]  # 2.0 shift > 1.0 tolerance
        c1 = normalize_glyph(coords_a, tolerance=1.0)
        c2 = normalize_glyph(coords_b, tolerance=1.0)
        assert c1.hash != c2.hash

    def test_normalized_to_0_100_range(self):
        coords = [(10.0, 20.0, 1), (90.0, 80.0, 1)]
        contour = normalize_glyph(coords, tolerance=1.0)
        for x, y, flag in contour.coords:
            assert 0.0 <= x <= 100.0
            assert 0.0 <= y <= 100.0

    def test_contour_order_preserved(self):
        """Normalization must preserve original contour point ordering."""
        coords = [(100.0, 100.0, 1), (0.0, 100.0, 1), (0.0, 0.0, 1), (100.0, 0.0, 1)]
        contour = normalize_glyph(coords, tolerance=1.0)
        # First point should be near (100, 100) in normalized space
        assert contour.coords[0][0] == pytest.approx(100.0)
        assert contour.coords[0][1] == pytest.approx(100.0)
        # Last point should be near (100, 0)
        assert contour.coords[3][0] == pytest.approx(100.0)
        assert contour.coords[3][1] == pytest.approx(0.0)

    def test_single_point_glyph(self):
        """Single-point glyph should work (range=0 → 1.0)."""
        contour = normalize_glyph([(50.0, 50.0, 1)], tolerance=1.0)
        assert len(contour.coords) == 1

    def test_flag_preserved(self):
        coords = [(0.0, 0.0, 0), (100.0, 0.0, 1)]
        contour = normalize_glyph(coords, tolerance=1.0)
        assert contour.coords[0][2] == 0  # off-curve
        assert contour.coords[1][2] == 1  # on-curve

    def test_tolerance_2_absorbs_more_noise(self):
        """Coarser tolerance should absorb larger perturbations."""
        coords_a = [(0.0, 0.0, 1), (100.0, 0.0, 1)]
        coords_b = [(1.5, 1.5, 1), (98.5, 1.5, 1)]  # 1.5 shift
        c1 = normalize_glyph(coords_a, tolerance=2.0)
        c2 = normalize_glyph(coords_b, tolerance=2.0)
        assert c1.hash == c2.hash  # tolerance 2 absorbs 1.5 noise

    def test_coords_to_vector_padding(self):
        coords = [(10.0, 20.0, 1), (30.0, 40.0, 0)]
        vec = coords_to_vector(coords, max_points=4)
        assert len(vec) == 8  # 4 points × 2 dims
        assert vec[0] == 10.0
        assert vec[1] == 20.0
        assert vec[2] == 30.0
        assert vec[3] == 40.0
        assert vec[4] == 0.0  # padding
        assert vec[7] == 0.0  # padding

    def test_coords_to_vector_truncation(self):
        coords = [(float(i), float(i), 1) for i in range(600)]
        vec = coords_to_vector(coords, max_points=512)
        assert len(vec) == 1024
        # Last point should be 511, 511
        assert vec[1022] == 511.0
        assert vec[1023] == 511.0


class TestFontResolver:
    """Tests for multi-font mapping resolver."""

    def test_register_and_count(self):
        from engine.font_resolver import FontResolver

        resolver = FontResolver()
        resolver.register_font("zh-font-1", "http://example.com/f1.woff2", b"fake1")
        resolver.register_font("zh-font-2", "http://example.com/f2.woff2", b"fake2")
        assert resolver.font_count == 2

    def test_decode_element_uses_correct_font(self):
        from engine.font_resolver import FontResolver

        resolver = FontResolver()
        resolver.register_font("font-a", "", b"bytes_a")
        resolver.register_font("font-b", "", b"bytes_b")

        # Directly set mappings to test routing
        resolver._fonts["font-a"].mapping = {
            0x4E00: {"char": "A", "method": "exact", "score": 1.0}
        }
        resolver._fonts["font-b"].mapping = {
            0x4E00: {"char": "B", "method": "exact", "score": 1.0}
        }

        assert resolver.decode_element("一", "font-a") == "A"
        assert resolver.decode_element("一", "font-b") == "B"

    def test_decode_element_unknown_family_passthrough(self):
        from engine.font_resolver import FontResolver

        resolver = FontResolver()
        assert resolver.decode_element("一", "nonexistent") == "一"

    def test_get_merged_mapping(self):
        from engine.font_resolver import FontResolver

        resolver = FontResolver()
        resolver.register_font("f1", "", b"")
        resolver.register_font("f2", "", b"")

        resolver._fonts["f1"].mapping = {
            0x4E00: {"char": "一", "method": "exact", "score": 1.0}
        }
        resolver._fonts["f2"].mapping = {
            0x4E8C: {"char": "二", "method": "knn", "score": 0.8}
        }

        merged = resolver.get_merged_mapping()
        assert len(merged) == 2
        assert merged[0x4E00]["char"] == "一"
        assert merged[0x4E8C]["char"] == "二"

    def test_merged_mapping_first_wins_on_conflict(self):
        from engine.font_resolver import FontResolver

        resolver = FontResolver()
        resolver.register_font("f1", "", b"")
        resolver.register_font("f2", "", b"")

        resolver._fonts["f1"].mapping = {
            0x4E00: {"char": "first", "method": "exact", "score": 1.0}
        }
        resolver._fonts["f2"].mapping = {
            0x4E00: {"char": "second", "method": "exact", "score": 1.0}
        }

        merged = resolver.get_merged_mapping()
        assert merged[0x4E00]["char"] == "first"

    def test_apply_mapping_mixed_chars(self):
        from engine.font_resolver import _apply_mapping

        mapping = {
            0x4E00: {"char": "一", "method": "exact", "score": 1.0},
            0x4E8C: {"char": "二", "method": "knn", "score": 0.9},
        }
        result = _apply_mapping("一二三", mapping)
        assert result == "一二三"  # third char unmapped, passes through


class TestExtractRawCoordinates:
    """Tests for coordinate extraction from real fonts."""

    @pytest.fixture(autouse=True)
    def _check_fonts(self):
        """Skip if reference fonts are not available."""
        fonts_dir = Path(__file__).resolve().parent.parent / "data" / "reference" / "fonts"
        if not fonts_dir.exists() or not list(fonts_dir.glob("*.ttc")):
            pytest.skip("Reference fonts not available — download to data/reference/fonts/")

    def test_extract_simple_glyph(self):
        from fontTools.ttLib import TTFont

        fonts_dir = Path(__file__).resolve().parent.parent / "data" / "reference" / "fonts"
        font_path = next(fonts_dir.glob("*.ttc"), None)
        if not font_path:
            font_path = next(fonts_dir.glob("*.ttf"), None)
        if not font_path:
            pytest.skip("No font files found")

        font = TTFont(str(font_path), fontNumber=0)
        try:
            cmap = font.getBestCmap()
            # Find a common character like 一 (U+4E00)
            glyph_name = cmap.get(0x4E00)
            if glyph_name is None:
                pytest.skip("Character U+4E00 not in font")

            coords = extract_raw_coordinates(font, glyph_name)
            assert len(coords) > 0, "Should extract at least some coordinates"
        finally:
            font.close()

    def test_nonexistent_glyph_returns_empty(self):
        from fontTools.ttLib import TTFont

        fonts_dir = Path(__file__).resolve().parent.parent / "data" / "reference" / "fonts"
        font_path = next(fonts_dir.glob("*.ttc"), None)
        if not font_path:
            font_path = next(fonts_dir.glob("*.ttf"), None)
        if not font_path:
            pytest.skip("No font files found")

        font = TTFont(str(font_path), fontNumber=0)
        try:
            coords = extract_raw_coordinates(font, "nonexistent_glyph_xyz")
            assert coords == []
        finally:
            font.close()


class TestFontReverserIntegration:
    """Integration tests requiring a built reference database."""

    @pytest.fixture(autouse=True)
    def _check_db(self):
        db_path = (
            Path(__file__).resolve().parent.parent
            / "data" / "reference" / "db" / "glyphs.db"
        )
        if not db_path.exists():
            pytest.skip("Reference database not built — run scripts/build_ref_library.py first")

    def test_faiss_index_loads(self):
        from engine.faiss_index import FAISSHashIndex

        db_path = (
            Path(__file__).resolve().parent.parent
            / "data" / "reference" / "db" / "glyphs.db"
        )
        index = FAISSHashIndex(str(db_path))
        try:
            assert index.n_total > 0
        finally:
            index.close()

    def test_exact_match_on_reference_font(self):
        """Using a reference font glyph, exact_match should find it."""
        from fontTools.ttLib import TTFont

        from engine.faiss_index import FAISSHashIndex
        from engine.font_reverser import FontReverser
        from engine.glyph_normalizer import extract_raw_coordinates, normalize_glyph

        db_path = (
            Path(__file__).resolve().parent.parent
            / "data" / "reference" / "db" / "glyphs.db"
        )
        fonts_dir = Path(__file__).resolve().parent.parent / "data" / "reference" / "fonts"
        font_path = next(fonts_dir.glob("*.ttc"), None)
        if not font_path:
            font_path = next(fonts_dir.glob("*.ttf"), None)
        if not font_path:
            pytest.skip("No font files found")

        index = FAISSHashIndex(str(db_path))
        reverser = FontReverser(index)

        try:
            font = TTFont(str(font_path), fontNumber=0)
            cmap = font.getBestCmap()
            glyph_name = cmap.get(0x4E00)  # 一
            if glyph_name is None:
                pytest.skip("U+4E00 not in font")

            coords = extract_raw_coordinates(font, glyph_name)
            contour = normalize_glyph(coords)
            matched = index.exact_match(contour.hash)
            assert matched is not None, "Reference font glyph should have exact match"
            font.close()
        finally:
            index.close()

    def test_font_reverser_build_mapping(self):
        """FontReverser should produce a non-empty mapping for a reference font."""
        from io import BytesIO

        from fontTools.ttLib import TTFont

        from engine.faiss_index import FAISSHashIndex
        from engine.font_reverser import FontReverser

        db_path = (
            Path(__file__).resolve().parent.parent
            / "data" / "reference" / "db" / "glyphs.db"
        )
        fonts_dir = Path(__file__).resolve().parent.parent / "data" / "reference" / "fonts"
        font_path = next(fonts_dir.glob("*.ttc"), None)
        if not font_path:
            font_path = next(fonts_dir.glob("*.ttf"), None)
        if not font_path:
            pytest.skip("No font files found")

        index = FAISSHashIndex(str(db_path))
        reverser = FontReverser(index)

        try:
            # Extract a single TTF face from TTC to stay under 5MB limit
            font = TTFont(str(font_path), fontNumber=0)
            try:
                buf = BytesIO()
                font.save(buf)
                font_bytes = buf.getvalue()
            finally:
                font.close()

            if len(font_bytes) > 5 * 1024 * 1024:
                pytest.skip("Extracted TTF still exceeds 5MB limit")

            mapping = reverser.build_mapping(font_bytes)
            assert len(mapping) > 0, "Should map at least some characters"
            methods = {v["method"] for v in mapping.values()}
            assert "exact" in methods, "Should have exact matches for a reference font"
        finally:
            index.close()
