"""End-to-end integration tests with real FontReverser + GlyphClassifier.

Verifies the full Solution B + Solution C pipeline works correctly on Mac.
Requires reference database and trained model.

Run:
    cd fde && python -m pytest tests/integration/test_pipeline_with_real_classifier.py -v
Skip slow tests:
    cd fde && python -m pytest tests/integration/test_pipeline_with_real_classifier.py -v -m "not slow"
"""

import asyncio
import json
import sys
from io import BytesIO
from pathlib import Path

import pytest
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def _require(path: Path, name: str) -> None:
    if not path.exists():
        pytest.skip(f"{name} not found at {path}")


# ---- Session-scoped fixtures (loaded once per test run) ----


@pytest.fixture(scope="session")
def faiss_index():
    """Load the real FAISS index (141MB, expensive — session-scoped)."""
    from engine.faiss_index import FAISSHashIndex

    db_path = REPO_ROOT / "data" / "reference" / "db" / "glyphs.db"
    index_path = REPO_ROOT / "data" / "reference" / "db" / "faiss_index.faiss"
    _require(db_path, "Reference database")
    _require(index_path, "FAISS index")

    idx = FAISSHashIndex(str(db_path), str(index_path))
    yield idx
    idx.close()


@pytest.fixture(scope="session")
def real_reverser(faiss_index):
    """FontReverser backed by the real FAISS index."""
    from engine.font_reverser import FontReverser

    return FontReverser(faiss_index)


@pytest.fixture(scope="session")
def label_map():
    """Load the trained model's label map (8995 classes)."""
    label_map_path = REPO_ROOT / "data" / "training" / "label_map.json"
    _require(label_map_path, "Label map")
    with open(label_map_path, "r") as f:
        return {int(k): v for k, v in json.load(f).items()}


@pytest.fixture(scope="session")
def real_classifier(label_map):
    """Load the trained ViT-Tiny model (28.5MB, session-scoped)."""
    from engine.glyph_classifier import GlyphClassifier

    model_path = REPO_ROOT / "models" / "vit_tiny_gb2312.pt"
    _require(model_path, "Trained model")

    classifier = GlyphClassifier(
        model_path=str(model_path),
        num_classes=len(label_map),
        label_to_char=label_map,
        device="cpu",
        confidence_threshold=0.95,
    )
    return classifier


@pytest.fixture(scope="session")
def reference_font_bytes():
    """Load a reference font as woff2-equivalent bytes."""
    from fontTools.ttLib import TTFont

    fonts_dir = REPO_ROOT / "data" / "reference" / "fonts"
    font_files = list(fonts_dir.glob("*.ttc")) + list(fonts_dir.glob("*.ttf"))
    if not font_files:
        pytest.skip("No reference fonts available")

    font = TTFont(str(font_files[0]), fontNumber=0)
    try:
        buf = BytesIO()
        font.save(buf)
        return buf.getvalue()
    finally:
        font.close()


@pytest.fixture(scope="session")
def reference_font_family(reference_font_bytes):
    """Return a consistent font-family name for test HTML."""
    return "test-reference-font"


@pytest.fixture
def test_html(reference_font_family):
    """HTML with CJK text using the reference font."""
    return f"""<html><head>
<style>
@font-face {{ font-family: '{reference_font_family}'; src: url('test.woff2'); }}
</style></head><body>
<span style="font-family: {reference_font_family}">一二三</span>
</body></html>"""


# ---- Test Cases ----


class TestModelArchitecture:
    """Verify the trained model loads correctly with expected architecture."""

    def test_num_classes(self, real_classifier, label_map):
        assert real_classifier.num_classes == 8995
        assert real_classifier.num_classes == len(label_map)

    def test_param_count(self, real_classifier):
        params = sum(p.numel() for p in real_classifier._model.parameters())
        assert 7_000_000 < params < 7_500_000, f"Unexpected param count: {params:,}"

    def test_model_is_eval_mode(self, real_classifier):
        assert not real_classifier._model.training

    def test_forward_pass_works(self, real_classifier):
        """Dummy tensor inference — verifies model runs without error."""
        x = torch.randn(1, 1, 64, 64)
        with torch.no_grad():
            out = real_classifier._model(x)
        assert out.shape == (1, 8995)

    def test_label_map_has_cjk(self, label_map):
        """Verify label map contains expected CJK characters."""
        chars = set(label_map.values())
        assert "一" in chars
        assert "中" in chars
        assert "国" in chars


class TestRealPipelineIntegration:
    """End-to-end pipeline tests with real classifier."""

    def test_pipeline_with_classifier_completes(
        self, real_reverser, real_classifier, reference_font_bytes,
        reference_font_family, test_html,
    ):
        """Full pipeline with real classifier — verifies no exceptions."""
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(real_reverser, classifier=real_classifier)
        font_map = {reference_font_family: reference_font_bytes}

        result = asyncio.run(pipeline.process(test_html, font_map))

        assert result.text != ""
        assert "cnn" in result.stats
        assert "exact" in result.stats
        assert "knn" in result.stats

    def test_pipeline_no_classifier_backward_compat(
        self, real_reverser, reference_font_bytes, reference_font_family, test_html,
    ):
        """Pipeline without classifier — cnn stats should be 0."""
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(real_reverser, classifier=None)
        font_map = {reference_font_family: reference_font_bytes}

        result = asyncio.run(pipeline.process(test_html, font_map))

        assert result.text != ""
        assert result.stats.get("cnn", 0) == 0

    def test_pipeline_stats_structure(
        self, real_reverser, real_classifier, reference_font_bytes,
        reference_font_family, test_html,
    ):
        """Verify stats dict has all expected keys."""
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(real_reverser, classifier=real_classifier)
        font_map = {reference_font_family: reference_font_bytes}

        result = asyncio.run(pipeline.process(test_html, font_map))

        for key in ("total_chars", "exact", "knn", "cnn", "unknown", "accuracy_estimate"):
            assert key in result.stats, f"Missing stat key: {key}"
        assert isinstance(result.stats["total_chars"], int)
        assert result.stats["total_chars"] > 0


class TestClassifyUnmatched:
    """Test classify_unmatched with real font data."""

    def test_returns_valid_dict(
        self, real_classifier, reference_font_bytes,
    ):
        """classify_unmatched should return a dict with correct structure."""
        result = real_classifier.classify_unmatched(reference_font_bytes, {})

        assert isinstance(result, dict)
        for cp, mapping in result.items():
            assert isinstance(cp, int)
            assert "char" in mapping
            assert "method" in mapping
            assert mapping["method"] == "cnn"
            assert "score" in mapping
            assert 0.0 <= mapping["score"] <= 1.0

    def test_empty_when_all_matched(
        self, real_classifier, reference_font_bytes,
    ):
        """When all CJK codepoints are 'matched', result should be empty."""
        from fontTools.ttLib import TTFont

        font = TTFont(BytesIO(reference_font_bytes))
        try:
            cmap = font.getBestCmap()
            if cmap is None:
                pytest.skip("Font has no cmap")
            # Pre-populate all CJK codepoints as matched
            all_matched = {}
            for cp in cmap:
                if (0x2E80 <= cp <= 0x2FDF) or (0x3000 <= cp <= 0x9FFF):
                    all_matched[cp] = {"char": "X", "method": "exact", "score": 1.0}
        finally:
            font.close()

        result = real_classifier.classify_unmatched(reference_font_bytes, all_matched)
        assert result == {}

    def test_skips_large_font(self, real_classifier):
        """Fonts > 10MB should be skipped (returns empty)."""
        large_bytes = b"x" * (11 * 1024 * 1024)
        result = real_classifier.classify_unmatched(large_bytes, {})
        assert result == {}

    def test_invalid_font_bytes_returns_empty(self, real_classifier):
        """Invalid font bytes should not crash."""
        result = real_classifier.classify_unmatched(b"not a font", {})
        assert result == {}


class TestDatabaseConsistency:
    """Verify reference database and model are consistent."""

    def test_faiss_index_has_vectors(self, faiss_index):
        assert faiss_index.n_total > 0

    def test_reverser_rejects_large_font(self, real_reverser, reference_font_bytes):
        """Reference fonts (53MB) exceed the 5MB web-font limit — should raise ValueError."""
        with pytest.raises(ValueError, match="Font file too large"):
            real_reverser.build_mapping(reference_font_bytes)

    def test_reverser_accepts_small_font(self, real_reverser):
        """A small valid TTF should be processed (even if no mappings found)."""
        # Minimal TrueType font: the reference fonts are too large,
        # but we verify the size check works correctly for small input.
        small_font = b"\x00\x01\x00\x00\x00"  # Not valid TTF, but < 5MB
        # Will fail at TTFont parsing, not at size check
        try:
            real_reverser.build_mapping(small_font)
        except ValueError as e:
            if "Font file too large" in str(e):
                pytest.fail("Small font should not trigger size limit")
        except Exception:
            pass  # Expected: invalid TTF bytes
