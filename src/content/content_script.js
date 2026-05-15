// src/content/content_script.js
// Readability.js integration for auto content detection

// Constants (inlined to avoid ES module import issues in content scripts)
const SELECTION_MODE = {
  INACTIVE: 'inactive',
  AUTO: 'auto',
  MANUAL: 'manual'
};

const HIGHLIGHT_STYLES = {
  HOVER: 'highlight-hover',
  SELECTED: 'highlight-selected',
  AUTO_SUGGEST: 'highlight-auto-suggest'
};

const STORAGE_KEYS = {
  SELECTED_BLOCKS: 'selected_blocks',
  PAGE_TITLE: 'page_title',
  PAGE_URL: 'page_url',
  EXTRACTION_TIME: 'extraction_time'
};

// ============================================================
// Readability.js core functions (inlined to avoid ES module import issues)
// ============================================================

function parseDocument(document) {
  const article = findArticleElement(document);
  if (!article) return null;

  return {
    title: document.title || getTitleFromH1(document) || 'Untitled',
    content: extractContent(article),
    textContent: article.innerText,
    length: article.innerText.length,
    excerpt: getExcerpt(article),
    byline: getByline(article),
    siteName: document.domain
  };
}

function findArticleElement(document) {
  // 优先查找 article 标签
  const article = document.querySelector('article');
  if (article && article.innerText.length > 100) return article;

  // 查找 main 或 role="main"
  const main = document.querySelector('main');
  if (main && main.innerText.length > 100) return main;

  const roleMain = document.querySelector('[role="main"]');
  if (roleMain && roleMain.innerText.length > 100) return roleMain;

  // 查找最大文本块
  const candidates = document.querySelectorAll('div, section');
  let best = null;
  let bestLength = 0;

  for (const candidate of candidates) {
    const text = candidate.innerText.trim();
    // 过滤导航栏和明显非正文内容
    if (text.length > bestLength && !isNoise(candidate)) {
      bestLength = text.length;
      best = candidate;
    }
  }

  return best && bestLength > 200 ? best : null;
}

function isNoise(element) {
  const classAndId = (element.className + ' ' + element.id).toLowerCase();
  const noisePatterns = ['nav', 'menu', 'sidebar', 'comment', 'footer', 'header', 'advertisement', 'social', 'share', 'related'];
  return noisePatterns.some(p => classAndId.includes(p));
}

function extractContent(element) {
  // 克隆并清理
  const clone = element.cloneNode(true);
  // 移除脚本和样式
  clone.querySelectorAll('script, style, noscript, iframe, form').forEach(el => el.remove());
  return clone.innerHTML;
}

function getTitleFromH1(document) {
  const h1 = document.querySelector('h1');
  return h1 ? h1.innerText.trim() : null;
}

function getByline(element) {
  // 查找常见的作者信息
  const bylineSelectors = ['.author', '.byline', '[rel="author"]', '.writer'];
  for (const selector of bylineSelectors) {
    const el = element.querySelector(selector);
    if (el) return el.innerText.trim();
  }
  return null;
}

function getExcerpt(element) {
  const text = element.innerText.trim();
  // 取前 200 字符作为摘要
  return text.substring(0, 200) + (text.length > 200 ? '...' : '');
}

// ============================================================
// End Readability.js core functions
// ============================================================

let currentMode = SELECTION_MODE.INACTIVE;
let selectedBlocks = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_SELECTION') {
    startSelectionMode();
    sendResponse({ success: true });
  } else if (message.type === 'STOP_SELECTION') {
    stopSelectionMode();
    sendResponse({ success: true });
  } else if (message.type === 'GET_SELECTED_BLOCKS') {
    sendResponse({ blocks: selectedBlocks });
  } else if (message.type === 'CLEAR_SELECTED_BLOCKS') {
    selectedBlocks = [];
    clearAllHighlights();
    sendResponse({ success: true });
  } else if (message.type === 'TOGGLE_SELECTION') {
    if (currentMode === SELECTION_MODE.INACTIVE) {
      startSelectionMode();
    } else {
      stopSelectionMode();
    }
    sendResponse({ success: true });
  } else if (message.type === 'SAVE_TO_TXT') {
    const result = saveSelectedBlocksToFile();
    sendResponse(result);
  }
  return true;
});

function startSelectionMode() {
  // 尝试自动识别正文
  const article = parseDocument(document);
  const articleElement = article ? findMainContentElement(document) : null;

  if (article && article.content && articleElement) {
    // 自动模式
    currentMode = SELECTION_MODE.AUTO;
    injectNotificationBar();
    articleElement.classList.add(HIGHLIGHT_STYLES.AUTO_SUGGEST);
    showAutoSuggestHint(articleElement);
  } else {
    // 回退到手动模式
    currentMode = SELECTION_MODE.MANUAL;
    injectNotificationBar();
  }
  setupMouseListeners();
}

function stopSelectionMode() {
  currentMode = SELECTION_MODE.INACTIVE;
  removeNotificationBar();
  removeMouseListeners();
  clearAllHighlights();
}

function injectNotificationBar() {
  const existingBar = document.getElementById('zhcp-notification-bar');
  if (existingBar) existingBar.remove();

  const bar = document.createElement('div');
  bar.id = 'zhcp-notification-bar';
  bar.className = 'mode-notification-bar';
  bar.innerHTML = `
    <span>选择模式已开启 · 按 Esc 退出</span>
    <button class="manual-btn">手动选择</button>
  `;
  document.body.appendChild(bar);

  bar.querySelector('.manual-btn').addEventListener('click', () => {
    // 已经是手动模式，保持现状
  });

  document.addEventListener('keydown', handleEscapeKey);
}

function removeNotificationBar() {
  const bar = document.getElementById('zhcp-notification-bar');
  if (bar) bar.remove();
  document.removeEventListener('keydown', handleEscapeKey);
}

function handleEscapeKey(e) {
  if (e.key === 'Escape') {
    stopSelectionMode();
    chrome.runtime.sendMessage({ type: 'SELECTION_STOPPED' });
  }
}

function setupMouseListeners() {
  document.addEventListener('mouseover', handleMouseOver, true);
  document.addEventListener('mouseout', handleMouseOut, true);
  document.addEventListener('click', handleClick, true);
}

function removeMouseListeners() {
  document.removeEventListener('mouseover', handleMouseOver, true);
  document.removeEventListener('mouseout', handleMouseOut, true);
  document.removeEventListener('click', handleClick, true);
}

function handleMouseOver(e) {
  if (currentMode !== SELECTION_MODE.MANUAL) return;
  const block = findTextBlock(e.target);
  if (!block) return;
  if (!block.classList.contains(HIGHLIGHT_STYLES.SELECTED)) {
    block.classList.add(HIGHLIGHT_STYLES.HOVER);
  }
}

function handleMouseOut(e) {
  if (currentMode !== SELECTION_MODE.MANUAL) return;
  const block = findTextBlock(e.target);
  if (!block) return;
  if (!block.classList.contains(HIGHLIGHT_STYLES.SELECTED)) {
    block.classList.remove(HIGHLIGHT_STYLES.HOVER);
  }
}

function handleClick(e) {
  if (currentMode !== SELECTION_MODE.MANUAL) return;
  const block = findTextBlock(e.target);
  if (!block) return;

  e.preventDefault();
  e.stopPropagation();

  if (selectedBlocks.includes(block)) {
    block.classList.remove(HIGHLIGHT_STYLES.HOVER);
    block.classList.remove(HIGHLIGHT_STYLES.SELECTED);
    selectedBlocks = selectedBlocks.filter(b => b !== block);
  } else {
    block.classList.remove(HIGHLIGHT_STYLES.HOVER);
    block.classList.add(HIGHLIGHT_STYLES.SELECTED);
    selectedBlocks.push(block);
  }

  saveSelectedBlocksToStorage();

  // 打开 sidePanel
  chrome.sidePanel.openPanel().catch(() => {
    // sidePanel 可能未启用，忽略错误
  });
}

function findTextBlock(element) {
  let current = element;
  while (current && current !== document.body) {
    const tagName = current.tagName;
    if (['ARTICLE', 'SECTION', 'DIV', 'P'].includes(tagName)) {
      const text = current.innerText.trim();
      if (text.length > 20) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return null;
}

function saveSelectedBlocksToStorage() {
  const blocksData = selectedBlocks.map(block => ({
    text: block.innerText,
    index: selectedBlocks.indexOf(block)
  }));

  chrome.storage.local.set({
    [STORAGE_KEYS.SELECTED_BLOCKS]: blocksData,
    [STORAGE_KEYS.PAGE_TITLE]: document.title,
    [STORAGE_KEYS.PAGE_URL]: window.location.href,
    [STORAGE_KEYS.EXTRACTION_TIME]: new Date().toISOString()
  });
}

function clearAllHighlights() {
  document.querySelectorAll('.' + HIGHLIGHT_STYLES.HOVER).forEach(el => {
    el.classList.remove(HIGHLIGHT_STYLES.HOVER);
  });
  document.querySelectorAll('.' + HIGHLIGHT_STYLES.SELECTED).forEach(el => {
    el.classList.remove(HIGHLIGHT_STYLES.SELECTED);
  });
  document.querySelectorAll('.' + HIGHLIGHT_STYLES.AUTO_SUGGEST).forEach(el => {
    el.classList.remove(HIGHLIGHT_STYLES.AUTO_SUGGEST);
  });
  // Remove auto hint if exists
  const hint = document.getElementById('zhcp-auto-hint');
  if (hint) hint.remove();
  selectedBlocks = [];
}

function findMainContentElement(doc) {
  const selectors = ['article', 'main', '[role="main"]', '.post-content', '.article-content', '.entry-content'];
  for (const selector of selectors) {
    const el = doc.querySelector(selector);
    if (el && el.innerText.length > 100) return el;
  }
  return null;
}

function showAutoSuggestHint(element) {
  const existingHint = document.getElementById('zhcp-auto-hint');
  if (existingHint) existingHint.remove();

  const hint = document.createElement('div');
  hint.id = 'zhcp-auto-hint';
  hint.style.cssText = `
    position: absolute;
    top: -30px;
    left: 50%;
    transform: translateX(-50%);
    background: #185FA5;
    color: white;
    padding: 4px 12px;
    border-radius: 4px;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
    z-index: 2147483647;
  `;
  hint.textContent = '已识别正文，点击接受';
  element.style.position = 'relative';
  element.appendChild(hint);

  hint.addEventListener('click', (e) => {
    e.stopPropagation();
    // 接受自动识别结果
    element.classList.remove(HIGHLIGHT_STYLES.AUTO_SUGGEST);
    element.classList.add(HIGHLIGHT_STYLES.SELECTED);
    if (!selectedBlocks.includes(element)) {
      selectedBlocks.push(element);
    }
    saveSelectedBlocksToStorage();
    hint.remove();
  });
}

async function saveSelectedBlocksToFile() {
  if (selectedBlocks.length === 0) {
    return { success: false, error: 'No blocks selected' };
  }

  const title = document.title.replace(/[/\\?*|"]/g, '');
  const now = new Date();
  const datetime = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

  const blocksText = selectedBlocks.map(block => block.innerText.trim()).join('\n\n---\n\n');

  const content = `标题：《${title}》
来源：${window.location.href}
提取时间：${now.toLocaleString('zh-CN')}
---

${blocksText}`;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const filename = `${title}_${datetime}.txt`;

  await chrome.downloads.download({
    url: url,
    filename: filename,
    saveAs: true
  });

  URL.revokeObjectURL(url);
  return { success: true };
}