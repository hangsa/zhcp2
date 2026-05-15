// src/background.js - Service Worker
// Handles: keyboard shortcut, sidePanel behavior

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
