from __future__ import annotations

"""Multi-font mapping resolver for pages with several obfuscated fonts.

Zhihu pages often load 2-4 distinct obfuscated font files, each applied
to different <span> elements via CSS font-family. This module manages the
per-font mapping tables and routes text decoding to the correct font.
"""

import logging
from dataclasses import dataclass

from engine.font_reverser import FontReverser

logger = logging.getLogger(__name__)


@dataclass
class FontEntry:
    """A single obfuscated font loaded on the page."""

    family: str
    url: str
    woff2_bytes: bytes
    mapping: dict[int, dict] | None = None
    """Built mapping: {codepoint: {"char": str, "method": str, "score": float}}"""


class FontResolver:
    """Manages per-font mappings for a single page with multiple fonts.

    Workflow:
    1. Parse page CSS, extract @font-face → family/URL pairs
    2. Intercept each woff2 file, store as FontEntry
    3. Run Solution B (FontReverser) on each entry to build mapping
    4. For each DOM element, look up computed font-family and apply
       the corresponding mapping.
    """

    def __init__(self) -> None:
        self._fonts: dict[str, FontEntry] = {}  # family → FontEntry

    def register_font(self, family: str, url: str, woff2_bytes: bytes) -> None:
        """Register a font file for later mapping.

        Font family names are case-folded per CSS spec (case-insensitive).
        """
        key = family.strip().casefold()
        if not key:
            logger.warning("Refusing to register font with empty family name")
            return
        if key in self._fonts:
            logger.warning("Duplicate font family '%s' — overwriting previous", family)
        self._fonts[key] = FontEntry(
            family=family, url=url, woff2_bytes=woff2_bytes
        )

    @property
    def font_count(self) -> int:
        return len(self._fonts)

    def iter_fonts(self):
        """Iterate over all registered FontEntry objects."""
        return self._fonts.values()

    def build_all_mappings(self, reverser: FontReverser) -> dict[str, dict]:
        """Run FontReverser on every registered font. Returns {family: mapping}.

        Already-built mappings are skipped (idempotent). Fonts that cause
        errors (e.g. too large) are logged and skipped individually.
        """
        results: dict[str, dict] = {}
        for family, entry in self._fonts.items():
            if entry.mapping is not None:
                results[family] = entry.mapping
                continue
            try:
                entry.mapping = reverser.build_mapping(entry.woff2_bytes)
            except ValueError as e:
                logger.warning("Font '%s' rejected by reverser: %s", family, e)
                entry.mapping = {}
            results[family] = entry.mapping
            mapped = len(entry.mapping)
            logger.info(
                "FontResolver: %s → %d codepoints mapped", family, mapped
            )
        return results

    def decode_element(self, text: str, font_family: str) -> str:
        """Decode text using the mapping for a specific font-family."""
        key = font_family.strip().casefold()
        entry = self._fonts.get(key)
        if not entry or not entry.mapping:
            if key:
                logger.debug("No mapping for font-family '%s'", font_family)
            return text
        return _apply_mapping(text, entry.mapping)

    def get_font_mapping(self, family: str) -> dict[int, dict] | None:
        """Return the built mapping for a font family, or None."""
        entry = self._fonts.get(family.strip().casefold())
        return entry.mapping if entry else None

    def get_merged_mapping(self) -> dict[int, dict]:
        """Merge all font mappings into one fallback dict.

        When a codepoint appears in multiple fonts, the first registered
        font's mapping wins. Useful when per-element font-family is unknown.
        """
        merged: dict[int, dict] = {}
        for entry in self._fonts.values():
            if entry.mapping:
                for cp, info in entry.mapping.items():
                    if cp not in merged:
                        merged[cp] = info
                    else:
                        logger.debug(
                            "Codepoint U+%04X conflict: keeping '%s' from earlier font",
                            cp, merged[cp]["char"],
                        )
        return merged


def _apply_mapping(text: str, mapping: dict[int, dict]) -> str:
    """Replace obfuscated codepoints in text with real characters.

    Each character in text is checked: if its codepoint exists in the
    mapping, it is replaced with the real character. Non-mapped characters
    pass through unchanged.
    """
    result: list[str] = []
    for ch in text:
        cp = ord(ch)
        if cp in mapping:
            result.append(mapping[cp]["char"])
        else:
            result.append(ch)
    return "".join(result)
