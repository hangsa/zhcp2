"""mitmproxy addon for intercepting zhihu article pages and obfuscated fonts.

Detects zhihu article pages, actively downloads the woff2 font files
referenced in @font-face rules, and forwards the page HTML + font files
to the FDE Pipeline API for decoding.

TLS downgrade path (when HTTPS interception is not possible):
  - Primary: mitmproxy MITM (requires user-installed CA certificate)
  - Fallback: browser extension uses chrome.webRequest API to read
    font response bodies directly. See docs/ for extension integration.
"""

import asyncio
import base64
import logging
import re
from collections import OrderedDict
from urllib.parse import urljoin

import httpx
from mitmproxy import ctx, http

from proxy.font_extractor import extract_font_family_map, download_font

logger = logging.getLogger(__name__)

ZHIHU_ARTICLE_PATTERN = re.compile(
    r"zhihu\.com/(p|pin|question|column)/", re.IGNORECASE
)

MAX_CACHED_FONTS = 50


class FontInterceptor:
    """mitmproxy addon: intercept zhihu pages and trigger FDE decode."""

    def __init__(self) -> None:
        self._fde_url = "http://localhost:8000"

    def load(self, loader) -> None:
        """mitmproxy addon entry point — read options."""
        loader.add_option(
            name="fde_api_url",
            typespec=str,
            default="http://localhost:8000",
            help="FDE API base URL",
        )

    def configure(self, updates: set[str]) -> None:
        """Handle configuration updates."""
        if "fde_api_url" in updates:
            self._fde_url = ctx.options.fde_api_url

    def running(self) -> None:
        """Ensure FDE URL is read from options at startup."""
        self._fde_url = ctx.options.fde_api_url

    def request(self, flow: http.HTTPFlow) -> None:
        """Intercept outgoing requests. No-op for now."""
        pass

    def response(self, flow: http.HTTPFlow) -> None:
        """Detect zhihu article pages and trigger font download + decode."""
        url = flow.request.pretty_url
        content_type = flow.response.headers.get("Content-Type", "")

        if not ZHIHU_ARTICLE_PATTERN.search(url):
            return

        if "text/html" not in (content_type or ""):
            return

        html = flow.response.text
        if not html:
            return

        # Extract @font-face family → URL pairs from the page
        family_to_url = extract_font_family_map(html)
        if not family_to_url:
            logger.debug("No @font-face rules found on %s", url)
            return

        # Fire-and-forget: download fonts actively and send to FDE
        asyncio.ensure_future(self._decode_page(html, family_to_url, url))

    async def _decode_page(
        self,
        html: str,
        family_to_url: dict[str, str],
        page_url: str,
    ) -> None:
        """Actively download referenced fonts and submit for decoding."""
        font_map: dict[str, bytes] = {}
        for family, font_url in family_to_url.items():
            full_url = urljoin(page_url, font_url)
            font_data = await download_font(full_url)
            if font_data:
                font_map[family] = font_data
                logger.info("Downloaded font for '%s': %s (%d bytes)", family, full_url, len(font_data))
            else:
                logger.warning("Failed to download font '%s' from %s", family, full_url)

        if not font_map:
            logger.warning("No fonts downloaded for %s", page_url)
            return

        logger.info(
            "Submitting FDE decode for %s (%d fonts: %s)",
            page_url,
            len(font_map),
            list(font_map.keys()),
        )

        await self._send_to_fde(html, font_map, page_url)

    async def _send_to_fde(
        self,
        html: str,
        font_map: dict[str, bytes],
        page_url: str,
    ) -> None:
        """POST page HTML and fonts to the FDE decode endpoint."""
        fonts_payload = []
        for family, font_bytes in font_map.items():
            fonts_payload.append({
                "family": family,
                "url": "",
                "data_base64": base64.b64encode(font_bytes).decode("ascii"),
            })

        body = {
            "html": html,
            "fonts": fonts_payload,
            "session_id": page_url,
        }

        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(connect=5.0, read=30.0, write=10.0)) as client:
                resp = await client.post(
                    f"{self._fde_url}/api/v1/decode",
                    json=body,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    stats = data.get("stats", {})
                    acc = stats.get("accuracy_estimate", 0)
                    if acc <= 1.0:
                        acc *= 100.0
                    logger.info(
                        "FDE decode success: %d chars, accuracy=%.1f%%",
                        stats.get("total_chars", 0),
                        acc,
                    )
                else:
                    logger.error("FDE decode failed: HTTP %d — %s", resp.status_code, resp.text[:200])
        except Exception:
            logger.exception("FDE decode request failed")

    def done(self) -> None:
        """Cleanup on mitmproxy shutdown."""
        pass


# mitmproxy addon registration
addons = [FontInterceptor()]
