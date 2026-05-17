// src/content/font-decoder.js
// Zhihu font anti-crawl decoder using cmap reverse mapping + pixel comparison fallback.
// Mechanism: the custom font maps standard CJK codepoints (encoded chars)
// to glyphs whose outlines are visually swapped. We detect swaps by comparing
// Canvas renderings of the custom font against reference (PingFang SC).
// IIFE - exposes window.ZhihuFontDecoder for use by content_script.js

(function () {
  'use strict';

  const ZHIHU_URL_PATTERN = /zhihu\.com|zhuanlan\.zhihu\.com/;

  // ---- State ----

  let _status = 'idle';
  let _errorMessage = null;
  let _mapping = null;
  let _initCalled = false;

  // ---- Diagnostic Overlay (avoids DevTools which triggers Zhihu anti-debug redirect) ----

  let _diagOverlay = null;
  let _diagLines = [];

  function diagLog(...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    _diagLines.push(msg);
    console.log(msg);
    updateDiagOverlay();
  }

  function diagError(...args) {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    _diagLines.push('ERROR: ' + msg);
    console.error(msg);
    updateDiagOverlay();
  }

  function updateDiagOverlay() {
    if (!_diagOverlay) {
      _diagOverlay = document.createElement('div');
      _diagOverlay.id = 'zhcp-diag';
      _diagOverlay.style.cssText = 'position:fixed;top:0;right:0;width:420px;max-height:100vh;overflow-y:auto;background:rgba(0,0,0,0.88);color:#0f0;font:11px/1.4 monospace;z-index:2147483647;padding:8px;border:1px solid #333;word-break:break-all;';
      document.body.appendChild(_diagOverlay);
    }
    _diagOverlay.textContent = _diagLines.slice(-40).join('\n');
  }

  // ---- Public API ----

  window.ZhihuFontDecoder = {
    init: init,
    isReady: function () { return _status === 'ready'; },
    decodeElement: decodeElement,
    decodeRawText: decodeRawText,
    getStatus: function () { return _status; },
    getError: function () { return _errorMessage; }
  };

  // ---- Entry Point ----

  async function init() {
    if (_initCalled) return;
    _initCalled = true;

    if (!isZhihuPage()) {
      diagLog('[zhcp] not a Zhihu page, skip');
      return;
    }

    diagLog('[zhcp] Zhihu page detected, starting cmap decoder');

    try {
      // Step 1: List all custom @font-face rules, deduplicate by URL
      _status = 'detecting';
      const allFonts = extractAllFontFaces();
      diagLog('Found', allFonts.length, '@font-face rules');

      // Deduplicate: same URL = same font (different families/weights share encoding)
      const seenUrls = new Set();
      const uniqueFonts = [];
      for (const f of allFonts) {
        if (/PingFang|Microsoft|Noto|Hiragino|sans-serif|serif|Arial|Helvetica/i.test(f.family)) continue;
        if (seenUrls.has(f.url)) continue;
        seenUrls.add(f.url);
        try {
          f.url = new URL(f.url, window.location.href).href;
        } catch (e) { /* keep original */ }
        uniqueFonts.push(f);
      }

      if (uniqueFonts.length === 0) {
        setError('No custom fonts found');
        return;
      }
      diagLog('Unique custom fonts:', uniqueFonts.length);

      // Step 2: Download & parse each font, pick the one with most uniXXXX glyphs
      _status = 'downloading';
      let bestFont = null;
      let bestMapping = new Map();
      let bestCount = 0;
      let bestFamily = '';
      const fontParseResults = [];

      for (let i = 0; i < uniqueFonts.length; i++) {
        const { family, url } = uniqueFonts[i];
        diagLog('Trying font', i, family.substring(0, 40) + '...');

        // Download
        const buffer = await downloadFont(url);
        if (!buffer) {
          diagLog('  download failed, skip');
          continue;
        }
        diagLog('  downloaded, size:', buffer.byteLength);

        // Parse
        const font = parseFont(buffer);
        if (!font) {
          diagLog('  parse failed, skip');
          continue;
        }
        const numGlyphs = (font.tables && font.tables.maxp) ? font.tables.maxp.numGlyphs : '?';
        diagLog('  parsed, glyphs:', numGlyphs);

        // Build cmap reverse mapping
        const mapping = buildCmapMapping(font);
        diagLog('  uniXXXX mappings found:', mapping.size);

        // Save parse info for potential pixel comparison fallback
        const cmap = font.tables && font.tables.cmap;
        const cmapKeys = cmap && cmap.glyphIndexMap
          ? Object.keys(cmap.glyphIndexMap).map(Number).filter(cp => cp >= 0x4E00 && cp <= 0x9FFF)
          : [];
        fontParseResults.push({ family, url, buffer, font, glyphCount: numGlyphs, cmapKeys });
        diagLog('  cmap CJK keys:', cmapKeys.length);

        if (mapping.size > bestCount) {
          bestFont = font;
          bestMapping = mapping;
          bestCount = mapping.size;
          bestFamily = family;
        }
      }

      if (bestCount === 0) {
        // cmap approach found no swaps → glyph outlines are likely permuted.
        // Fall back to pixel comparison using the font with the most CJK cmap entries.
        diagLog('No cmap swaps found, trying pixel comparison fallback...');
        _status = 'calibrating';

        // Find the font with most CJK cmap keys (best for pixel comparison coverage)
        let biggestInfo = null;
        let biggestKeys = 0;
        for (const info of fontParseResults) {
          if (info.cmapKeys.length > biggestKeys) {
            biggestKeys = info.cmapKeys.length;
            biggestInfo = info;
          }
        }

        if (!biggestInfo || biggestInfo.cmapKeys.length === 0) {
          setError('No font suitable for pixel comparison');
          return;
        }
        diagLog('Using font for pixel comparison:', biggestInfo.family.substring(0, 40), 'with', biggestInfo.cmapKeys.length, 'CJK keys');

        _mapping = await buildPixelMapping(biggestInfo);
        if (_mapping.size === 0) {
          setError('Pixel comparison produced no mappings');
          return;
        }
        _status = 'ready';
        diagLog('Pixel mapping done:', _mapping.size, 'mappings');
      } else {
        _mapping = bestMapping;
        _status = 'ready';
      }

      // Show sample of mappings
      let sample = [];
      let n = 0;
      for (const [cp, ch] of _mapping) {
        if (n++ >= 10) break;
        sample.push(String.fromCodePoint(cp) + '→' + ch);
      }
      diagLog('Sample mappings:', sample.join(' '));

    } catch (err) {
      diagError('pipeline error:', err.message || err);
      setError(err.message || 'Unknown error');
    }
  }

  function setError(msg) {
    _status = 'error';
    _errorMessage = msg;
    diagError(msg);
  }

  // ---- Detection ----

  function isZhihuPage() {
    return ZHIHU_URL_PATTERN.test(window.location.href);
  }

  function extractAllFontFaces() {
    const allFonts = [];
    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.type === CSSRule.FONT_FACE_RULE) {
              const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
              const src = rule.style.getPropertyValue('src');
              const urlMatch = src ? src.match(/url\(["']?([^"')]+)["']?\)/) : null;
              allFonts.push({ family, url: urlMatch ? urlMatch[1] : 'none' });
            }
          }
        } catch (e) { continue; }
      }
    } catch (e) { /* */ }
    return allFonts;
  }

  // ---- Font Loading & Parsing ----

  async function downloadFont(url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        diagError('fetch failed, HTTP', response.status);
        return null;
      }
      return await response.arrayBuffer();
    } catch (err) {
      diagError('download error:', err.message);
      return null;
    }
  }

  function parseFont(buffer) {
    try {
      return opentype.parse(buffer);
    } catch (err) {
      console.error('[zhcp] font-decoder: parse error:', err);
      return null;
    }
  }

  // ---- Glyph Helper ----

  function glyphGetter(font) {
    // Returns a function that reliably gets a glyph by index
    if (!font || !font.glyphs) return i => null;
    if (typeof font.glyphs.get === 'function') return i => font.glyphs.get(i);
    return i => font.glyphs[i];
  }

  // ---- Core: cmap Reverse Mapping ----

  function buildCmapMapping(font) {
    const mapping = new Map();
    const cmap = font.tables && font.tables.cmap;
    if (!cmap || !cmap.glyphIndexMap) return mapping;

    const getGlyph = glyphGetter(font);
    const uniPattern = /^uni([0-9A-Fa-f]{4,6})$/;
    let totalCmap = 0;
    let uniNamed = 0;
    let swapped = 0;

    for (const [unicodeStr, glyphIndex] of Object.entries(cmap.glyphIndexMap)) {
      totalCmap++;
      const encodedCP = parseInt(unicodeStr, 10);
      const glyph = getGlyph(glyphIndex);
      if (!glyph || !glyph.name) continue;

      const match = glyph.name.match(uniPattern);
      if (!match) continue;
      uniNamed++;

      const decodedCP = parseInt(match[1], 16);
      if (decodedCP === encodedCP) continue; // Not a swap, skip
      swapped++;

      const decodedChar = String.fromCodePoint(decodedCP);
      mapping.set(encodedCP, decodedChar);
    }

    diagLog('  cmap entries:', totalCmap, 'uniNamed:', uniNamed, 'swapped:', swapped);
    return mapping;
  }

  // ---- Pixel Comparison Fallback (for glyph-outline-swapped fonts) ----

  async function buildPixelMapping(info) {
    const { buffer, family, cmapKeys } = info;
    const FONT_FAMILY_NAME = 'zhcp-calib-font';

    diagLog('buildPixelMapping: registering font via FontFace...');

    // Step 1: Register custom font via FontFace API for Canvas rendering
    let fontFace;
    try {
      fontFace = new FontFace(FONT_FAMILY_NAME, buffer);
      await fontFace.load();
    } catch (err) {
      diagError('FontFace.load failed:', err.message);
      return new Map();
    }
    document.fonts.add(fontFace);
    await document.fonts.ready;
    diagLog('  font registered, status:', fontFace.status);

    // Step 2: Setup canvas for rendering
    const canvas = document.createElement('canvas');
    const fontSize = 48;
    canvas.width = fontSize;
    canvas.height = fontSize;
    const ctx = canvas.getContext('2d');

    // Characters to compare (limit to 100 max for performance)
    let keys = cmapKeys.filter(cp => cp >= 0x4E00 && cp <= 0x9FFF);
    if (keys.length > 100) keys = keys.slice(0, 100);
    if (keys.length === 0) {
      document.fonts.delete(fontFace);
      return new Map();
    }

    const chars = keys.map(cp => String.fromCodePoint(cp));
    diagLog('  comparing', chars.length, 'characters');

    // Step 3: Render each character in the custom font
    const customImages = [];
    for (let i = 0; i < chars.length; i++) {
      customImages.push(renderChar(canvas, ctx, chars[i], fontSize, FONT_FAMILY_NAME));
    }

    // Step 4: Render each character in PingFang SC (reference)
    const refImages = [];
    for (let i = 0; i < chars.length; i++) {
      refImages.push(renderChar(canvas, ctx, chars[i], fontSize, '"PingFang SC", "Heiti SC", "STHeiti", sans-serif'));
    }

    // Step 5: Cross-compare custom vs reference
    // First check: are self-matches close to 1.0? If so, the custom font isn't rendering
    let selfSum = 0;
    for (let i = 0; i < chars.length; i++) {
      selfSum += pixelSimilarity(customImages[i], refImages[i]);
    }
    const avgSelf = selfSum / chars.length;
    diagLog('  avg self-similarity:', avgSelf.toFixed(3));

    if (avgSelf > 0.95) {
      diagLog('  WARNING: self-matches too high, custom font may not be applied in Canvas');
      document.fonts.delete(fontFace);
      return new Map();
    }

    // Cross-comparison: for each custom glyph, find the best-matching reference glyph
    const mapping = new Map();
    const threshold = 0.55;

    for (let i = 0; i < chars.length; i++) {
      let bestScore = 0;
      let bestIdx = -1;

      for (let j = 0; j < chars.length; j++) {
        const score = pixelSimilarity(customImages[i], refImages[j]);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = j;
        }
      }

      // Diagnostic: log first 3 chars' self-score vs best-score
      if (i < 3) {
        const selfScore = pixelSimilarity(customImages[i], refImages[i]);
        diagLog('  char', i, chars[i], 'self:', selfScore.toFixed(3), 'best:', bestScore.toFixed(3), 'bestIdx:', bestIdx, 'bestChar:', chars[bestIdx]);
      }

      // If the best match is a different character, it's a swap
      if (bestIdx !== i && bestScore > threshold) {
        mapping.set(keys[i], chars[bestIdx]);
      }

      // Progress every 20 chars
      if ((i + 1) % 20 === 0) {
        diagLog('  compared', i + 1, '/', chars.length, '...');
      }
    }

    diagLog('  pixel comparison found', mapping.size, 'swaps (threshold:', threshold + ')');

    // Clean up
    document.fonts.delete(fontFace);
    return mapping;
  }

  function renderChar(canvas, ctx, ch, fontSize, fontFamily) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = fontSize + 'px ' + fontFamily;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(ch, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function pixelSimilarity(a, b) {
    const dataA = a.data;
    const dataB = b.data;
    const len = dataA.length;
    let matchCount = 0;
    const totalPixels = len / 4;

    for (let i = 0; i < len; i += 4) {
      const aOn = dataA[i + 3] > 64;
      const bOn = dataB[i + 3] > 64;

      if (aOn && bOn) {
        // Both pixels on: compare luminance
        const lumA = 0.299 * dataA[i] + 0.587 * dataA[i + 1] + 0.114 * dataA[i + 2];
        const lumB = 0.299 * dataB[i] + 0.587 * dataB[i + 1] + 0.114 * dataB[i + 2];
        if (Math.abs(lumA - lumB) < 48) {
          matchCount++;
        }
      } else if (!aOn && !bOn) {
        // Both pixels off: match
        matchCount++;
      }
    }

    return matchCount / totalPixels;
  }

  // ---- Text Decoding ----

  function applyMapping(text, mapping) {
    if (!mapping || mapping.size === 0) return text;

    let result = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const mapped = mapping.get(cp);
      result += mapped || ch;
    }
    return result;
  }

  function decodeElement(element) {
    if (!_mapping || _mapping.size === 0) return element.innerText;
    return applyMapping(element.innerText, _mapping);
  }

  function decodeRawText(text) {
    if (!_mapping || _mapping.size === 0) return text;
    return applyMapping(text, _mapping);
  }

  // Auto-start the pipeline (fallback if content_script.js init call misses)
  setTimeout(() => init(), 0);

})();
