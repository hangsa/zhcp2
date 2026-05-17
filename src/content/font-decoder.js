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
  const SIMILARITY_THRESHOLD = 0.60;

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

  let _status = 'idle';
  let _errorMessage = null;
  let _mapping = null;
  let _initCalled = false;
  let _decodeRate = 0;

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

      // Step 3: Register font with FontFace API (so Canvas can use it)
      _status = 'registering';
      const registered = await registerFont(fontInfo.family, buffer);
      if (!registered) {
        console.warn('[zhcp] font-decoder: font registration failed, canvas text may not render');
      } else {
        console.log('[zhcp] font-decoder: font registered with FontFace API');
      }

      // Step 4: Parse font with opentype.js (for glyph data / cmap access)
      _status = 'parsing';
      const font = parseFont(buffer);
      if (!font) {
        setError('字体解析失败');
        return;
      }
      console.log('[zhcp] font-decoder: font parsed, glyphs:', font.glyphs.length);

      // Step 5: Enumerate PUA codepoints
      // Diagnostic: dump glyph data to understand font structure
      console.log('[zhcp] font-decoder: --- glyph diagnostic ---');
      for (let i = 0; i < font.glyphs.length; i++) {
        const g = font.glyphs[i];
        console.log('[zhcp] font-decoder: glyph', i,
          'name:', g.name,
          'unicode:', g.unicode,
          'unicodes:', JSON.stringify(g.unicodes),
          'index:', g.index);
      }
      // Also dump cmap table structure
      const cmap = font.tables && font.tables.cmap;
      if (cmap) {
        console.log('[zhcp] font-decoder: cmap keys:', Object.keys(cmap));
        console.log('[zhcp] font-decoder: cmap glyphIndexMap type:', typeof cmap.glyphIndexMap);
        if (cmap.glyphIndexMap) {
          const sampleKeys = Object.keys(cmap.glyphIndexMap).slice(0, 20);
          console.log('[zhcp] font-decoder: cmap glyphIndexMap sample keys:', sampleKeys);
        }
      }
      console.log('[zhcp] font-decoder: --- end diagnostic ---');

      const puaCodepoints = getPUACodepoints(font);
      if (puaCodepoints.length === 0) {
        setError('未检测到编码字符');
        return;
      }
      console.log('[zhcp] font-decoder: PUA codepoints found:', puaCodepoints.length);

      // Step 6: Calibrate — build mapping
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

              const urlMatch = src.match(/url\(["']?([^"')]+)["']?\)/);
              if (!urlMatch) continue;

              const url = urlMatch[1];
              if (/PingFang|Microsoft|Noto|Hiragino|sans-serif|serif|Arial|Helvetica/i.test(family)) {
                continue;
              }

              candidateFonts.push({ family: family, url: url });
            }
          }
        } catch (e) {
          continue;
        }
      }
    } catch (e) {
      // Stylesheet access errors
    }

    if (candidateFonts.length === 0) return null;

    const hashedFont = candidateFonts.find(f => /^[a-z0-9]{6,}/i.test(f.family));
    const result = hashedFont || candidateFonts[0];

    try {
      result.url = new URL(result.url, window.location.href).href;
    } catch (e) {
      // Keep original URL
    }

    return result;
  }

  // ---- Font Loading & Registration ----

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

  async function registerFont(family, buffer) {
    try {
      const fontFace = new FontFace(family, buffer);
      await fontFace.load();
      document.fonts.add(fontFace);
      return true;
    } catch (err) {
      console.error('[zhcp] font-decoder: FontFace registration error:', err);
      return false;
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
    if (!font.glyphs) return [];
    for (const glyph of font.glyphs) {
      const unicodes = glyph.unicodes || (glyph.unicode != null ? [glyph.unicode] : []);
      for (const cp of unicodes) {
        if (isPUA(cp)) {
          puaSet.add(cp);
        }
      }
    }
    return [...puaSet];
  }

  // ---- Glyph Name Fast Path ----

  function tryDecodeFromGlyphNames(font, puaCodepoints) {
    // Many anti-crawl fonts use uniXXXX naming where XXXX is the real Unicode hex.
    // Pattern: uni<hex> e.g. uni8D5E = U+8D5E = '赞'
    const mapping = new Map();
    const uniPattern = /^uni([0-9A-Fa-f]{4,6})$/;

    for (const cp of puaCodepoints) {
      const glyph = font.glyphs.find(g => g.unicode === cp || (g.unicodes && g.unicodes.includes(cp)));
      if (!glyph || !glyph.name) continue;

      const match = glyph.name.match(uniPattern);
      if (match) {
        const realCodePoint = parseInt(match[1], 16);
        try {
          const realChar = String.fromCodePoint(realCodePoint);
          if (realChar && realChar !== '�') {
            mapping.set(cp, realChar);
          }
        } catch (e) {
          continue;
        }
      }
    }

    return mapping;
  }

  // ---- Anchor Collection ----

  function isCJKChar(ch) {
    const cp = ch.codePointAt(0);
    return (cp >= 0x4e00 && cp <= 0x9fff) ||
           (cp >= 0x3400 && cp <= 0x4dbf) ||
           (cp >= 0xf900 && cp <= 0xfaff);
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

  // ---- Glyph Features (for pre-filtering) ----

  function computeGlyphFeatures(font, codepoint) {
    try {
      const glyph = font.glyphs.find(g => g.unicode === codepoint);
      if (!glyph) return null;

      const path = glyph.getPath(0, 0, 64);
      if (!path || !path.commands || path.commands.length === 0) return null;

      let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
      let pointCount = 0;
      let contourCount = 0;

      for (const cmd of path.commands) {
        if (cmd.type === 'M') contourCount++;
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

      const width = xmax - xmin;
      const height = ymax - ymin;
      if (width <= 1 || height <= 1) return null;

      return {
        aspectRatio: width / height,
        boundsWidth: width,
        boundsHeight: height,
        contourCount: contourCount,
        pointCount: pointCount
      };
    } catch (e) {
      return null;
    }
  }

  function featuresMatch(fa, fb) {
    if (!fa || !fb) return true; // Allow through if can't compare

    const arDiff = Math.abs(fa.aspectRatio - fb.aspectRatio);
    const arOk = arDiff < 0.35;

    const widthRatio = fa.boundsWidth / Math.max(fb.boundsWidth, 1);
    const heightRatio = fa.boundsHeight / Math.max(fb.boundsHeight, 1);
    const sizeOk = widthRatio > 0.4 && widthRatio < 2.5 &&
                   heightRatio > 0.4 && heightRatio < 2.5;

    const ccOk = fa.contourCount === fb.contourCount ||
                 Math.abs(fa.contourCount - fb.contourCount) <= 1;

    return arOk && sizeOk && ccOk;
  }

  // ---- Canvas Rendering ----

  function renderGlyphToImageData(char, fontStr) {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

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
      const pixelA = dataA[i] < 200;
      const pixelB = dataB[i] < 200;

      if (pixelA || pixelB) {
        totalPixels++;
        if (pixelA === pixelB) {
          matchScore++;
        } else {
          const diff = Math.abs(dataA[i] - dataB[i]);
          matchScore += Math.max(0, 1 - diff / 255);
        }
      }
    }

    return totalPixels > 0 ? matchScore / totalPixels : 0;
  }

  // ---- Calibration Main Loop ----

  async function calibrate(font, puaCodepoints, fontFamily) {
    const mapping = new Map();

    // --- Fast path: try glyph name patterns first ---
    console.log('[zhcp] font-decoder: trying glyph name fast path...');
    const nameMapping = tryDecodeFromGlyphNames(font, puaCodepoints);
    if (nameMapping.size > 0) {
      console.log('[zhcp] font-decoder: glyph name fast path decoded',
        nameMapping.size, 'characters');
      for (const [cp, ch] of nameMapping) {
        mapping.set(cp, ch);
      }
      // Remove already-decoded PUA codepoints
      puaCodepoints = puaCodepoints.filter(cp => !mapping.has(cp));
    }

    if (puaCodepoints.length === 0) {
      console.log('[zhcp] font-decoder: all codepoints decoded via glyph names');
      return mapping;
    }

    // --- Slow path: geometric pre-filter + pixel comparison ---
    const anchors = buildAnchorList();
    if (anchors.length === 0) {
      console.warn('[zhcp] font-decoder: no anchors found');
      return mapping;
    }

    const customFontStr = `64px "${fontFamily}", sans-serif`;

    // Pre-compute glyph features for PUA codepoints (from opentype.js)
    const puaFeatures = new Map();
    for (const cp of puaCodepoints) {
      const f = computeGlyphFeatures(font, cp);
      if (f) puaFeatures.set(cp, f);
    }

    // Pre-compute anchor features using Canvas-based estimation
    // Render anchor chars in REF_FONT, extract bounding box from ImageData
    console.log('[zhcp] font-decoder: rendering', anchors.length, 'anchor glyphs...');
    const anchorData = new Map(); // char → { imageData, features }
    for (const ch of anchors) {
      const imgData = renderGlyphToImageData(ch, REF_FONT);
      const data = imgData.data;
      let xmin = CANVAS_SIZE, xmax = 0, ymin = CANVAS_SIZE, ymax = 0;
      let pixelCount = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 200) {
          const x = (i / 4) % CANVAS_SIZE;
          const y = Math.floor((i / 4) / CANVAS_SIZE);
          xmin = Math.min(xmin, x);
          xmax = Math.max(xmax, x);
          ymin = Math.min(ymin, y);
          ymax = Math.max(ymax, y);
          pixelCount++;
        }
      }
      const w = xmax - xmin;
      const h = ymax - ymin;
      anchorData.set(ch, {
        imageData: imgData,
        features: {
          aspectRatio: h > 0 ? w / h : 1,
          boundsWidth: w,
          boundsHeight: h,
          contourCount: 1, // Canvas can't give contour count; use default
          pointCount: pixelCount
        }
      });
    }

    // For each PUA codepoint, render with CUSTOM font and compare against anchors
    console.log('[zhcp] font-decoder: calibrating', puaCodepoints.length,
      'PUA codepoints via pixel comparison...');
    let matchedCount = 0;

    for (let i = 0; i < puaCodepoints.length; i++) {
      const cp = puaCodepoints[i];
      const puaChar = String.fromCodePoint(cp);
      const puaFeatures_i = puaFeatures.get(cp);
      const puaImageData = renderGlyphToImageData(puaChar, customFontStr);

      let bestMatch = null;
      let bestScore = 0;

      for (const [ch, ad] of anchorData) {
        // Pre-filter using geometric features
        if (puaFeatures_i && ad.features) {
          if (!featuresMatch(puaFeatures_i, ad.features)) {
            continue;
          }
        }

        const score = computeImageSimilarity(puaImageData, ad.imageData);
        if (score > bestScore && score >= SIMILARITY_THRESHOLD) {
          bestScore = score;
          bestMatch = ch;
        }
      }

      if (bestMatch) {
        mapping.set(cp, bestMatch);
        anchorData.delete(bestMatch);
        matchedCount++;
      }

      // Yield to main thread every 10 glyphs
      if (i % 10 === 9) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    console.log('[zhcp] font-decoder: pixel comparison matched',
      matchedCount, '/', puaCodepoints.length, 'characters');
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
