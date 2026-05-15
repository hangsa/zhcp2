// src/sidebar/sidebar.js

const STORAGE_KEYS = {
  SELECTED_BLOCKS: 'selected_blocks',
  PAGE_TITLE: 'page_title',
  PAGE_URL: 'page_url',
  EXTRACTION_TIME: 'extraction_time'
};

let blocks = [];
let pageTitle = '';
let pageUrl = '';

document.getElementById('closeBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLOSE_SIDEPANEL' });
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  if (blocks.length === 0) return;

  const now = new Date();
  const datetime = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const title = pageTitle.replace(/[/\\?*|"]/g, '');

  const blocksText = blocks.map(b => b.text.trim()).join('\n\n---\n\n');
  const content = `标题：《${title}》
来源：${pageUrl}
提取时间：${now.toLocaleString('zh-CN')}
---

${blocksText}`;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const filename = `${title}_${datetime}.txt`;

  await chrome.downloads.download({ url, filename, saveAs: true });
  URL.revokeObjectURL(url);
});

async function loadBlocks() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.SELECTED_BLOCKS,
    STORAGE_KEYS.PAGE_TITLE,
    STORAGE_KEYS.PAGE_URL
  ]);

  blocks = result[STORAGE_KEYS.SELECTED_BLOCKS] || [];
  pageTitle = result[STORAGE_KEYS.PAGE_TITLE] || '';
  pageUrl = result[STORAGE_KEYS.PAGE_URL] || '';

  render();
}

function render() {
  const content = document.getElementById('content');
  const emptyState = document.getElementById('emptyState');
  const saveBtn = document.getElementById('saveBtn');
  const stats = document.getElementById('stats');

  if (blocks.length === 0) {
    content.innerHTML = '<div class="empty-state" id="emptyState">点击页面中的段落来添加内容</div>';
    saveBtn.disabled = true;
    stats.textContent = '已选 0 段，约 0 字';
    return;
  }

  content.innerHTML = blocks.map((block, index) => `
    <div class="block-item" data-index="${index}">
      <textarea class="block-text" rows="${Math.min(Math.ceil(block.text.length / 40), 8)}">${escapeHtml(block.text)}</textarea>
      <div class="block-meta">第 ${index + 1} 段 · ${block.text.length} 字</div>
      <button class="delete-btn" data-index="${index}">×</button>
    </div>
  `).join('');

  saveBtn.disabled = false;
  const totalChars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  stats.textContent = `已选 ${blocks.length} 段，约 ${totalChars} 字`;

  // 绑定事件
  content.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const index = parseInt(e.target.dataset.index);
      blocks.splice(index, 1);
      await chrome.storage.local.set({ [STORAGE_KEYS.SELECTED_BLOCKS]: blocks });
      render();
      // 通知 content script 更新高亮
      chrome.runtime.sendMessage({ type: 'BLOCKS_UPDATED', blocks });
    });
  });

  content.querySelectorAll('.block-text').forEach((textarea, index) => {
    textarea.addEventListener('input', async (e) => {
      blocks[index].text = e.target.value;
      await chrome.storage.local.set({ [STORAGE_KEYS.SELECTED_BLOCKS]: blocks });
      const totalChars = blocks.reduce((sum, b) => sum + b.text.length, 0);
      stats.textContent = `已选 ${blocks.length} 段，约 ${totalChars} 字`;
    });
  });
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 初始化
loadBlocks();

// 监听来自 content script 的更新
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'BLOCKS_UPDATED' || message.type === 'SELECTION_STOPPED') {
    loadBlocks();
  }
  sendResponse();
  return true;
});