# sidePanel 自动打开机制

## 一、触发入口（INPUT）

sidePanel 有 **3 个触发路径**：

| # | 入口 | 触发者 | 调用方式 |
|---|------|--------|----------|
| 1 | 页面点击选中块 | content_script.js `handleClick()` | `sendMessage(OPEN_SIDEPANEL)` → background.js → `chrome.sidePanel.open()` |
| 2 | AUTO 模式点击「接受」 | content_script.js hint click | 同上 |
| 3 | Popup 点击「保存 TXT」 | popup.js | **直接**调用 `chrome.sidePanel.open()`（无需 background 中转） |

## 二、核心约束：User Gesture

`chrome.sidePanel.open()` 的**关键约束**：必须在用户交互（click）的同步调用栈中执行。`await` 会产生微任务间隙，消耗掉 user gesture。

这就是 content_script.js 中这段代码的顺序原因：

```js
// content_script.js:184 — handleClick()
// ✅ 先发消息（同步，保留 user gesture）
chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' });

// ❌ 后 await（async 会消耗 gesture）
await saveSelectedBlocksToStorage();

// 兜底通知（sidePanel 可能已加载完成）
chrome.runtime.sendMessage({ type: 'BLOCKS_UPDATED' });
```

## 三、流程图

```
用户 click 段落
  │
  ▼
handleClick()                              [content_script.js:156]
  │
  ├─ 1. findTextBlock(e.target)
  ├─ 2. 分配 blockId / 高亮 / push selectedBlocks
  │
  ├─ 3. chrome.runtime.sendMessage({ type: 'OPEN_SIDEPANEL' })
  │      │  ▲ 必须在 await 之前！保留 user gesture
  │      ▼
  │   background.js onMessage              [background.js:21]
  │      │
  │      └─ chrome.sidePanel?.open || chrome.sidePanel?.openPanel
  │           │  ▲ Chrome 148+ 用 open()，116-147 用 openPanel()
  │           ▼
  │        Chrome 加载 sidebar.html
  │           │
  │           ▼
  │        sidebar.js init                [sidebar.js:306]
  │           │
  │           ├─ loadBlocks()             [sidebar.js:198]
  │           │    └─ 读 storage: selected_blocks, page_title, page_url
  │           │
  │           └─ render()                 [sidebar.js:214]
  │                └─ 渲染块列表 + ▲▼× + textarea
  │
  ├─ 4. await saveSelectedBlocksToStorage()
  │      └─ 写入 storage（合并已有编辑）
  │
  └─ 5. chrome.runtime.sendMessage({ type: 'BLOCKS_UPDATED' })
         └─ 兜底：如果 sidePanel 在 storage 写入前就加载完了，
            这个消息会让它重新 loadBlocks()
```

## 四、双向同步（OUTPUT → INPUT）

sidePanel 不是只读的 — 用户编辑会**反向同步**回页面：

```
sidebar.js 用户操作
  │
  ├─ 编辑 textarea → debounce(300ms) → storage.set({selected_blocks})
  ├─ 点击 × 删除   → blocks.filter()  → storage.set({selected_blocks})
  └─ 点击 ▲▼ 排序  → swap + reindex   → storage.set({selected_blocks})
        │
        ▼
chrome.storage.onChanged                 [content_script.js:358]
  │
  └─ syncHighlightsFromStorage()        [content_script.js:371]
       ├─ 对比 blockId 集合
       ├─ 不在 storage 中的 → 移除蓝色高亮
       └─ 按 storage 顺序重建 selectedBlocks[]
```

## 五、Popup 路径的特殊性

Popup 作为 extension page，**可以直接**调用 `chrome.sidePanel` API，不需要通过 background 中转：

```js
// popup.js:37 — 直接调用，不经过 background
const openFn = chrome.sidePanel?.open || chrome.sidePanel?.openPanel;
openFn.call(chrome.sidePanel);
window.close();
```

这避免了 Service Worker 休眠（MV3 约 30s 空闲后休眠）导致的消息丢失问题。

## 六、三层兜底保证 sidePanel 数据就绪

由于 sidePanel 加载和数据写入存在**时序竞争**（谁先完成不确定），设计了三层保障：

| 层 | 机制 | 位置 |
|----|------|------|
| 1 | `storage.onChanged` 监听 | sidebar.js:319 — sidePanel 加载后，storage 写入触发重新 loadBlocks() |
| 2 | `BLOCKS_UPDATED` 消息 | sidebar.js:309 — content script 写入完成后主动通知 |
| 3 | `OPEN_SIDEPANEL` 在 await 之前 | 确保 sidePanel 尽早开始加载，减少竞争窗口 |

## 七、潜在风险点

content script 的 `OPEN_SIDEPANEL` 仍通过 background Service Worker 中转（content script 无权直接调 `chrome.sidePanel`）。虽然 `sendMessage` 会唤醒休眠的 SW，但极端情况下（SW 崩溃等）可能失败。Popup 路径已消除此风险（直接调用），content script 路径仍有依赖。
