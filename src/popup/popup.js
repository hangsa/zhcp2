// src/popup/popup.js

document.getElementById('startBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.id) {
    document.getElementById('status').textContent = '无法获取当前标签页';
    return;
  }

  // 检查是否为受限页面
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:'))) {
    document.getElementById('status').textContent = '此页面不支持使用插件';
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION' });
    document.getElementById('status').textContent = '选择模式已开启';
    document.getElementById('startBtn').textContent = '选择中...';
    document.getElementById('startBtn').disabled = true;

    window.close();
  } catch (err) {
    console.error('Failed to start selection:', err);
    if (err.message?.includes('Could not establish connection')) {
      document.getElementById('status').textContent = '请刷新页面后重试';
    } else {
      document.getElementById('status').textContent = '错误：' + (err.message?.substring(0, 30) || '未知');
    }
  }
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  // 通过 background 打开 sidePanel，由 sidePanel 处理保存逻辑
  try {
    await chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });
    window.close();
  } catch (err) {
    document.getElementById('status').textContent = '无法打开侧栏：请先选择内容';
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SELECTION_STOPPED') {
    document.getElementById('startBtn').textContent = '开始选择';
    document.getElementById('startBtn').disabled = false;
    document.getElementById('status').textContent = '点击按钮激活选择模式';
  }
  sendResponse();
  return true;
});

// Keyboard shortcut handled in background.js service worker
