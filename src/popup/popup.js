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
    console.log('[zhcp] popup: START_SELECTION sent');
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
  // Popup 可直接调 sidePanel API（不需要通过 background 中转）
  const openFn = chrome.sidePanel?.open || chrome.sidePanel?.openPanel;

  if (!openFn) {
    document.getElementById('status').textContent = '当前浏览器不支持侧栏面板';
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      document.getElementById('status').textContent = '无法获取当前标签页';
      return;
    }
    await openFn.call(chrome.sidePanel, { tabId: tab.id });
    window.close();
  } catch (err) {
    console.error('[zhcp] popup: sidePanel open failed:', err.message || err);
    document.getElementById('status').textContent = '无法打开侧栏，请刷新页面后重试';
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
