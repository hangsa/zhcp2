from __future__ import annotations

"""Pipeline Orchestrator — coordinates the FDE solution cascade.

Routes each page through the priority-ordered recognition chain:
  Solution B (FontReverser) → Solution C (CNN classifier, Phase 2) →
  Solution A (OCR fallback, Phase 3)

Phase 1 implements Solution B only. Later phases wire in classifier
and OCR as they become available.
"""

import logging
import re
from dataclasses import dataclass, field
from enum import Enum

from engine.font_resolver import FontResolver
from engine.font_reverser import FontReverser
from engine.glyph_classifier import GlyphClassifier

logger = logging.getLogger(__name__)


class MatchMethod(Enum):
    EXACT = "exact"
    KNN = "knn"
    CLASSIFIER = "cnn"
    OCR = "ocr"
    UNKNOWN = "unknown"


@dataclass
class CharMapping:
    codepoint: int
    char: str
    method: MatchMethod
    confidence: float


@dataclass
class DecodeResult:
    text: str
    mappings: dict[int, CharMapping] = field(default_factory=dict)
    stats: dict = field(default_factory=dict)


# Match <span opening tag with font-family style
_SPAN_OPEN_RE = re.compile(
    r"""<span\s[^>]*?style\s*=\s*["'][^"']*?font-family\s*:\s*([^"';}]+)""",
    re.IGNORECASE,
)

# Strip HTML tags from inner content
_TAG_RE = re.compile(r"<[^>]+>")


def _extract_first_family(font_family_value: str) -> str:
    """Extract the first font-family name from a CSS value.

    Handles: 'ZhihuSans', "ZhihuSans", 'Name', -apple-system, ...
    Returns just the first family name, stripped of quotes.
    """
    value = font_family_value.strip()
    # Handle quoted names: "Font Name" or 'Font Name'
    if (value.startswith('"') or value.startswith("'")):
        quote = value[0]
        end = value.find(quote, 1)
        if end != -1:
            return value[1:end]
    # Unquoted: take first token before comma or whitespace
    name = value.split(",")[0].strip().strip("'\"")
    return name


def _extract_font_spans(html: str) -> list[tuple[str, str, int, int]]:
    """Extract styled spans with proper nesting handling.

    Returns list of (font_family, inner_text, start_pos, end_pos) tuples
    in document order. Handles nested <span> elements correctly via
    depth counting.
    """
    spans: list[tuple[str, str, int, int]] = []
    pos = 0

    while True:
        m = _SPAN_OPEN_RE.search(html, pos)
        if not m:
            break

        font_family_raw = m.group(1)
        font_family = _extract_first_family(font_family_raw)
        tag_end = html.index(">", m.start()) + 1

        # Find matching </span> using depth counting
        depth = 1
        search_pos = tag_end
        while depth > 0:
            next_open = html.find("<span", search_pos)
            next_close = html.find("</span>", search_pos)
            if next_close == -1:
                break
            if next_open != -1 and next_open < next_close:
                depth += 1
                search_pos = next_open + 5
            else:
                depth -= 1
                if depth == 0:
                    inner_html = html[tag_end:next_close]
                    inner_text = _TAG_RE.sub("", inner_html)
                    spans.append((font_family, inner_text, m.start(), next_close + 7))
                search_pos = next_close + 7

        pos = max(tag_end, search_pos)

    return spans


class PipelineOrchestrator:
    """Coordinates the FDE solution cascade for a single page."""

    def __init__(
        self,
        font_reverser: FontReverser,
        classifier: GlyphClassifier | None = None,
        ocr: object | None = None,
    ):
        self._reverser = font_reverser
        self._classifier = classifier
        self._ocr = ocr

    async def process(
        self,
        html: str,
        font_map: dict[str, bytes],
    ) -> DecodeResult:
        """Main entry point: decode a page given its HTML and fonts.

        Args:
            html: Full page HTML including inline <style> blocks.
            font_map: {font_family: woff2_bytes} for each obfuscated font.

        Returns:
            DecodeResult with decoded full-page text and per-character stats.
        """
        # 1. Register all fonts and build mappings
        resolver = FontResolver()
        for family, font_bytes in font_map.items():
            resolver.register_font(family, url="", woff2_bytes=font_bytes)

        resolver.build_all_mappings(self._reverser)

        # 1.5 Run CNN classifier (Solution C) on unmatched glyphs per font
        if self._classifier is not None:
            for entry in resolver.iter_fonts():
                if not entry.woff2_bytes:
                    continue
                try:
                    cnn_mappings = self._classifier.classify_unmatched(
                        entry.woff2_bytes,
                        entry.mapping or {},
                    )
                    if cnn_mappings:
                        if entry.mapping is None:
                            entry.mapping = {}
                        entry.mapping.update(cnn_mappings)
                        logger.info(
                            "Classifier: %s -> %d additional mappings",
                            entry.family, len(cnn_mappings),
                        )
                except Exception as e:
                    logger.warning(
                        "Classifier failed for font '%s': %s", entry.family, e
                    )

        # 2. Build merged codepoint mapping for stat tracking
        all_mappings: dict[int, CharMapping] = {}
        for entry in resolver.iter_fonts():
            if not entry.mapping:
                continue
            for cp, info in entry.mapping.items():
                if cp not in all_mappings:
                    method_name = info.get("method", "unknown")
                    if method_name == "exact":
                        method = MatchMethod.EXACT
                    elif method_name == "knn":
                        method = MatchMethod.KNN
                    elif method_name == "cnn":
                        method = MatchMethod.CLASSIFIER
                    else:
                        method = MatchMethod.UNKNOWN
                    all_mappings[cp] = CharMapping(
                        codepoint=cp,
                        char=info["char"],
                        method=method,
                        confidence=info["score"],
                    )

        # 3. Decode styled spans using depth-aware extraction
        decoded_parts: list[str] = []
        stats = {"exact": 0, "knn": 0, "cnn": 0, "unknown": 0, "total_chars": 0}

        last_end = 0
        for font_family, inner_text, span_start, span_end in _extract_font_spans(html):
            # Append raw text between spans (gap text)
            if span_start > last_end:
                gap = html[last_end:span_start]
                gap_text = _TAG_RE.sub("", gap)
                if gap_text.strip():
                    decoded_parts.append(gap_text)

            decoded_text = resolver.decode_element(inner_text, font_family)
            decoded_parts.append(decoded_text)

            last_end = span_end

        # Append trailing raw text
        if last_end < len(html):
            tail = html[last_end:]
            tail_text = _TAG_RE.sub("", tail)
            if tail_text.strip():
                decoded_parts.append(tail_text)

        full_text = "".join(decoded_parts)

        # 4. Compute per-character method stats from the output text
        total = 0
        for ch in full_text:
            cp = ord(ch)
            info = all_mappings.get(cp)
            if info:
                stats[info.method.value] = stats.get(info.method.value, 0) + 1
            elif ch.strip():
                total += 1
        stats["total_chars"] = total + stats.get("exact", 0) + stats.get("knn", 0) + stats.get("cnn", 0)

        # Accuracy estimate: mapped chars / total chars
        mapped_chars = stats.get("exact", 0) + stats.get("knn", 0) + stats.get("cnn", 0)
        stats["accuracy_estimate"] = (
            mapped_chars / max(stats["total_chars"], 1)
        )

        logger.info(
            "Pipeline: %d chars decoded (exact=%d knn=%d cnn=%d unknown=%d, accuracy=%.1f%%)",
            stats["total_chars"],
            stats.get("exact", 0),
            stats.get("knn", 0),
            stats.get("cnn", 0),
            stats.get("unknown", 0),
            stats["accuracy_estimate"] * 100,
        )

        return DecodeResult(text=full_text, mappings=all_mappings, stats=stats)


def build_font_map_from_css(
    html: str, font_bytes_list: list[bytes]
) -> dict[str, bytes]:
    """Convenience: pair @font-face families with downloaded font bytes.

    Extracts font-family names from CSS, then pairs them 1:1 with the
    provided font bytes in order. For production use, the interceptor
    should match URLs explicitly — this is a fallback for testing.
    """
    from proxy.font_extractor import extract_font_family_map

    family_to_url = extract_font_family_map(html)
    families = list(family_to_url.keys())

    font_map: dict[str, bytes] = {}
    for i, font_bytes in enumerate(font_bytes_list):
        if i < len(families):
            font_map[families[i]] = font_bytes
        else:
            font_map[f"zh-font-{i + 1}"] = font_bytes

    return font_map
