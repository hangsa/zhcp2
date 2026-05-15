// src/settings/settings.js
import { encrypt, decrypt, getDeviceId } from '../shared/crypto.js';

const STORAGE_KEYS = {
  LLM_PROVIDER: 'llm_provider',
  LLM_ENDPOINT: 'llm_endpoint',
  LLM_MODEL: 'llm_model',
  LLM_API_KEY: 'llm_api_key'
};

const PROVIDER_ENDPOINTS = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1'
};

document.getElementById('provider').addEventListener('change', (e) => {
  const endpoint = document.getElementById('endpoint');
  if (!endpoint.value || PROVIDER_ENDPOINTS[document.dataset.prevProvider]) {
    endpoint.value = PROVIDER_ENDPOINTS[e.target.value] || '';
  }
  document.dataset.prevProvider = e.target.value;
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const provider = document.getElementById('provider').value;
  const endpoint = document.getElementById('endpoint').value.trim();
  const model = document.getElementById('model').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();

  if (!endpoint || !model || !apiKey) {
    showStatus('请填写完整信息', 'error');
    return;
  }

  try {
    const deviceId = getDeviceId();
    const encryptedKey = await encrypt(apiKey, deviceId);

    const data = {
      [STORAGE_KEYS.LLM_PROVIDER]: provider,
      [STORAGE_KEYS.LLM_ENDPOINT]: endpoint,
      [STORAGE_KEYS.LLM_MODEL]: model,
      [STORAGE_KEYS.LLM_API_KEY]: encryptedKey
    };

    await chrome.storage.local.set(data);
    showStatus('设置已保存', 'success');
  } catch (err) {
    console.error('Save failed:', err);
    showStatus('保存失败: ' + err.message, 'error');
  }
});

async function loadSettings() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.LLM_PROVIDER,
    STORAGE_KEYS.LLM_ENDPOINT,
    STORAGE_KEYS.LLM_MODEL,
    STORAGE_KEYS.LLM_API_KEY
  ]);

  if (result[STORAGE_KEYS.LLM_PROVIDER]) {
    document.getElementById('provider').value = result[STORAGE_KEYS.LLM_PROVIDER];
  }
  if (result[STORAGE_KEYS.LLM_ENDPOINT]) {
    document.getElementById('endpoint').value = result[STORAGE_KEYS.LLM_ENDPOINT];
  }
  if (result[STORAGE_KEYS.LLM_MODEL]) {
    document.getElementById('model').value = result[STORAGE_KEYS.LLM_MODEL];
  }
  // API Key不解密显示，只显示已保存
  if (result[STORAGE_KEYS.LLM_API_KEY]) {
    document.getElementById('apiKey').placeholder = '已保存（不显示）';
  }
}

function showStatus(message, type) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = 'status ' + type;
  status.style.display = 'block';
}

loadSettings();