# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (MV3) that bypasses CSS/JS copy restrictions to extract text from paywalled pages. Core mechanism: `element.innerText` reads visible text even when `user-select: none` is set. All data stays local — no cloud storage.

## Architecture

```
zhcp2/
├── manifest.json                  # MV3 config: permissions, content_scripts, side_panel, commands, background
├── package.json                   # npm deps: @mozilla/readability
├── scripts/
│   └── bundle-readability.js      # Bundles @mozilla/readability into content-script-compatible file
├── src/
│   ├── background.js              # Service worker: keyboard shortcut (Alt+E), sidePanel behavior
│   ├── content/
│   │   ├── readability-bundle.js  # Generated: Mozilla Readability + JSDOMParser (window.Readability)
│   │   ├── content_script.js      # Injected at document_end — selection modes, highlighting, TXT download
│   │   └── highlight.css          # Hover/selected/auto-suggest styles (!important to resist page overrides)
│   ├── popup/
│   │   ├── popup.html             # Action popup (280px) — "开始选择" button, status, shortcut hint
│   │   └── popup.js               # Sends START_SELECTION/TOGGLE_SELECTION to content script
│   ├── sidebar/
│   │   ├── sidebar.html           # Side panel (320px) — selected blocks list, edit/delete, save, AI clean
│   │   └── sidebar.js             # Reads chrome.storage, renders blocks, handles save+LLM calls
│   ├── settings/
│   │   ├── settings.html          # LLM config page — Provider/Endpoint/Model/API Key
│   │   └── settings.js            # AES-GCM encrypts API key before storage
│   └── shared/
│       ├── constants.js           # Shared enums (ES module — not usable by content_script, see below)
│       └── crypto.js              # AES-GCM + PBKDF2 encryption via Web Crypto API
└── test/
    └── content.test.js            # Constants + filename generation assertions (run in browser console)
```

### Critical: ES module imports don't work in content_scripts

`content_script.js` has constants **inlined** — it cannot use `import` from `shared/constants.js`. Chrome MV3 content scripts declared in manifest.json's `"js"` array don't support ES modules. The `@mozilla/readability` library is bundled via `scripts/bundle-readability.js` into a plain IIFE that exposes `window.Readability`.

`settings.js` and `sidebar.js` **can** use `import` since they're loaded as `<script type="module">` in their respective HTML pages.

### Rebuilding the Readability bundle

After `npm install`, run: `node scripts/bundle-readability.js`

### Message flow

```
popup.js  ──START_SELECTION/TOGGLE_SELECTION──▶  content_script.js
background.js  ──TOGGLE_SELECTION (via Alt+E)──▶  content_script.js
popup.js  ◀──SELECTION_STOPPED─────────────────  content_script.js
content_script.js  ──writes to──▶  chrome.storage.local  ◀──reads──  sidebar.js
sidebar.js  ◀──BLOCKS_UPDATED─────────────────  (via runtime.onMessage)
```

Key message types: `START_SELECTION`, `STOP_SELECTION`, `TOGGLE_SELECTION`, `SAVE_TO_TXT`, `GET_SELECTED_BLOCKS`, `CLEAR_SELECTED_BLOCKS`, `SELECTION_STOPPED`, `BLOCKS_UPDATED`.

### Dual selection mode

On `START_SELECTION`, `content_script.js` uses Mozilla Readability to auto-detect the article:
- **AUTO mode**: If an article is found, it gets a dashed outline + "已识别正文，点击接受" hint. Clicking accepts it → switches to MANUAL mode. Clicking "手动选择" in the notification bar switches to manual without accepting.
- **MANUAL mode** (fallback or after accepting auto): Hover shows dashed blue outline, click locks selection (solid border + light blue fill). Click again to deselect. Esc exits.

When any block is selected, `chrome.sidePanel` is opened automatically.

## Commands

- **Load extension**: `chrome://extensions` → "Load unpacked" → select project root. Reload after any code change.
- **Rebuild Readability bundle**: `node scripts/bundle-readability.js` (needed after `npm install` or Readability updates)
- **Run tests**: Copy `test/content.test.js` into browser DevTools console. No Node test runner.

## Storage

Uses `chrome.storage.local`:

| Key | Purpose |
|-----|---------|
| `selected_blocks` | Array of `{ text, index }` objects |
| `page_title`, `page_url`, `extraction_time` | Metadata for TXT generation |
| `llm_provider`, `llm_endpoint`, `llm_model` | Plain-text LLM config |
| `llm_api_key` | AES-GCM encrypted (key derived from device fingerprint via PBKDF2) |

## TXT output format

Filename: `《页面标题》_YYYYMMDD_HHmm.txt`

```
标题：《页面标题》
来源：https://...
提取时间：YYYY-MM-DD HH:mm
---

段落内容...

---

段落内容...
```

Blocks are separated by `\n\n---\n\n`.
