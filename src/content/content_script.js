// src/content/content_script.js

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
  currentMode = SELECTION_MODE.MANUAL;
  injectNotificationBar();
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
  selectedBlocks = [];
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