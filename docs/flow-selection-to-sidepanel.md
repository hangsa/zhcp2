# 选中块后流程说明

## 一、系统流程（数据层面）

```
                           ┌──────────────────────┐
                           │   chrome.storage      │
                           │      .local           │
                           └──┬────────────┬───────┘
                    写入/合并  │            │ 读取
              ┌───────────────┘            └───────────────┐
              ▼                                            ▼
┌─────────────────────────┐                  ┌─────────────────────────┐
│   content_script.js     │                  │     sidebar.js          │
│                         │   onChanged       │                         │
│  selectedBlocks[]       │◄─────────────────│  blocks[]               │
│  (DOM Element 引用)     │  (sidebar 删除/   │  ({blockId,text,index}) │
│                         │   排序/编辑后)     │                         │
│  blockId 打在 DOM 上    │                  │  textarea 编辑 (debounce)│
│  data-zhcp-block-id     │                  │  ▲▼ 排序 / × 删除       │
└─────────────────────────┘                  └─────────────────────────┘
```

## 二、选中块的完整执行链路

以「用户在 MANUAL 模式下点击一个段落块」为例：

```
用户 click 页面段落
  │
  ▼
handleClick()                          [content_script.js:156]
  │
  ├─ findTextBlock(e.target)           [向上遍历找 ARTICLE/SECTION/DIV/P]
  ├─ 判断: selectedBlocks.includes(block) ?
  │
  ├───【选中分支】
  │   ├─ 生成 blockId                  "b1715872800_0"
  │   ├─ block.dataset.zhcpBlockId = blockId
  │   ├─ block.classList.add('highlight-selected')  蓝色实线+浅蓝填充
  │   └─ selectedBlocks.push(block)
  │
  ├───【取消分支】
  │   ├─ block.classList.remove('highlight-selected', 'highlight-hover')
  │   ├─ delete block.dataset.zhcpBlockId
  │   └─ selectedBlocks.filter(b => b !== block)
  │
  ▼
  │【选中/取消后 — 关键顺序：先发消息，后写存储】
  │
  ├─ 1. chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' })
  │     ↑ 必须在 await 之前发送，保留 click 事件的 user gesture
  │       chrome.sidePanel.openPanel() 要求 user gesture 上下文
  │
  ├─ 2. await saveSelectedBlocksToStorage()  ← async 写入 storage
  │
  └─ 3. chrome.runtime.sendMessage({ type: 'BLOCKS_UPDATED' })
        ↑ 通知侧栏数据已就绪（兜底：侧栏可能在写入完成前加载）
  │
  ▼
background.js onMessage                [background.js:21]
  │
  └─ chrome.sidePanel.openPanel()
       │
       ▼
     Chrome 加载 sidebar.html
       │
       ▼
     sidebar.js loadBlocks()           [sidebar.js:198]
       │
       ├─ 读 storage: blocks, pageTitle, pageUrl
       └─ render()                     [sidebar.js:212]
            │
            ├─ 生成 DOM: .block-item > .block-actions(▲▼×) + textarea + .block-meta
            ├─ 绑定事件: 编辑(debounce 300ms) / 删除 / ▲上移 / ▼下移
            └─ 更新统计: "已选 N 段，约 M 字"
```

## 三、侧栏操作 → 页面同步链路

```
sidebar.js 用户操作
  │
  ├─ 编辑 textarea
  │   └─ input → debounce(300ms) → storage.set({selected_blocks})
  │
  ├─ 点击 × 删除
  │   └─ blocks.filter → storage.set({selected_blocks}) → render()
  │
  └─ 点击 ▲ 上移 / ▼ 下移
      └─ blocks 交换 → storage.set({selected_blocks}) → render()
            │
            ▼
chrome.storage.onChanged 触发          [content_script.js:340]
  │
  ├─ _suppressStorageChange? → 跳过 (content script 自己的写入)
  │
  └─ 否则 → syncHighlightsFromStorage()  [content_script.js:347]
       │
       ├─ 读 storage 最新 selected_blocks
       ├─ 对比 blockId 集合:
       │   ├─ 不在 storage 中 → 移除高亮, delete dataset.zhcpBlockId
       │   └─ 仍在 storage 中 → 保留/添加 highlight-selected
       └─ 按 storage 顺序重建 selectedBlocks[] 数组
```

## 四、用户操作流程

```
┌─────────────────────────────────────────────────────────────────┐
│  1. 激活选择模式                                                  │
│     方式 A: 点击扩展图标 → popup → 点击「开始选择」                  │
│     方式 B: 键盘 Alt+E                                           │
│     → 页面顶部出现蓝色提示条「选择模式已开启 · 按 Esc 退出」          │
└─────────────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┴────────────────┐
          ▼                                 ▼
┌─────────────────────┐          ┌─────────────────────┐
│  AUTO 模式（识别成功）│          │  MANUAL 模式（回退）  │
│                     │          │                     │
│  正文区域出现蓝色虚线  │          │  鼠标悬停 → 虚线高亮   │
│  「已识别正文，       │          │  点击 → 实线+填充锁定  │
│   点击接受」         │          │  再次点击 → 取消选择   │
│                     │          │                     │
│  点击接受 → 锁定正文  │          │  可多次点击叠加多块    │
│  切换到 MANUAL 模式  │          │                     │
└─────────┬───────────┘          └─────────┬───────────┘
          │                                 │
          └────────────────┬────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  2. sidePanel 自动打开（右侧）                                     │
│     ┌──────────────────────────┐                                 │
│     │ 已选内容              ×  │                                 │
│     ├──────────────────────────┤                                 │
│     │ [▲][▼][×]                │  ← hover 时显示操作按钮           │
│     │ ┌──────────────────┐    │                                 │
│     │ │ 段落文本内容...    │    │  ← 可直接编辑                    │
│     │ └──────────────────┘    │                                 │
│     │ 第 1 段 · 156 字         │                                 │
│     ├──────────────────────────┤                                 │
│     │ [▲][▼][×]                │                                 │
│     │ ┌──────────────────┐    │                                 │
│     │ │ 第二段内容...      │    │                                 │
│     │ └──────────────────┘    │                                 │
│     │ 第 2 段 · 89 字          │                                 │
│     ├──────────────────────────┤                                 │
│     │ 已选 2 段，约 245 字      │                                 │
│     │ [        保存 TXT      ] │                                 │
│     │ [        AI 清洗       ] │                                 │
│     └──────────────────────────┘                                 │
└─────────────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                 ▼
    ┌──────────┐   ┌──────────┐   ┌──────────────┐
    │ 编辑文本  │   │ ▲▼ 排序  │   │ × 删除某段    │
    │ (自动保存) │   │ (调换位置)│   │ (页面高亮同步 │
    │          │   │          │   │  移除)        │
    └──────────┘   └──────────┘   └──────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  3. 可选: AI 清洗（需预先配置 API Key）                            │
│     点击「AI 清洗」→ 发送已选文本 → 去除广告/格式化 → 确认后替换    │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  4. 保存下载                                                     │
│     点击「保存 TXT」→ 浏览器下载                                  │
│     文件名: 《页面标题》_20260516_1430.txt                        │
└─────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  5. 退出选择模式                                                  │
│     按 Esc → 清除所有高亮 → 提示条消失 → 监听器移除                 │
│     (sidePanel 可保持打开供查看)                                   │
└─────────────────────────────────────────────────────────────────┘
```

## 五、关键设计点

| 机制 | 作用 |
|------|------|
| `blockId`（`b{timestamp}_{counter}`） | 唯一标识每个选中块，链接 DOM 元素与 storage 记录 |
| `saveSelectedBlocksToStorage` 先读后写 | 按 blockId 合并，侧栏编辑过的文本不会被 DOM innerText 覆盖 |
| `_suppressStorageChange` | content script 写入 storage 时抑制自己的 `onChanged` 监听，避免重复触发 |
| sidebar `debouncedSave`（300ms） | 编辑时不再每次击键都写 storage，降低 IO 频率 |
| `syncHighlightsFromStorage` | 侧栏删除/排序后，对比 blockId 集合自动同步页面上的蓝色高亮 |
| `chrome.sidePanel.open/openPanel()` 经 background 中转 | content script 无直接调 sidePanel API 权限；Chrome 116-147 用 `openPanel()`，Chrome 148+ 改名为 `open()` |
| `OPEN_SIDEPANEL` 必须在 `await` 之前发送 | `open()` 要求 user gesture；async storage I/O 会消耗 click 事件的 gesture 上下文 |
| `BLOCKS_UPDATED` + `storage.onChanged` 双重通知 | 解决 sidePanel 可能比 storage 写入更早加载完成的时序问题 |

## 六、相关文件

| 文件 | 职责 |
|------|------|
| `src/content/content_script.js` | 选择模式管理、高亮、blockId、storage 读写、onChanged 同步 |
| `src/sidebar/sidebar.js` | 侧栏渲染、编辑/删除/排序、debounce 保存 |
| `src/sidebar/sidebar.html` | 侧栏 UI 结构与样式 |
| `src/background.js` | 快捷键、sidePanel.openPanel() 中转 |
| `src/popup/popup.js` | 启动选择模式入口 |
| `manifest.json` | 权限声明、content_scripts 注入配置 |
