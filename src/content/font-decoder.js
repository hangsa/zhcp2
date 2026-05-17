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
        const getGlyph = glyphGetter(font);
        const cmapKeys = [];
        if (cmap && cmap.glyphIndexMap) {
          for (const [cpStr, gid] of Object.entries(cmap.glyphIndexMap)) {
            const cp = Number(cpStr);
            if (cp >= 0x4E00 && cp <= 0x9FFF) {
              cmapKeys.push({ cp, gid });
            }
          }
        }
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
        // Fall back to pixel comparison on ALL fonts to maximize character coverage.
        diagLog('No cmap swaps found, trying pixel comparison fallback on all fonts...');
        _status = 'calibrating';

        const candidates = fontParseResults.filter(info => info.cmapKeys.length > 0);
        if (candidates.length === 0) {
          setError('No font suitable for pixel comparison');
          return;
        }

        _mapping = new Map();
        for (let i = 0; i < candidates.length; i++) {
          const info = candidates[i];
          diagLog('Pixel comparing font', i, info.family.substring(0, 40), 'with', info.cmapKeys.length, 'CJK keys');
          const mapping = await buildPixelMapping(info);
          diagLog('  font', i, 'produced', mapping.size, 'mappings');
          for (const [k, v] of mapping) {
            if (!_mapping.has(k)) _mapping.set(k, v);
          }
        }

        if (_mapping.size === 0) {
          setError('Pixel comparison produced no mappings across any font');
          return;
        }
        _status = 'ready';
        diagLog('Pixel mapping done:', _mapping.size, 'total mappings across', candidates.length, 'fonts');
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
    const { buffer, font, cmapKeys } = info;
    const FONT_FAMILY_NAME = 'zhcp-calib-font';

    diagLog('buildPixelMapping: registering font via FontFace...');

    // Step 1: Register custom font via FontFace API (still needed for reference validation)
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

    // Step 2: Setup canvas
    const canvas = document.createElement('canvas');
    const fontSize = 72;
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext('2d');

    // Limit to 100 chars for performance
    const keys = cmapKeys.slice(0, 100);
    if (keys.length === 0) {
      document.fonts.delete(fontFace);
      return new Map();
    }

    const chars = keys.map(k => String.fromCodePoint(k.cp));
    const getGlyph = glyphGetter(font);
    diagLog('  comparing', chars.length, 'characters (path-based)');

    // Step 3: Render glyph paths for custom font (opentype.js path → Canvas, bypasses font engine)
    const customImages = [];
    for (let i = 0; i < keys.length; i++) {
      const glyph = getGlyph(keys[i].gid);
      customImages.push(glyph ? renderGlyphPath(canvas, ctx, glyph, fontSize) : blankImage(canvas, ctx));
    }

    // Step 4: Render reference chars in PingFang SC (text-based)
    const refImages = [];
    for (let i = 0; i < chars.length; i++) {
      refImages.push(renderChar(canvas, ctx, chars[i], fontSize, '"PingFang SC", "Heiti SC", "STHeiti", sans-serif'));
    }

    // Step 5: Cross-compare path renderings vs reference
    const selfScores = new Array(chars.length);
    let selfSum = 0;
    for (let i = 0; i < chars.length; i++) {
      selfScores[i] = pixelSimilarity(customImages[i], refImages[i]);
      selfSum += selfScores[i];
    }
    const avgSelf = selfSum / chars.length;
    diagLog('  avg self-similarity (path vs text):', avgSelf.toFixed(3));

    if (avgSelf > 0.95) {
      diagLog('  WARNING: self-matches too high, custom font may not be applied');
      document.fonts.delete(fontFace);
      return new Map();
    }

    // Cross-comparison with margin check
    const mapping = new Map();
    const threshold = 0.55;
    const margin = 0.10;
    const projMargin = 0.04;
    let skippedCount = 0;
    let projRescued = 0;

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

      // Diagnostic: first 5 chars
      if (i < 5) {
        const tag = bestIdx !== i ? (bestScore > selfScores[i] + margin ? 'SWAP' : 'SKIP') : 'SELF';
        diagLog('  char', i, chars[i], 'self:', selfScores[i].toFixed(3), 'best:', bestScore.toFixed(3), 'bestChar:', chars[bestIdx], tag);
      }
      // Also log if "我" (U+6211) is among the keys
      if (keys[i].cp === 0x6211) {
        diagLog('  [我] self:', selfScores[i].toFixed(3), 'best:', bestScore.toFixed(3), 'bestChar:', chars[bestIdx], bestIdx !== i && bestScore > selfScores[i] + margin ? 'SWAP' : (bestIdx !== i ? 'SKIP(no-margin)' : 'SELF'));
      }

      if (bestIdx !== i && bestScore > threshold && bestScore > selfScores[i] + margin) {
        mapping.set(keys[i].cp, chars[bestIdx]);
      } else if (bestIdx !== i && bestScore > threshold) {
        // Boundary: use projection profile similarity as tiebreaker
        const projSelf = projectionSimilarity(customImages[i], refImages[i]);
        const projBest = projectionSimilarity(customImages[i], refImages[bestIdx]);
        if (projBest > projSelf + projMargin) {
          mapping.set(keys[i].cp, chars[bestIdx]);
          projRescued++;
          if (projRescued <= 5) {
            diagLog('  PROJ+ char', i, chars[i], '→', chars[bestIdx], 'pix:', (bestScore - selfScores[i]).toFixed(3), 'proj:', (projBest - projSelf).toFixed(3));
          }
        } else {
          skippedCount++;
          if (skippedCount <= 5) {
            diagLog('  SKIP char', i, chars[i], 'self:', selfScores[i].toFixed(3), 'best:', bestScore.toFixed(3), 'bestChar:', chars[bestIdx], 'pix-mgn:', (bestScore - selfScores[i]).toFixed(3), 'proj-mgn:', (projBest - projSelf).toFixed(3));
          }
        }
      }

      if ((i + 1) % 20 === 0) {
        diagLog('  compared', i + 1, '/', chars.length, '...');
      }
    }

    diagLog('  pixel comparison:', mapping.size, 'swaps (', projRescued, 'proj-rescued,', skippedCount, 'skipped, margin:', margin + ', proj-margin:', projMargin + ')');

    document.fonts.delete(fontFace);
    return mapping;
  }

  function blankImage(canvas, ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function renderGlyphPath(canvas, ctx, glyph, fontSize) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    try {
      // Get bounding box to center the glyph on canvas
      const path = glyph.getPath(0, 0, fontSize);
      const box = path.getBoundingBox();
      const gw = box.x2 - box.x1;
      const gh = box.y2 - box.y1;
      const cx = (canvas.width - gw) / 2 - box.x1;
      const cy = (canvas.height - gh) / 2 - box.y1;

      const centered = glyph.getPath(cx, cy, fontSize);
      centered.fill = '#000';
      centered.draw(ctx);
    } catch (e) {
      // Some glyphs may have no outline
    }
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }

  function renderChar(canvas, ctx, ch, fontSize, fontFamily) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = fontSize + 'px ' + fontFamily;
    ctx.fillStyle = '#000';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(ch, canvas.width / 2, canvas.height / 2);
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

  // Projection profile similarity — robust to slight position shifts.
  // Collapses 2D image into 1D horizontal + vertical density histograms.
  function projectionSimilarity(a, b) {
    const w = a.width, h = a.height;
    const dataA = a.data, dataB = b.data;
    let dotA = 0, dotB = 0, dotAB = 0;

    for (let x = 0; x < w; x++) {
      let colA = 0, colB = 0;
      for (let y = 0; y < h; y++) {
        colA += dataA[(y * w + x) * 4 + 3] > 64 ? 1 : 0;
        colB += dataB[(y * w + x) * 4 + 3] > 64 ? 1 : 0;
      }
      dotA += colA * colA;
      dotB += colB * colB;
      dotAB += colA * colB;
    }

    for (let y = 0; y < h; y++) {
      let rowA = 0, rowB = 0;
      const base = y * w * 4;
      for (let x = 0; x < w; x++) {
        rowA += dataA[base + x * 4 + 3] > 64 ? 1 : 0;
        rowB += dataB[base + x * 4 + 3] > 64 ? 1 : 0;
      }
      dotA += rowA * rowA;
      dotB += rowB * rowB;
      dotAB += rowA * rowB;
    }

    const norm = Math.sqrt(dotA) * Math.sqrt(dotB);
    return norm > 0 ? dotAB / norm : 0;
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
