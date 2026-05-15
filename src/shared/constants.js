// src/shared/constants.js
export const SELECTION_MODE = {
  INACTIVE: 'inactive',
  AUTO: 'auto',      // Readability 自动识别模式
  MANUAL: 'manual'   // 手动点选模式
};

export const HIGHLIGHT_STYLES = {
  HOVER: 'highlight-hover',    // 蓝色描边边框（悬停）
  SELECTED: 'highlight-selected',  // 浅蓝填充 + 虚线边框（选中）
  AUTO_SUGGEST: 'highlight-auto-suggest'  // 蓝色虚线框（Readability 推荐）
};

export const STORAGE_KEYS = {
  SELECTED_BLOCKS: 'selected_blocks',
  PAGE_TITLE: 'page_title',
  PAGE_URL: 'page_url',
  EXTRACTION_TIME: 'extraction_time'
};

export const FILE_FORMAT = {
  SEPARATOR: '\n\n---\n\n',  // 段落分隔符：前后空行 + 分隔线
  DATETIME_FORMAT: 'YYYYMMDD_HHmm',
  FILENAME_TEMPLATE: '{title}_{datetime}.txt'
};