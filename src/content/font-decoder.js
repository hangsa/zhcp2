// src/content/font-decoder.js
// Zhihu font anti-crawl decoder using anchor calibration.
// IIFE - exposes window.ZhihuFontDecoder for use by content_script.js

(function () {
  'use strict';

  // ---- Constants ----

  const PUA_RANGES = [
    [0xe000, 0xf8ff], // BMP Private Use Area
    [0xf0000, 0xffffd], // Supplementary PUA-A
    [0x100000, 0x10fffd] // Supplementary PUA-B
  ];

  const REF_FONT = '64px "PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Hiragino Sans GB", sans-serif';
  const CANVAS_SIZE = 64;
  const SIMILARITY_THRESHOLD = 0.75;

  // Anchor characters — common Chinese chars from Zhihu UI + top-100 frequency list
  const FALLBACK_ANCHORS = [
    '赞', '同', '收', '藏', '评', '论', '关', '注', '分', '享',
    '举', '报', '编', '辑', '删', '除', '回', '复', '发', '布',
    '首', '页', '发', '现', '等', '你', '来', '答', '搜', '索',
    '登', '录', '注', '册', '设', '置', '写', '文', '章', '视',
    '频', '提', '问', '更', '多', '取', '消', '确', '定', '保',
    '存', '热', '榜', '推', '荐', '关', '于', '隐', '私', '条',
    '款', '协', '议', '帮', '助', '中', '心', '意', '见', '反',
    '馈', '创', '作', '者', '知', '乎', '盐', '选', '会', '员',
    '消', '息', '通', '知', '专', '栏', '圆', '桌', '直', '播',
    '电', '子', '书', '下', '载', '开', '通', '邀', '请', '已',
    '谢', '邀', '人', '也', '在', '看', '了', '看', '说', '好',
    '的', '一', '是', '不', '了', '在', '有', '我', '他', '这',
    '们', '来', '到', '时', '大', '地', '为', '子', '中', '会',
    '生', '国', '和', '自', '可', '过', '家', '能', '多', '然',
    '心', '方', '成', '行', '现', '都', '对', '动', '里', '经',
    '用', '上', '学', '年', '间', '得', '要', '下', '出', '种',
    '面', '后', '力', '前', '所', '又', '去', '之', '与', '进',
    '工', '本', '而', '如', '道', '法', '体', '全', '开', '天',
    '从', '些', '新', '当', '两', '无', '日', '意', '么', '部'
  ];

  const ZHIHU_URL_PATTERN = /zhihu\.com|zhuanlan\.zhihu\.com/;

  // ---- State ----

  let _status = 'idle'; // idle|detecting|downloading|parsing|calibrating|ready|error
  let _errorMessage = null;
  let _mapping = null; // Map<number, string> — PUA codepoint → real character
  let _initCalled = false;
  let _decodeRate = 0; // 0-1

  // ---- Public API ----

  window.ZhihuFontDecoder = {
    init: init,
    isReady: function () { return _status === 'ready'; },
    decodeElement: decodeElement,
    decodeRawText: decodeRawText,
    getStatus: function () { return _status; },
    getError: function () { return _errorMessage; },
    getDecodeRate: function () { return _decodeRate; }
  };

  // ---- Entry Point ----

  async function init() {
    if (_initCalled) return;
    _initCalled = true;

    if (!isZhihuPage()) {
      console.log('[zhcp] font-decoder: not a Zhihu page, skip');
      return;
    }

    console.log('[zhcp] font-decoder: detected Zhihu page, starting pipeline');

    try {
      // Step 1: Find custom @font-face
      _status = 'detecting';
      const fontInfo = extractFontFaceRule();
      if (!fontInfo) {
        setError('未找到自定义字体');
        return;
      }
      console.log('[zhcp] font-decoder: found font:', fontInfo.family, fontInfo.url);

      // Step 2: Download font
      _status = 'downloading';
      const buffer = await downloadFont(fontInfo.url);
      if (!buffer) {
        setError('字体下载失败');
        return;
      }
      console.log('[zhcp] font-decoder: font downloaded, size:', buffer.byteLength);

      // Step 3: Parse font
      _status = 'parsing';
      const font = parseFont(buffer);
      if (!font) {
        setError('字体解析失败');
        return;
      }
      console.log('[zhcp] font-decoder: font parsed, glyphs:', font.glyphs.length);

      // Step 4: Enumerate PUA codepoints
      const puaCodepoints = getPUACodepoints(font);
      if (puaCodepoints.length === 0) {
        setError('未检测到编码字符');
        return;
      }
      console.log('[zhcp] font-decoder: PUA codepoints found:', puaCodepoints.length);

      // Step 5: Calibrate — build mapping
      _status = 'calibrating';
      _mapping = await calibrate(font, puaCodepoints, fontInfo.family);
      _decodeRate = puaCodepoints.length > 0
        ? _mapping.size / puaCodepoints.length
        : 0;
      _status = 'ready';
      console.log('[zhcp] font-decoder: calibration done, mapped:',
        _mapping.size, '/', puaCodepoints.length,
        '(' + (_decodeRate * 100).toFixed(1) + '%)');

    } catch (err) {
      console.error('[zhcp] font-decoder: pipeline error:', err);
      setError(err.message || '未知错误');
    }
  }

  function setError(msg) {
    _status = 'error';
    _errorMessage = msg;
    console.error('[zhcp] font-decoder:', msg);
  }

  // ---- Detection ----

  function isZhihuPage() {
    return ZHIHU_URL_PATTERN.test(window.location.href);
  }

  function extractFontFaceRule() {
    const candidateFonts = [];

    try {
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.type === CSSRule.FONT_FACE_RULE) {
              const family = rule.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
              const src = rule.style.getPropertyValue('src');
              if (!family || !src) continue;

              // Look for url("...") in src
              const urlMatch = src.match(/url\(["']?([^"')]+)["']?\)/);
              if (!urlMatch) continue;

              const url = urlMatch[1];
              // Skip common system fonts
              if (/PingFang|Microsoft|Noto|Hiragino|sans-serif|serif|Arial|Helvetica/i.test(family)) {
                continue;
              }

              candidateFonts.push({ family: family, url: url });
            }
          }
        } catch (e) {
          // Cross-origin stylesheet — can't read rules, skip
          continue;
        }
      }
    } catch (e) {
      // Stylesheet access errors
    }

    if (candidateFonts.length === 0) return null;

    // Try to find a font that looks like a data-hiding font
    // Strategy: prefer fonts with short, hashed-like names (typical of anti-crawl)
    // Fall back to the first non-standard font
    const hashedFont = candidateFonts.find(f => /^[a-z0-9]{6,}/i.test(f.family));
    const result = hashedFont || candidateFonts[0];

    // Resolve relative URLs
    try {
      result.url = new URL(result.url, window.location.href).href;
    } catch (e) {
      // If resolution fails, keep original
    }

    return result;
  }

  // ---- Font Loading ----

  async function downloadFont(url) {
    try {
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
        console.error('[zhcp] font-decoder: fetch failed, status:', response.status);
        return null;
      }
      return await response.arrayBuffer();
    } catch (err) {
      console.error('[zhcp] font-decoder: download error:', err);
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

  // ---- PUA Enumeration ----

  function isPUA(codepoint) {
    if (codepoint === undefined || codepoint === null) return false;
    for (const [start, end] of PUA_RANGES) {
      if (codepoint >= start && codepoint <= end) return true;
    }
    return false;
  }

  function getPUACodepoints(font) {
    const puaSet = new Set();
    if (font.tables && font.tables.cmap) {
      for (const [codepoint] of font.tables.cmap.glyphIndexMap) {
        if (isPUA(codepoint)) {
          puaSet.add(codepoint);
        }
      }
    }
    return [...puaSet];
  }

  // ---- Anchor Collection ----

  function isCJKChar(ch) {
    const cp = ch.codePointAt(0);
    return (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
           (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
           (cp >= 0xf900 && cp <= 0xfaff);    // CJK Compatibility Ideographs
  }

  function collectAnchorsFromPage() {
    const UI_SELECTORS = [
      '.AppHeader', '[class*="Header"]', '[class*="header"]',
      'button', '[role="button"]', '.Button',
      '[class*="action"]', '[class*="Action"]',
      '[role="navigation"]', 'nav', 'a',
      '[class*="menu"]', '[class*="Menu"]',
      '.ContentItem-actions'
    ];

    const chars = new Set();
    for (const selector of UI_SELECTORS) {
      try {
        document.querySelectorAll(selector).forEach(el => {
          // Skip large text blocks (likely article content)
          const text = el.textContent || '';
          if (text.length > 100) return;
          for (const ch of text) {
            if (isCJKChar(ch)) {
              chars.add(ch);
            }
          }
        });
      } catch (e) {
        continue;
      }
    }

    return [...chars];
  }

  function buildAnchorList() {
    const pageAnchors = collectAnchorsFromPage();
    const merged = new Set([...pageAnchors, ...FALLBACK_ANCHORS]);
    const result = [...merged];

    // Sort: page anchors first (more reliable), then fallback
    const pageSet = new Set(pageAnchors);
    result.sort((a, b) => {
      const aPage = pageSet.has(a) ? 0 : 1;
      const bPage = pageSet.has(b) ? 0 : 1;
      return aPage - bPage;
    });

    console.log('[zhcp] font-decoder: anchors collected, page:', pageAnchors.length,
      'total:', result.length);
    return result;
  }

  // ---- Canvas Rendering ----

  function renderGlyphToImageData(char, fontStr) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Black text, centered
    ctx.fillStyle = '#000000';
    ctx.font = fontStr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(char, CANVAS_SIZE / 2, CANVAS_SIZE / 2);

    return ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
  }

  // ---- Image Similarity ----

  function computeImageSimilarity(a, b) {
    const dataA = a.data;
    const dataB = b.data;
    let matchScore = 0;
    let totalPixels = 0;

    for (let i = 0; i < dataA.length; i += 4) {
      const pixelA = dataA[i] < 200; // Not white = glyph pixel
      const pixelB = dataB[i] < 200;

      if (pixelA || pixelB) {
        totalPixels++;
        if (pixelA === pixelB) {
          matchScore++;
        } else {
          // Partial match based on intensity difference
          const diff = Math.abs(dataA[i] - dataB[i]);
          matchScore += Math.max(0, 1 - diff / 255);
        }
      }
    }

    return totalPixels > 0 ? matchScore / totalPixels : 0;
  }

  // ---- Glyph Features (for pre-filtering) ----

  function computeGlyphFeatures(glyph) {
    if (!glyph || !glyph.path) return null;

    const path = glyph.path;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    let pointCount = 0;
    let contourCount = 0;

    try {
      // opentype.js path.commands: {type, x, y}
      contourCount = (path.commands || []).filter(c => c.type === 'M').length;
      for (const cmd of (path.commands || [])) {
        if (cmd.x !== undefined) {
          xmin = Math.min(xmin, cmd.x);
          xmax = Math.max(xmax, cmd.x);
          pointCount++;
        }
        if (cmd.y !== undefined) {
          ymin = Math.min(ymin, cmd.y);
          ymax = Math.max(ymax, cmd.y);
        }
      }
    } catch (e) {
      return null;
    }

    const width = xmax - xmin;
    const height = ymax - ymin;
    if (width <= 0 || height <= 0) return null;

    return {
      aspectRatio: width / height,
      density: pointCount / (width * height),
      contourCount: contourCount
    };
  }

  function featuresSimilar(fa, fb) {
    if (!fa || !fb) return true; // Can't compare, allow through

    const arDiff = Math.abs(fa.aspectRatio - fb.aspectRatio);
    const arOk = arDiff < 0.4;

    const ccOk = fa.contourCount === fb.contourCount;

    return arOk && ccOk;
  }

  // ---- Calibration Main Loop ----

  async function calibrate(font, puaCodepoints, fontFamily) {
    const mapping = new Map();
    const anchors = buildAnchorList();

    if (anchors.length === 0) {
      console.warn('[zhcp] font-decoder: no anchors found');
      return mapping;
    }

    const customFontStr = `64px "${fontFamily}", sans-serif`;

    // Render all anchors with REFERENCE font (system font)
    console.log('[zhcp] font-decoder: rendering', anchors.length, 'anchor glyphs...');
    const anchorData = new Map(); // char → ImageData
    for (const ch of anchors) {
      anchorData.set(ch, renderGlyphToImageData(ch, REF_FONT));
    }

    // Pre-compute glyph features for PUA codepoints
    const puaGlyphFeatures = new Map();
    for (const cp of puaCodepoints) {
      const glyph = font.glyphs.find(g => g.unicode === cp);
      if (glyph) {
        puaGlyphFeatures.set(cp, computeGlyphFeatures(glyph));
      }
    }

    // For each PUA codepoint, render with CUSTOM font and compare against anchors
    console.log('[zhcp] font-decoder: calibrating', puaCodepoints.length, 'PUA codepoints...');
    let matchedCount = 0;

    for (let i = 0; i < puaCodepoints.length; i++) {
      const cp = puaCodepoints[i];
      const puaChar = String.fromCodePoint(cp);
      const puaImageData = renderGlyphToImageData(puaChar, customFontStr);
      const puaFeatures = puaGlyphFeatures.get(cp);

      let bestMatch = null;
      let bestScore = 0;

      for (const [ch, anchorImageData] of anchorData) {
        // Skip if this anchor is already mapped
        const anchorFeatures = { aspectRatio: 0, density: 0, contourCount: 0 };
        // Pre-filter: compare feature vectors (lightweight)
        // For anchors, we don't have glyph data from the custom font,
        // so pre-filtering is limited to pixel comparison directly.

        const score = computeImageSimilarity(puaImageData, anchorImageData);
        if (score > bestScore && score >= SIMILARITY_THRESHOLD) {
          bestScore = score;
          bestMatch = ch;
        }
      }

      if (bestMatch) {
        mapping.set(cp, bestMatch);
        // Remove matched anchor to speed up subsequent comparisons
        anchorData.delete(bestMatch);
        matchedCount++;
      }

      // Yield to main thread every 10 glyphs
      if (i % 10 === 9) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    console.log('[zhcp] font-decoder: matched', matchedCount, '/', puaCodepoints.length, 'characters');
    return mapping;
  }

  // ---- Text Decoding ----

  function applyMapping(text, mapping) {
    if (!mapping || mapping.size === 0) return text;

    let result = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      // Handle surrogate pairs (supplementary planes)
      if (cp > 0xffff) {
        const mapped = mapping.get(cp);
        result += mapped || ch;
      } else {
        const mapped = mapping.get(cp);
        result += mapped || ch;
      }
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

  // Auto-start the pipeline
  setTimeout(() => init(), 0);

})();
