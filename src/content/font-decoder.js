// src/content/font-decoder.js
// Zhihu font anti-crawl decoder using cmap reverse mapping.
// Mechanism: the custom font maps standard CJK codepoints (encoded chars)
// to glyphs whose uniXXXX names reveal the real (decoded) characters.
// We build the reverse map: encoded_codepoint → decoded_character.
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

        if (mapping.size > bestCount) {
          bestFont = font;
          bestMapping = mapping;
          bestCount = mapping.size;
          bestFamily = family;
        }
      }

      if (bestCount === 0) {
        setError('No font with uniXXXX glyph names found');
        return;
      }

      diagLog('Best font:', bestFamily.substring(0, 40) + '...', 'with', bestCount, 'mappings');
      _mapping = bestMapping;
      _status = 'ready';

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
