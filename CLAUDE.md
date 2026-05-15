# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome Extension (MV3) that bypasses CSS/JS copy restrictions to extract text from paywalled pages. Target users: personal note-takers and researchers.

## Architecture

```
zhcp2/
├── docs/
│   └── design.md          # Product spec and technical decisions
└── (extension files to be created)
    ├── manifest.json      # Extension config (MV3)
    ├── content_script.js  # Injected into pages — handles highlighting & text extraction
    ├── popup.html/js      # Popup panel for controls
    └── background.js      # Service worker (if needed)
```

Core mechanism: `element.innerText` reads visible text bypassing `user-select: none`.

## Development

1. **MVP path**: `manifest.json` + `content.js` + `popup.html` to validate core flow (highlight → click → extract → download)
2. **Key APIs**: `chrome.storage.local` (persist selections), `chrome.downloads` (save TXT)
3. **Style isolation**: Use Shadow DOM or high-priority CSS to prevent page overrides
4. **Watch for**: Shadow DOM content (innerText can't penetrate), lazy-loaded content (use MutationObserver), iframe content (needs `all_frames: true` in manifest)

## Commands

No build tools yet — this is a browser extension, not a Node project. Load via `chrome://extensions` → "Load unpacked" pointing to the project directory.
