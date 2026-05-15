// src/popup/popup.js

document.getElementById('startBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'START_SELECTION' });
    document.getElementById('status').textContent = '选择模式已开启';
    document.getElementById('startBtn').textContent = '选择中...';
    document.getElementById('startBtn').disabled = true;

    window.close();
  } catch (err) {
    document.getElementById('status').textContent = '无法启动：请刷新页面后重试';
    console.error('Failed to start selection:', err);
  }
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'SAVE_TO_TXT' });
    if (response.success) {
      document.getElementById('status').textContent = '文件已保存';
    } else {
      document.getElementById('status').textContent = '请先选择内容';
    }
  } catch (err) {
    document.getElementById('status').textContent = '请先选择内容';
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

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-selection') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SELECTION' });
    } catch (err) {
      // Page may not have content script loaded
    }
  }
});
