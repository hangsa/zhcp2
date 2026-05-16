// src/sidebar/sidebar.js

const STORAGE_KEYS = {
  SELECTED_BLOCKS: 'selected_blocks',
  PAGE_TITLE: 'page_title',
  PAGE_URL: 'page_url',
  EXTRACTION_TIME: 'extraction_time'
};

const LLM_STORAGE_KEYS = {
  PROVIDER: 'llm_provider',
  ENDPOINT: 'llm_endpoint',
  MODEL: 'llm_model',
  API_KEY: 'llm_api_key'
};

let blocks = [];
let pageTitle = '';
let pageUrl = '';

function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

const debouncedSave = debounce(async () => {
  await chrome.storage.local.set({ [STORAGE_KEYS.SELECTED_BLOCKS]: blocks });
}, 300);

document.getElementById('closeBtn').addEventListener('click', () => {
  window.close();
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

async function callLLM(text) {
  const result = await chrome.storage.local.get([
    LLM_STORAGE_KEYS.PROVIDER,
    LLM_STORAGE_KEYS.ENDPOINT,
    LLM_STORAGE_KEYS.MODEL,
    LLM_STORAGE_KEYS.API_KEY
  ]);

  if (!result[LLM_STORAGE_KEYS.API_KEY]) {
    throw new Error('请先在设置中配置 LLM');
  }

  const provider = result[LLM_STORAGE_KEYS.PROVIDER];
  const endpoint = result[LLM_STORAGE_KEYS.ENDPOINT];
  const model = result[LLM_STORAGE_KEYS.MODEL];
  const encryptedKey = result[LLM_STORAGE_KEYS.API_KEY];

  // 解密 API Key
  const { decrypt, getDeviceId } = await import('../shared/crypto.js');
  const deviceId = getDeviceId();
  const apiKey = await decrypt(encryptedKey, deviceId);

  // 构建请求
  const prompt = `请清理以下文本，去除版权声明、广告语、导航文字等非正文内容，保留原始段落结构。直接输出清理后的文本，不要解释：

${text}`;

  if (provider === 'anthropic') {
    return await callAnthropic(endpoint, model, apiKey, prompt);
  } else if (provider === 'openai') {
    return await callOpenAI(endpoint, model, apiKey, prompt);
  } else {
    return await callCustom(endpoint, model, apiKey, prompt);
  }
}

async function callAnthropic(endpoint, model, apiKey, prompt) {
  const response = await fetch(endpoint + '/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('AI 请求失败: ' + response.status);
  }

  const data = await response.json();
  return data.content[0].text;
}

async function callOpenAI(endpoint, model, apiKey, prompt) {
  const response = await fetch(endpoint + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    throw new Error('AI 请求失败: ' + response.status);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function callCustom(endpoint, model, apiKey, prompt) {
  // 自定义 Provider 使用相同的聊天格式
  return await callOpenAI(endpoint, model, apiKey, prompt);
}

document.getElementById('aiBtn').addEventListener('click', async () => {
  const aiBtn = document.getElementById('aiBtn');
  const stats = document.getElementById('stats');

  if (blocks.length === 0) {
    alert('请先选择内容');
    return;
  }

  const originalText = blocks.map(b => b.text).join('\n\n---\n\n');

  aiBtn.textContent = '清洗中...';
  aiBtn.classList.add('loading');
  aiBtn.disabled = true;

  try {
    const cleanedText = await callLLM(originalText);

    // 显示确认对话框
    const confirmed = confirm('AI 清洗完成，是否替换原文？\n\n预览：\n' + cleanedText.substring(0, 200) + '...');

    if (confirmed) {
      // Replace with cleaned text, preserving multi-paragraph structure
      const parts = cleanedText.split(/\n{2,}/).filter(p => p.trim());
      const ts = Date.now();
      if (parts.length > 1) {
        blocks = parts.map((text, i) => ({
          blockId: `ai_${ts}_${i}`,
          text: text.trim(),
          index: i
        }));
      } else {
        blocks = [{
          blockId: `ai_${ts}`,
          text: cleanedText.trim(),
          index: 0
        }];
      }
      await chrome.storage.local.set({ [STORAGE_KEYS.SELECTED_BLOCKS]: blocks });
      render();
      stats.textContent = 'AI 清洗完成';
    }
  } catch (err) {
    alert('清洗失败: ' + err.message);
  } finally {
    aiBtn.textContent = 'AI 清洗';
    aiBtn.classList.remove('loading');
    aiBtn.disabled = false;
  }
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

  console.log('[zhcp] sidebar: loadBlocks, count:', blocks.length,
    blocks.length > 0 ? 'ids:' + blocks.map(b => b.blockId).join(',') : '(empty)');
  render();
}

function render() {
  const content = document.getElementById('content');
  const saveBtn = document.getElementById('saveBtn');
  const aiBtn = document.getElementById('aiBtn');
  const stats = document.getElementById('stats');

  if (blocks.length === 0) {
    content.innerHTML = '<div class="empty-state" id="emptyState">点击页面中的段落来添加内容</div>';
    saveBtn.disabled = true;
    aiBtn.disabled = true;
    stats.textContent = '已选 0 段，约 0 字';
    return;
  }

  content.innerHTML = blocks.map((block, index) => `
    <div class="block-item" data-block-id="${block.blockId}" data-index="${index}">
      <div class="block-actions">
        <button class="move-btn move-up-btn" data-block-id="${block.blockId}"${index === 0 ? ' disabled' : ''}>▲</button>
        <button class="move-btn move-down-btn" data-block-id="${block.blockId}"${index === blocks.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="delete-btn" data-block-id="${block.blockId}">×</button>
      </div>
      <textarea class="block-text" rows="${Math.min(Math.ceil(block.text.length / 40), 8)}">${escapeHtml(block.text)}</textarea>
      <div class="block-meta">第 ${index + 1} 段 · ${block.text.length} 字</div>
    </div>
  `).join('');

  saveBtn.disabled = false;
  aiBtn.disabled = false;
  const totalChars = blocks.reduce((sum, b) => sum + b.text.length, 0);
  stats.textContent = `已选 ${blocks.length} 段，约 ${totalChars} 字`;

  // Delete button
  content.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const blockId = e.target.dataset.blockId;
      blocks = blocks.filter(b => b.blockId !== blockId);
      blocks.forEach((b, i) => { b.index = i; });
      await chrome.storage.local.set({ [STORAGE_KEYS.SELECTED_BLOCKS]: blocks });
      render();
    });
  });

  // Move up button
  content.querySelectorAll('.move-up-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const blockId = e.target.dataset.blockId;
      const idx = blocks.findIndex(b => b.blockId === blockId);
      if (idx <= 0) return;
      [blocks[idx - 1], blocks[idx]] = [blocks[idx], blocks[idx - 1]];
      blocks.forEach((b, i) => { b.index = i; });
      await chrome.storage.local.set({ [STORAGE_KEYS.SELECTED_BLOCKS]: blocks });
      render();
    });
  });

  // Move down button
  content.querySelectorAll('.move-down-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const blockId = e.target.dataset.blockId;
      const idx = blocks.findIndex(b => b.blockId === blockId);
      if (idx >= blocks.length - 1) return;
      [blocks[idx], blocks[idx + 1]] = [blocks[idx + 1], blocks[idx]];
      blocks.forEach((b, i) => { b.index = i; });
      await chrome.storage.local.set({ [STORAGE_KEYS.SELECTED_BLOCKS]: blocks });
      render();
    });
  });

  // Textarea edit with debounce
  content.querySelectorAll('.block-text').forEach(textarea => {
    textarea.addEventListener('input', (e) => {
      const blockId = e.target.closest('.block-item').dataset.blockId;
      const block = blocks.find(b => b.blockId === blockId);
      if (!block) return;
      block.text = e.target.value;
      // Update meta label immediately
      const meta = e.target.closest('.block-item').querySelector('.block-meta');
      const idx = blocks.indexOf(block);
      meta.textContent = `第 ${idx + 1} 段 · ${block.text.length} 字`;
      // Update total stats
      const totalChars = blocks.reduce((sum, b) => sum + b.text.length, 0);
      stats.textContent = `已选 ${blocks.length} 段，约 ${totalChars} 字`;
      debouncedSave();
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
    console.log('[zhcp] sidebar: received', message.type);
    loadBlocks();
  }
  sendResponse();
  return true;
});

// 兜底：监听 storage 变更（sidePanel 可能比 storage 写入更早加载完成）
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEYS.SELECTED_BLOCKS]) {
    console.log('[zhcp] sidebar: storage.onChanged, newValue length:',
      (changes[STORAGE_KEYS.SELECTED_BLOCKS].newValue || []).length);
    loadBlocks();
  }
});