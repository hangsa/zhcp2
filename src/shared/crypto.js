// src/shared/crypto.js
// AES-GCM 加密工具（使用 Web Crypto API）

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;

// 将字符串编码为 Uint8Array
function stringToBytes(str) {
  return new TextEncoder().encode(str);
}

// 将 Uint8Array 解码为字符串
function bytesToString(bytes) {
  return new TextDecoder().decode(bytes);
}

// 生成随机 IV
function generateIV() {
  return crypto.getRandomValues(new Uint8Array(12));
}

// 从密码派生密钥
async function deriveKey(password, salt) {
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    stringToBytes(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    passwordKey,
    { name: ALGORITHM, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  );
}

// 加密
async function encrypt(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = generateIV();
  const key = await deriveKey(password, salt);

  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    stringToBytes(plaintext)
  );

  // 组合 salt + iv + encrypted
  const result = new Uint8Array(salt.length + iv.length + encrypted.byteLength);
  result.set(salt, 0);
  result.set(iv, salt.length);
  result.set(new Uint8Array(encrypted), salt.length + iv.length);

  return btoa(String.fromCharCode(...result));
}

// 解密
async function decrypt(ciphertext, password) {
  const data = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));

  const salt = data.slice(0, 16);
  const iv = data.slice(16, 28);
  const encrypted = data.slice(28);

  const key = await deriveKey(password, salt);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv },
    key,
    encrypted
  );

  return bytesToString(new Uint8Array(decrypted));
}

// 生成设备唯一标识（用于加密密钥派生）
function getDeviceId() {
  // 使用浏览器指纹作为设备 ID
  const components = [
    navigator.userAgent,
    screen.width + 'x' + screen.height,
    navigator.language,
    new Date().getTimezoneOffset()
  ];
  let hash = 0;
  for (const comp of components) {
    for (let i = 0; i < comp.length; i++) {
      const char = comp.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
  }
  return 'zhcp-device-' + Math.abs(hash).toString(16);
}

export { encrypt, decrypt, getDeviceId };