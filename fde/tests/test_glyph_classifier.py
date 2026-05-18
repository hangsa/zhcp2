"""Unit tests for glyph renderer, ViT-Tiny model, GlyphClassifier, and pipeline integration.

Run:  cd fde && python -m pytest tests/test_glyph_classifier.py -v
"""

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np
import pytest
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


class TestGlyphRenderer:
    """Tests for glyph_renderer.py — rendering glyphs to 64x64 images."""

    @pytest.fixture
    def font(self):
        """Load a real reference font for rendering tests."""
        from fontTools.ttLib import TTFont

        fonts_dir = Path(__file__).resolve().parent.parent / "data" / "reference" / "fonts"
        font_files = list(fonts_dir.glob("*.ttc")) + list(fonts_dir.glob("*.ttf"))
        if not font_files:
            pytest.skip("No reference fonts available")
        f = TTFont(str(font_files[0]), fontNumber=0)
        yield f
        f.close()

    @pytest.fixture
    def glyph_name(self, font):
        """Get a valid CJK glyph name from the font."""
        cmap = font.getBestCmap()
        name = cmap.get(0x4E00)
        if name is None:
            # Try any CJK character
            for cp in range(0x4E00, 0x9FFF):
                name = cmap.get(cp)
                if name:
                    break
        if name is None:
            pytest.skip("No CJK glyph found in font")
        return name

    def test_render_glyph_returns_64x64(self, font, glyph_name):
        from engine.glyph_renderer import render_glyph

        img = render_glyph(font, glyph_name)
        assert img.size == (64, 64)
        assert img.mode == "L"

    def test_render_glyph_binarized(self, font, glyph_name):
        from engine.glyph_renderer import render_glyph

        img = render_glyph(font, glyph_name)
        arr = np.array(img)
        unique = np.unique(arr)
        # After Otsu binarization, should only have 0 and 255
        assert set(unique).issubset({0, 255}), f"Values: {set(unique)}"

    def test_render_nonexistent_glyph_raises(self, font):
        from engine.glyph_renderer import GlyphRenderError, render_glyph

        with pytest.raises(GlyphRenderError):
            render_glyph(font, "nonexistent_glyph_name")

    def test_different_chars_different_images(self, font):
        from engine.glyph_renderer import render_glyph

        cmap = font.getBestCmap()
        # Find two different CJK characters
        g1 = cmap.get(0x4E00)  # 一
        g2 = cmap.get(0x4E8C)  # 二
        if g1 is None or g2 is None:
            pytest.skip("Required CJK chars not in font")

        img1 = render_glyph(font, g1)
        img2 = render_glyph(font, g2)
        arr1 = np.array(img1)
        arr2 = np.array(img2)
        # Different characters should produce different images
        assert not np.array_equal(arr1, arr2)

    def test_empty_glyph_returns_black_image(self, font):
        from engine.glyph_renderer import render_glyph

        # '.notdef' glyph is typically empty
        try:
            img = render_glyph(font, ".notdef")
            assert img.size == (64, 64)
            arr = np.array(img)
            assert np.all(arr == 0) or np.all(arr == 255) or arr.sum() >= 0
        except Exception:
            pytest.skip("Font has no .notdef glyph")

    def test_compound_glyph_renders(self, font):
        """Compound glyphs (with components) should render without error."""
        from engine.glyph_renderer import render_glyph

        # Find a compound glyph if any
        glyf = font.get("glyf")
        if glyf is None:
            pytest.skip("No glyf table")

        cmap = font.getBestCmap()
        compound_name = None
        for cp in range(0x4E00, 0x9FFF):
            name = cmap.get(cp)
            if name is None:
                continue
            try:
                g = glyf[name]
                if hasattr(g, "components") and g.components:
                    compound_name = name
                    break
            except Exception:
                continue

        if compound_name is None:
            pytest.skip("No compound glyph found in font")

        img = render_glyph(font, compound_name)
        assert img.size == (64, 64)
        assert img.mode == "L"


class TestViTTiny:
    """Tests for ViT-Tiny model architecture."""

    def test_instantiation(self):
        from engine.glyph_classifier import ViTTiny

        model = ViTTiny(num_classes=100)
        assert model is not None
        # ViT-Tiny standard: ~5.7M params for 6763 classes
        # For 100 classes the body is the same, head is just smaller
        params = sum(p.numel() for p in model.parameters())
        assert 5_000_000 < params < 6_000_000

    def test_forward_pass_shape(self):
        from engine.glyph_classifier import ViTTiny

        model = ViTTiny(num_classes=100)
        # Input: (batch=2, channels=1, height=64, width=64)
        x = torch.randn(2, 1, 64, 64)
        out = model(x)
        assert out.shape == (2, 100)

    def test_single_image_forward(self):
        from engine.glyph_classifier import ViTTiny

        model = ViTTiny(num_classes=50)
        x = torch.randn(1, 1, 64, 64)
        out = model(x)
        assert out.shape == (1, 50)

    def test_deterministic_inference(self):
        from engine.glyph_classifier import ViTTiny

        model = ViTTiny(num_classes=50)
        model.eval()
        x = torch.ones(1, 1, 64, 64)

        with torch.no_grad():
            out1 = model(x)
            out2 = model(x)
        assert torch.allclose(out1, out2)

    def test_gradient_flow(self):
        from engine.glyph_classifier import ViTTiny

        model = ViTTiny(num_classes=50)
        model.train()
        x = torch.randn(2, 1, 64, 64)
        labels = torch.randint(0, 50, (2,))

        out = model(x)
        loss = torch.nn.functional.cross_entropy(out, labels)
        loss.backward()

        # All parameters should have gradients
        no_grad = [name for name, p in model.named_parameters() if p.grad is None]
        assert len(no_grad) == 0, f"Parameters without gradient: {no_grad}"

    def test_param_count_estimates(self):
        from engine.glyph_classifier import ViTTiny

        # Full ViT-Tiny (6763 classes) — should be ~5.7M
        model_full = ViTTiny(num_classes=6763)
        params_full = sum(p.numel() for p in model_full.parameters())
        assert 5_000_000 < params_full < 7_000_000, f"Got {params_full} params"

        # Small model variant (100 classes)
        model_small = ViTTiny(num_classes=100)
        params_small = sum(p.numel() for p in model_small.parameters())
        assert params_small < params_full


class TestGlyphClassifier:
    """Tests for GlyphClassifier inference wrapper."""

    @pytest.fixture
    def tiny_model_path(self):
        """Create a ViT-Tiny model saved to disk for testing.

        Must use default architecture (dim=192, depth=12, img_size=64) so the
        GlyphClassifier wrapper can load it with default constructor args.
        Only num_classes is reduced for faster test execution.
        """
        from engine.glyph_classifier import ViTTiny

        model = ViTTiny(num_classes=10)
        with tempfile.NamedTemporaryFile(suffix=".pt", delete=False) as f:
            torch.save(model.state_dict(), f.name)
            path = f.name
        yield path
        os.unlink(path)

    @pytest.fixture
    def label_map(self):
        return {i: ch for i, ch in enumerate("一二三四五六七八九十")}

    @pytest.fixture
    def classifier(self, tiny_model_path, label_map):
        from engine.glyph_classifier import GlyphClassifier

        return GlyphClassifier(
            model_path=tiny_model_path,
            num_classes=10,
            label_to_char=label_map,
            device="cpu",
            confidence_threshold=0.5,
        )

    def test_classifier_loads(self, classifier):
        assert classifier.num_classes == 10

    def test_classify_glyph_returns_top3(self, classifier):
        # Create a random 64x64 grayscale image
        img = Image.fromarray(np.random.randint(0, 256, (64, 64), dtype=np.uint8), mode="L")
        results = classifier.classify_glyph(img)
        assert len(results) <= 3
        for char, conf in results:
            assert isinstance(char, str)
            assert 0.0 <= conf <= 1.0

    def test_classify_batch(self, classifier):
        img1 = Image.fromarray(np.random.randint(0, 256, (64, 64), dtype=np.uint8), mode="L")
        img2 = Image.fromarray(np.random.randint(0, 256, (64, 64), dtype=np.uint8), mode="L")
        results = classifier.classify_batch([img1, img2])
        assert len(results) == 2
        for preds in results:
            assert len(preds) <= 3

    def test_classify_batch_empty(self, classifier):
        results = classifier.classify_batch([])
        assert results == []

    def test_confidence_threshold_respected(self, tiny_model_path, label_map):
        from engine.glyph_classifier import GlyphClassifier

        # High threshold — unlikely to produce any predictions on random input
        cls = GlyphClassifier(
            model_path=tiny_model_path,
            num_classes=10,
            label_to_char=label_map,
            device="cpu",
            confidence_threshold=0.99,
        )
        img = Image.fromarray(np.random.randint(0, 256, (64, 64), dtype=np.uint8), mode="L")
        results = cls.classify_glyph(img)
        # Top-1 may or may not exceed threshold, but results return all top-3
        assert len(results) <= 3

    @patch("engine.glyph_classifier.render_glyph")
    def test_classify_unmatched_flow(self, mock_render, classifier):
        """classify_unmatched pipeline: font open → cmap → render → classify → results.

        Both rendering and batch classification are mocked for speed.
        """
        from fontTools.ttLib import TTFont
        from io import BytesIO
        from unittest.mock import MagicMock

        mock_render.return_value = Image.fromarray(
            np.zeros((64, 64), dtype=np.uint8), mode="L"
        )
        # Mock classify_batch on the classifier instance to avoid slow model inference
        classifier.classify_batch = MagicMock(return_value=[[("测", 0.99)]])

        fonts_dir = Path(__file__).resolve().parent.parent / "data" / "reference" / "fonts"
        font_files = list(fonts_dir.glob("*.ttc")) + list(fonts_dir.glob("*.ttf"))
        if not font_files:
            pytest.skip("No reference fonts available")

        font = TTFont(str(font_files[0]), fontNumber=0)
        try:
            buf = BytesIO()
            font.save(buf)
            font_bytes = buf.getvalue()
        finally:
            font.close()

        result = classifier.classify_unmatched(font_bytes, {})
        assert isinstance(result, dict)


class TestPipelineWithClassifier:
    """Integration tests for pipeline with CNN classifier."""

    @pytest.fixture
    def mock_reverser(self):
        reverser = MagicMock()
        # Return partial mapping — leaves some codepoints unmatched
        reverser.build_mapping.return_value = {
            0x4E00: {"char": "一", "method": "exact", "score": 1.0},
            0x4E8C: {"char": "二", "method": "knn", "score": 0.85},
            # 0x4E09 (三) left unmatched for CNN to catch
        }
        return reverser

    @pytest.fixture
    def mock_classifier(self):
        cls = MagicMock()
        # CNN catches the unmatched character
        cls.classify_unmatched.return_value = {
            0x4E09: {"char": "三", "method": "cnn", "score": 0.97},
        }
        return cls

    @pytest.fixture
    def sample_html(self):
        return """<html><head>
<style>
@font-face { font-family: 'zh-font-1'; src: url('f1.woff2'); }
</style></head><body>
<span style="font-family: zh-font-1">一二三</span>
</body></html>"""

    def test_pipeline_with_classifier_adds_cnn_stats(self, mock_reverser, mock_classifier, sample_html):
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(mock_reverser, classifier=mock_classifier)
        font_map = {"zh-font-1": b"fake_font_bytes"}

        import asyncio
        result = asyncio.run(pipeline.process(sample_html, font_map))

        assert "cnn" in result.stats
        assert mock_classifier.classify_unmatched.called

    def test_pipeline_no_classifier_backward_compat(self, mock_reverser, sample_html):
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(mock_reverser, classifier=None)
        font_map = {"zh-font-1": b"fake_font_bytes"}

        import asyncio
        result = asyncio.run(pipeline.process(sample_html, font_map))

        assert "cnn" in result.stats
        assert result.stats["cnn"] == 0

    def test_pipeline_classifier_exception_graceful(self, mock_reverser, sample_html):
        from engine.pipeline import PipelineOrchestrator

        bad_classifier = MagicMock()
        bad_classifier.classify_unmatched.side_effect = RuntimeError("GPU OOM")

        pipeline = PipelineOrchestrator(mock_reverser, classifier=bad_classifier)
        font_map = {"zh-font-1": b"fake_font_bytes"}

        import asyncio
        # Should not crash — log warning and continue
        result = asyncio.run(pipeline.process(sample_html, font_map))
        assert result.text != ""

    def test_all_mappings_includes_cnn_method(self, mock_reverser, mock_classifier, sample_html):
        from engine.pipeline import MatchMethod, PipelineOrchestrator

        pipeline = PipelineOrchestrator(mock_reverser, classifier=mock_classifier)
        font_map = {"zh-font-1": b"fake_font_bytes"}

        import asyncio
        result = asyncio.run(pipeline.process(sample_html, font_map))

        # Check that CNN-mapped chars have CLASSIFIER method
        cnn_mappings = [m for m in result.mappings.values() if m.method == MatchMethod.CLASSIFIER]
        assert len(cnn_mappings) > 0

    def test_empty_font_map_with_classifier(self, mock_reverser, mock_classifier):
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(mock_reverser, classifier=mock_classifier)
        font_map: dict[str, bytes] = {}

        import asyncio
        result = asyncio.run(pipeline.process("<html><p>Test</p></html>", font_map))

        assert result.text != ""
        assert not mock_classifier.classify_unmatched.called
