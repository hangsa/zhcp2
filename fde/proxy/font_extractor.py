from __future__ import annotations

"""Font URL extraction from HTML and CSS @font-face rules.

Parses page HTML to locate woff2 font file URLs and their associated
font-family names. Handles both <link> preload tags and inline <style>
@font-face blocks.

Note: extracted URLs may be relative — callers should resolve against
a base URL before fetching.
"""

import logging
import re
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

# Match @font-face src: url("...woff2") — captures the URL.
# [^;{}]*? between src: and url( skips local() or format() tokens.
_FONT_FACE_URL_RE = re.compile(
    r"""@font-face\s*\{[^}]*?src\s*:[^;{}]*?url\(["']?([^"')]*?\.woff2\b[^"')]*)["']?\)""",
    re.IGNORECASE,
)

# Match <link> tag with href to a woff2 file
_LINK_HREF_RE = re.compile(
    r"""<link[^>]*?href=["']([^"']*?\.woff2\b[^"']*)["'][^>]*?>""",
    re.IGNORECASE,
)

# Zhihu font CDN patterns
_ZHIHU_FONT_HOSTS = re.compile(r"(zhimg\.com|zhihu\.com|zhimg\.cn)", re.IGNORECASE)
_THIRD_PARTY_FONT_HOSTS = re.compile(
    r"(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.bootcdn\.net)", re.IGNORECASE
)

MAX_FONT_DOWNLOAD_SIZE = 5 * 1024 * 1024  # 5 MB


def extract_font_urls(html: str) -> list[str]:
    """Extract all woff2 font URLs from page HTML.

    Searches @font-face src: url() declarations and <link> preload tags.
    """
    urls: list[str] = []

    for m in _FONT_FACE_URL_RE.finditer(html):
        url = m.group(1)
        if url not in urls:
            urls.append(url)

    for m in _LINK_HREF_RE.finditer(html):
        url = m.group(1)
        if url not in urls:
            urls.append(url)

    return urls


def extract_font_family_map(html: str) -> dict[str, str]:
    """Parse @font-face rules and return {font_family: woff2_url} mapping.

    Multiple @font-face blocks sharing the same URL are deduplicated —
    only the first family name is kept per URL. Different families
    pointing to the same URL are the same physical font file.
    """
    # Find all @font-face blocks
    blocks = re.findall(r"@font-face\s*\{[^}]*\}", html, re.IGNORECASE | re.DOTALL)

    url_to_family: dict[str, str] = {}
    family_to_url: dict[str, str] = {}

    for block in blocks:
        url_m = re.search(r"""src\s*:[^;{}]*?url\(["']?([^"')]*?\.woff2\b[^"')]*)["']?\)""", block, re.IGNORECASE)
        family_m = re.search(r"""font-family\s*:\s*["']?([^"';}]+)["']?""", block, re.IGNORECASE)

        if not url_m:
            continue

        url = url_m.group(1)
        family = family_m.group(1).strip() if family_m else "unknown"

        # Deduplicate: first family wins per URL
        if url not in url_to_family:
            url_to_family[url] = family
        actual_family = url_to_family[url]
        family_to_url[actual_family] = url

    return family_to_url


def filter_zhihu_fonts(urls: list[str]) -> list[str]:
    """Filter URLs to keep only zhihu-hosted font files.

    Excludes well-known third-party CDN fonts (Google Fonts, BootCDN, etc.)
    that are not part of zhihu's obfuscation scheme.
    """
    result: list[str] = []
    for url in urls:
        if _THIRD_PARTY_FONT_HOSTS.search(url):
            continue
        if _ZHIHU_FONT_HOSTS.search(url):
            result.append(url)
    return result


async def download_font(url: str, headers: dict[str, str] | None = None) -> bytes | None:
    """Download a woff2 font file with the given request headers.

    Headers should include Cookie/User-Agent from the browser session
    to satisfy zhihu's session-bound font serving. Redirects are not
    followed to prevent SSRF.
    """
    import httpx

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        logger.warning("Refusing to fetch font with non-http scheme: %s", url)
        return None

    default_headers = {
        "User-Agent": (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "font/woff2,*/*",
    }
    if headers:
        default_headers.update(headers)

    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=False) as client:
            resp = await client.get(url, headers=default_headers)
            if resp.status_code == 200:
                content = resp.content
                if len(content) > MAX_FONT_DOWNLOAD_SIZE:
                    logger.warning("Font too large: %s (%d bytes)", url, len(content))
                    return None
                if len(content) > 0:
                    logger.info("Downloaded font: %s (%d bytes)", url, len(content))
                    return content
            logger.warning("Font download failed: %s (HTTP %d)", url, resp.status_code)
            return None
    except (httpx.HTTPError, OSError):
        logger.exception("Font download error: %s", url)
        return None
