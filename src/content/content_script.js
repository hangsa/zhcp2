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

// Mozilla Readability library loaded via readability-bundle.js (window.Readability)

let currentMode = SELECTION_MODE.INACTIVE;
let selectedBlocks = [];
let _blockIdCounter = 0;
let _suppressStorageChange = false;

function getDecodedText(element) {
  if (window.ZhihuFontDecoder && window.ZhihuFontDecoder.isReady()) {
    return window.ZhihuFontDecoder.decodeElement(element);
  }
  return element.innerText;
}

chrome.runtime.onMessage.addListener(async (message, sender, sendResponse) => {
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
    const result = await saveSelectedBlocksToFile();
    sendResponse(result);
  }
  return true;
});

function startSelectionMode() {
  // 使用 Mozilla Readability 自动识别正文
  const documentClone = document.cloneNode(true);
  const reader = new Readability(documentClone);
  const article = reader.parse();
  const articleElement = article ? findMainContentElement(document) : null;

  if (article && articleElement) {
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
    if (currentMode === SELECTION_MODE.AUTO) {
      currentMode = SELECTION_MODE.MANUAL;
      document.querySelectorAll('.' + HIGHLIGHT_STYLES.AUTO_SUGGEST).forEach(el => {
        el.classList.remove(HIGHLIGHT_STYLES.AUTO_SUGGEST);
      });
      const hint = document.getElementById('zhcp-auto-hint');
      if (hint) hint.remove();
    }
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

async function handleClick(e) {
  if (currentMode !== SELECTION_MODE.MANUAL) return;
  const block = findTextBlock(e.target);
  if (!block) return;

  console.log('[zhcp] handleClick:', block.tagName, block.className);

  e.preventDefault();
  e.stopPropagation();

  if (selectedBlocks.includes(block)) {
    // Deselect
    console.log('[zhcp] deselect block:', block.dataset.zhcpBlockId);
    block.classList.remove(HIGHLIGHT_STYLES.HOVER);
    block.classList.remove(HIGHLIGHT_STYLES.SELECTED);
    delete block.dataset.zhcpBlockId;
    selectedBlocks = selectedBlocks.filter(b => b !== block);
  } else {
    // Select - assign blockId if new
    if (!block.dataset.zhcpBlockId) {
      block.dataset.zhcpBlockId = `b${Date.now()}_${_blockIdCounter++}`;
    }
    console.log('[zhcp] select block:', block.dataset.zhcpBlockId, 'total:', selectedBlocks.length + 1);
    block.classList.remove(HIGHLIGHT_STYLES.HOVER);
    block.classList.add(HIGHLIGHT_STYLES.SELECTED);
    selectedBlocks.push(block);
  }

  // 通过 background 打开 sidePanel（在 await 之前发送，保留 user gesture）
  console.log('[zhcp] sending OPEN_SIDEPANEL');
  try {
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
  } catch (err) {
    console.error('[zhcp] sendMessage OPEN_SIDEPANEL error:', err);
  }

  await saveSelectedBlocksToStorage();

  // 通知侧栏数据已就绪（侧栏可能在 storage 写入完成前已加载）
  console.log('[zhcp] sending BLOCKS_UPDATED');
  chrome.runtime.sendMessage({ type: 'BLOCKS_UPDATED' });
}

function findTextBlock(element) {
  let current = element;
  while (current && current !== document.body) {
    const tagName = current.tagName;
    if (['ARTICLE', 'SECTION', 'DIV', 'P'].includes(tagName)) {
      const text = getDecodedText(current).trim();
      if (text.length > 20) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return null;
}

async function saveSelectedBlocksToStorage() {
  // Read existing storage to preserve sidebar edits
  const result = await chrome.storage.local.get([STORAGE_KEYS.SELECTED_BLOCKS]);
  const existingBlocks = result[STORAGE_KEYS.SELECTED_BLOCKS] || [];
  const existingMap = new Map(existingBlocks.map(b => [b.blockId, b]));

  const blocksData = selectedBlocks.map((block, index) => {
    const blockId = block.dataset.zhcpBlockId;
    const existing = existingMap.get(blockId);
    return {
      blockId: blockId,
      text: existing ? existing.text : getDecodedText(block),
      index: index
    };
  });

  _suppressStorageChange = true;
  await chrome.storage.local.set({
    [STORAGE_KEYS.SELECTED_BLOCKS]: blocksData,
    [STORAGE_KEYS.PAGE_TITLE]: document.title,
    [STORAGE_KEYS.PAGE_URL]: window.location.href,
    [STORAGE_KEYS.EXTRACTION_TIME]: new Date().toISOString()
  });
  console.log('[zhcp] storage written:', blocksData.length, 'blocks, ids:', blocksData.map(b => b.blockId));
  setTimeout(() => { _suppressStorageChange = false; }, 0);
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
  // Clear blockId from tracked elements
  document.querySelectorAll('[data-zhcp-block-id]').forEach(el => {
    delete el.dataset.zhcpBlockId;
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
    if (el && getDecodedText(el).length > 100) return el;
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

  hint.addEventListener('click', async (e) => {
    e.stopPropagation();
    // 接受自动识别结果
    element.classList.remove(HIGHLIGHT_STYLES.AUTO_SUGGEST);
    element.classList.add(HIGHLIGHT_STYLES.SELECTED);
    if (!element.dataset.zhcpBlockId) {
      element.dataset.zhcpBlockId = `b${Date.now()}_${_blockIdCounter++}`;
    }
    if (!selectedBlocks.includes(element)) {
      selectedBlocks.push(element);
    }
    hint.remove();

    // 切换到手动模式，允许取消和追加选择
    currentMode = SELECTION_MODE.MANUAL;

    // 通过 background 打开 sidePanel（在 await 之前发送，保留 user gesture）
    chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });

    await saveSelectedBlocksToStorage();

    // 通知侧栏数据已就绪
    chrome.runtime.sendMessage({ type: 'BLOCKS_UPDATED' });
  });
}

async function saveSelectedBlocksToFile() {
  // Read from storage to include sidebar edits
  const result = await chrome.storage.local.get([STORAGE_KEYS.SELECTED_BLOCKS]);
  const storedBlocks = result[STORAGE_KEYS.SELECTED_BLOCKS] || [];

  if (storedBlocks.length === 0) {
    return { success: false, error: 'No blocks selected' };
  }

  const title = document.title.replace(/[/\\?*|"]/g, '');
  const now = new Date();
  const datetime = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

  const blocksText = storedBlocks.map(b => b.text.trim()).join('\n\n---\n\n');

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

// Listen for storage changes from sidebar (edits, deletes, reorders)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (!changes[STORAGE_KEYS.SELECTED_BLOCKS]) return;
  if (_suppressStorageChange) {
    console.log('[zhcp] onChanged: suppressed (own write)');
    return;
  }
  const oldLen = (changes[STORAGE_KEYS.SELECTED_BLOCKS].oldValue || []).length;
  const newLen = (changes[STORAGE_KEYS.SELECTED_BLOCKS].newValue || []).length;
  console.log('[zhcp] onChanged: storage changed by sidebar, old:', oldLen, 'new:', newLen);
  syncHighlightsFromStorage();
});

function syncHighlightsFromStorage() {
  chrome.storage.local.get([STORAGE_KEYS.SELECTED_BLOCKS]).then(result => {
    const storedBlocks = result[STORAGE_KEYS.SELECTED_BLOCKS] || [];
    const storedIds = new Set(storedBlocks.map(b => b.blockId));

    // Remove highlights from elements no longer in storage
    document.querySelectorAll('[data-zhcp-block-id]').forEach(el => {
      if (!storedIds.has(el.dataset.zhcpBlockId)) {
        el.classList.remove(HIGHLIGHT_STYLES.SELECTED, HIGHLIGHT_STYLES.HOVER);
        delete el.dataset.zhcpBlockId;
      }
    });

    // Rebuild selectedBlocks in storage order
    const idToEl = new Map();
    document.querySelectorAll('[data-zhcp-block-id]').forEach(el => {
      idToEl.set(el.dataset.zhcpBlockId, el);
    });

    selectedBlocks = [];
    storedBlocks.forEach(b => {
      const el = idToEl.get(b.blockId);
      if (el) {
        el.classList.add(HIGHLIGHT_STYLES.SELECTED);
        selectedBlocks.push(el);
      }
    });
  });
}

// Initialize font decoder for Zhihu pages (if loaded)
if (window.ZhihuFontDecoder) {
  window.ZhihuFontDecoder.init();
}