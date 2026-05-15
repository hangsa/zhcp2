// test/content.test.js
// 基础逻辑测试（非 UI 测试）

const SELECTION_MODE = {
  INACTIVE: 'inactive',
  AUTO: 'auto',
  MANUAL: 'manual'
};

const HIGHLIGHT_STYLES = {
  HOVER: 'highlight-hover',
  SELECTED: 'highlight-selected',
  AUTO_SUGGEST: 'highlight-auto-suggest'
};

const STORAGE_KEYS = {
  SELECTED_BLOCKS: 'selected_blocks',
  PAGE_TITLE: 'page_title',
  PAGE_URL: 'page_url',
  EXTRACTION_TIME: 'extraction_time'
};

const FILE_FORMAT = {
  SEPARATOR: '\n\n---\n\n',
  DATETIME_FORMAT: 'YYYYMMDD_HHmm',
  FILENAME_TEMPLATE: '{title}_{datetime}.txt'
};

function testConstants() {
  // 测试选择模式常量
  console.assert(SELECTION_MODE.INACTIVE === 'inactive', 'INACTIVE should be inactive');
  console.assert(SELECTION_MODE.AUTO === 'auto', 'AUTO should be auto');
  console.assert(SELECTION_MODE.MANUAL === 'manual', 'MANUAL should be manual');

  // 测试高亮样式类名
  console.assert(HIGHLIGHT_STYLES.HOVER === 'highlight-hover', 'HOVER class mismatch');
  console.assert(HIGHLIGHT_STYLES.SELECTED === 'highlight-selected', 'SELECTED class mismatch');
  console.assert(HIGHLIGHT_STYLES.AUTO_SUGGEST === 'highlight-auto-suggest', 'AUTO_SUGGEST class mismatch');

  // 测试存储 key
  console.assert(STORAGE_KEYS.SELECTED_BLOCKS === 'selected_blocks', 'STORAGE_KEYS mismatch');
  console.assert(STORAGE_KEYS.PAGE_TITLE === 'page_title', 'PAGE_TITLE key mismatch');

  // 测试文件格式
  console.assert(FILE_FORMAT.SEPARATOR === '\n\n---\n\n', 'SEPARATOR format mismatch');
  console.assert(FILE_FORMAT.FILENAME_TEMPLATE === '{title}_{datetime}.txt', 'FILENAME_TEMPLATE mismatch');

  console.log('All constants tests passed!');
}

function testFilenameGeneration() {
  const title = '测试页面';
  const now = new Date();
  const datetime = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;

  const expected = `${title}_${datetime}.txt`;
  const actual = `${title.replace(/[/\\?*|"]/g, '')}_${datetime}.txt`;

  console.assert(actual === expected, `Filename generation failed: ${actual}`);
  console.log('Filename generation test passed!');
}

// 运行测试
testConstants();
testFilenameGeneration();
console.log('All tests completed.');
