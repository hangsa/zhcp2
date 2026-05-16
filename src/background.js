// src/background.js - Service Worker
// Handles: keyboard shortcut, sidePanel behavior, message routing

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-selection') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SELECTION' });
    } catch (err) {
      // Page may not have content script loaded
    }
  }
});

// Handle sidePanel open requests (content scripts can't call setOptions)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'OPEN_SIDEPANEL') {
    chrome.sidePanel.openPanel().catch(err => console.error('openPanel failed:', err));
  }
});
