// src/content/readability.js
// Mozilla Readability 核心逻辑（简化版，适配 Extension 环境）

function parseDocument(document) {
  const article = findArticleElement(document);
  if (!article) return null;

  return {
    title: document.title || getTitleFromH1(document) || 'Untitled',
    content: extractContent(article),
    textContent: article.innerText,
    length: article.innerText.length,
    excerpt: getExcerpt(article),
    byline: getByline(article),
    siteName: document.domain
  };
}

function findArticleElement(document) {
  // 优先查找 article 标签
  const article = document.querySelector('article');
  if (article && article.innerText.length > 100) return article;

  // 查找 main 或 role="main"
  const main = document.querySelector('main');
  if (main && main.innerText.length > 100) return main;

  const roleMain = document.querySelector('[role="main"]');
  if (roleMain && roleMain.innerText.length > 100) return roleMain;

  // 查找最大文本块
  const candidates = document.querySelectorAll('div, section');
  let best = null;
  let bestLength = 0;

  for (const candidate of candidates) {
    const text = candidate.innerText.trim();
    // 过滤导航栏和明显非正文内容
    if (text.length > bestLength && !isNoise(candidate)) {
      bestLength = text.length;
      best = candidate;
    }
  }

  return best && bestLength > 200 ? best : null;
}

function isNoise(element) {
  const classAndId = (element.className + ' ' + element.id).toLowerCase();
  const noisePatterns = ['nav', 'menu', 'sidebar', 'comment', 'footer', 'header', 'advertisement', 'social', 'share', 'related'];
  return noisePatterns.some(p => classAndId.includes(p));
}

function extractContent(element) {
  // 克隆并清理
  const clone = element.cloneNode(true);
  // 移除脚本和样式
  clone.querySelectorAll('script, style, noscript, iframe, form').forEach(el => el.remove());
  return clone.innerHTML;
}

function getTitleFromH1(document) {
  const h1 = document.querySelector('h1');
  return h1 ? h1.innerText.trim() : null;
}

function getByline(element) {
  // 查找常见的作者信息
  const bylineSelectors = ['.author', '.byline', '[rel="author"]', '.writer'];
  for (const selector of bylineSelectors) {
    const el = element.querySelector(selector);
    if (el) return el.innerText.trim();
  }
  return null;
}

function getExcerpt(element) {
  const text = element.innerText.trim();
  // 取前 200 字符作为摘要
  return text.substring(0, 200) + (text.length > 200 ? '...' : '');
}

export { parseDocument };