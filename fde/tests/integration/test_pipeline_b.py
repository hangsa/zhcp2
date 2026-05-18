"""Integration tests for Pipeline Orchestrator (Solution B only, Phase 1).

Run:  cd fde && python -m pytest tests/integration/test_pipeline_b.py -v
"""

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))


class TestPipelineIntegration:
    """Pipeline integration tests with mock FontReverser."""

    @pytest.fixture
    def mock_reverser(self):
        """Create a FontReverser that returns predictable mappings."""
        reverser = MagicMock()
        reverser.build_mapping.return_value = {
            0x4E00: {"char": "一", "method": "exact", "score": 1.0},
            0x4E8C: {"char": "二", "method": "exact", "score": 1.0},
            0x4E09: {"char": "三", "method": "knn", "score": 0.85},
            0x56DB: {"char": "四", "method": "knn", "score": 0.72},
        }
        return reverser

    @pytest.fixture
    def sample_html(self):
        return """<!DOCTYPE html>
<html><head>
<style>
@font-face { font-family: 'zh-font-1'; src: url('https://zhstatic.zhihu.com/fonts/f1.woff2'); }
@font-face { font-family: 'zh-font-2'; src: url('https://zhstatic.zhihu.com/fonts/f2.woff2'); }
</style></head><body>
<div class="article">
<p>普通文本不需要处理。</p>
<p><span style="font-family: zh-font-1">一二</span></p>
<p><span style="font-family: zh-font-2">三</span><span style="font-family: zh-font-1">四</span></p>
</div>
</body></html>"""

    def test_pipeline_registers_fonts_and_builds_mappings(self, mock_reverser, sample_html):
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(mock_reverser)
        font_map = {
            "zh-font-1": b"fake_font_1_bytes",
            "zh-font-2": b"fake_font_2_bytes",
        }

        import asyncio
        result = asyncio.run(pipeline.process(sample_html, font_map))

        assert mock_reverser.build_mapping.call_count == 2
        assert result.text != ""
        assert len(result.mappings) > 0

    def test_pipeline_stats_accuracy(self, mock_reverser, sample_html):
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(mock_reverser)
        font_map = {
            "zh-font-1": b"fake_1",
            "zh-font-2": b"fake_2",
        }

        import asyncio
        result = asyncio.run(pipeline.process(sample_html, font_map))

        stats = result.stats
        assert "exact" in stats
        assert "knn" in stats
        assert "total_chars" in stats
        assert "accuracy_estimate" in stats
        assert 0.0 <= stats["accuracy_estimate"] <= 1.0

    def test_pipeline_no_fonts_returns_empty(self, mock_reverser, sample_html):
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(mock_reverser)
        font_map: dict[str, bytes] = {}

        import asyncio
        result = asyncio.run(pipeline.process(sample_html, font_map))

        assert mock_reverser.build_mapping.call_count == 0
        # All text should pass through (no spans decoded)
        assert "普通文本不需要处理" in result.text

    def test_pipeline_empty_html(self, mock_reverser):
        from engine.pipeline import PipelineOrchestrator

        pipeline = PipelineOrchestrator(mock_reverser)
        font_map = {"zh-font-1": b"fake"}

        import asyncio
        result = asyncio.run(pipeline.process("", font_map))

        assert result.text == ""

    def test_build_font_map_from_css(self, sample_html):
        from engine.pipeline import build_font_map_from_css

        font_bytes_list = [b"bytes_1", b"bytes_2"]
        font_map = build_font_map_from_css(sample_html, font_bytes_list)

        assert len(font_map) == 2
        assert "zh-font-1" in font_map
        assert "zh-font-2" in font_map
        assert font_map["zh-font-1"] == b"bytes_1"
        assert font_map["zh-font-2"] == b"bytes_2"


class TestFontExtractor:
    """Tests for proxy/font_extractor.py."""

    @pytest.fixture
    def sample_css_html(self):
        return """<!DOCTYPE html>
<html><head>
<style>
@font-face {
    font-family: 'zhihu-font-v1';
    src: url('https://zhstatic.zhihu.com/fonts/abc123.woff2') format('woff2');
}
@font-face {
    font-family: 'zhihu-font-v2';
    src: url('https://zhstatic.zhihu.com/fonts/def456.woff2') format('woff2');
}
</style>
<link rel="preload" as="font" href="https://zhstatic.zhihu.com/fonts/abc123.woff2" crossorigin>
</head><body></body></html>"""

    def test_extract_font_urls(self, sample_css_html):
        from proxy.font_extractor import extract_font_urls

        urls = extract_font_urls(sample_css_html)
        assert len(urls) == 2
        assert any("abc123.woff2" in u for u in urls)
        assert any("def456.woff2" in u for u in urls)

    def test_extract_font_family_map(self, sample_css_html):
        from proxy.font_extractor import extract_font_family_map

        family_map = extract_font_family_map(sample_css_html)
        assert len(family_map) == 2
        assert "zhihu-font-v1" in family_map
        assert "zhihu-font-v2" in family_map

    def test_filter_zhihu_fonts(self):
        from proxy.font_extractor import filter_zhihu_fonts

        urls = [
            "https://zhstatic.zhihu.com/fonts/f1.woff2",
            "https://fonts.googleapis.com/css?family=Roboto",
            "https://cdn.bootcdn.net/font.woff2",
            "https://zhimg.com/f2.woff2",
        ]
        filtered = filter_zhihu_fonts(urls)
        assert len(filtered) == 2
        assert "zhstatic.zhihu.com" in filtered[0]
        assert "zhimg.com" in filtered[1]

    def test_filter_zhihu_fonts_no_woff2(self):
        from proxy.font_extractor import filter_zhihu_fonts

        urls = ["https://example.com/style.css", "https://example.com/image.png"]
        filtered = filter_zhihu_fonts(urls)
        assert len(filtered) == 0

    def test_extract_font_urls_no_fonts(self):
        from proxy.font_extractor import extract_font_urls

        html = "<html><body><p>No fonts here</p></body></html>"
        urls = extract_font_urls(html)
        assert urls == []

    def test_extract_font_family_map_dedup_url(self):
        from proxy.font_extractor import extract_font_family_map

        html = """
        <style>
        @font-face { font-family: 'f1'; src: url('same.woff2'); }
        @font-face { font-family: 'f2'; src: url('same.woff2'); }
        </style>
        """
        family_map = extract_font_family_map(html)
        # Same URL → only first family kept
        assert len(family_map) == 1
        assert "f1" in family_map
        assert family_map["f1"] == "same.woff2"
