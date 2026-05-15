# PRD · 文本提取浏览器插件

> 产品规划文档 v1.0

---

## 一、背景与目标

**问题**：付费内容平台通过 CSS `user-select: none` 或 JS 事件拦截阻止文本复制，但文字实际存在于 DOM 中。

**解法**：Chrome Extension MV3 通过 `content_script.js` 注入页面，使用 `element.innerText` 直接读取文本节点，绕过前端限制。

**目标用户**：需要摘录付费内容做笔记/研究的个人用户。

**核心价值**：精准选块提取，而非粗暴提取整页；所有数据本地保存，无云端存储。

---

## 二、核心交互流程

```
访问目标页面
       ↓
点击插件图标 → popup 面板打开
       ↓
popup 显示「开始选择」按钮
       ↓
点击「开始选择」→ popup 关闭 → sidePanel 打开
       ↓
顶部出现蓝色提示条「选择模式已开启 · 按 Esc 退出」
       ↓
Readability.js 后台自动解析 → 识别成功则主文章出现蓝色虚线框
       ↓
点击虚线框 → 接受识别结果，区域被锁定（浅蓝填充 + 虚线边框）
       ↓
如需补充：点击「手动选择」按钮 → 悬停高亮（蓝色描边边框）→ 点击锁定
       ↓
右侧 sidePanel（固定显示）展示所有已选文本
       ↓
用户可在面板中编辑 / 删除某段，调整顺序
       ↓
（可选）点击「AI 清洗」→ 去除版权声明/广告语 → 确认后直接替换原文本
       ↓
点击「保存 TXT」→ 浏览器下载，文件名：「《页面标题》_YYYYMMDD_HHmm.txt」
```

**用户随时可按 Esc 退出选择模式。再次点击已选中块可取消选择。**

---

## 三、AI 三层分级识别

### 第一层 — Readability.js（默认启动）
- 插件激活时自动运行，Mozilla 阅读模式内核
- 离线运行，零延迟，零成本，零隐私风险
- 识别成功：主文章容器出现蓝色虚线框 + 「已识别正文，点击接受」提示
- 点击接受：区域直接锁定
- 覆盖率约 90%

### 第二层 — 手动点选（始终可用）
- 用户不满意第一层结果时，点击「手动选择」切换
- 鼠标悬停任意块 → 蓝色描边边框高亮
- 点击锁定 → 浅蓝填充 + 虚线边框
- 再次点击已选中块 → 取消选择
- 支持多块叠加，按点击顺序合并

### 第三层 — 云端 LLM（可选）
- 用户预先在设置页配置以下四项（AES-GCM 加密存储）：
  - **Provider**：Anthropic / OpenAI / 自定义兼容 API
  - **Endpoint**：API 端点地址（如 `https://api.anthropic.com` 或自建代理）
  - **Model**：模型名称（如 `claude-haiku-20250709`、`gpt-4o-mini`）
  - **API Key**：直接调用，插件不做中转
- 触发时机：用户选中内容后，点击「AI 清洗」按钮
- 输入：用户已选中的少量文本片段（不含 HTML、URL、Cookie）
- Prompt 固定为：「清理格式，去除广告词，保留原文内容」
- 推荐模型：claude-haiku / gpt-4o-mini（低成本）

---

## 四、功能优先级

| 优先级 | 功能 | 描述 |
|--------|------|------|
| P0 | 激活 / 退出选择模式 | 点击图标或 Alt+E，顶部蓝色提示条，Esc 退出 |
| P0 | Readability 自动识别 | 激活时自动推荐正文区域，虚线框高亮，一键接受 |
| P0 | 悬停高亮 + 点击锁定 | 蓝色描边边框悬停高亮，点击锁定，再次点击取消 |
| P0 | 多块叠加选择 | 跨段落多次点击，按顺序合并 |
| P0 | 保存为 TXT | 自动命名格式，触发浏览器下载 |
| P1 | 侧边预览面板 | 右侧固定悬浮窗，实时显示已选文本，支持编辑/删除某段 |
| P1 | AI 文本清洗（可选） | 去除版权声明/广告语，格式化段落，确认后直接替换原文本；需先在设置页配置 Provider/Endpoint/Model |
| P1 | LLM 设置页 | Provider / Endpoint / Model / API Key 四个参数，本地 AES-GCM 加密存储 |
| P1 | 快捷键 | Alt+E（Mac 为 Option+E）快速激活/退出 |
| P2 | 历史记录 | 按日期归档已保存文件，支持再次下载 |
| P2 | Markdown 格式输出 | 保存时可选 TXT 或 MD 格式 |
| P2 | iframe 内容支持 | manifest 声明 `all_frames: true` |

---

## 五、TXT 文件格式

```
标题：《页面标题》
来源：https://example.com/article/12345
提取时间：YYYY-MM-DD HH:mm
---

第一段落内容……

---

第二段落内容……

---

第三段落内容……
```

**格式说明：**
- 文件名：`《页面标题》_YYYYMMDD_HHmm.txt`
- 多块合并时，各段落之间用 `---` 分割线分隔
- 分割线前后均留一个空行
- 保留原始段落结构

---

## 六、视觉规范

### 选择模式激活提示
- 位置：页面顶部
- 样式：蓝色细长提示条
- 内容：「选择模式已开启 · 按 Esc 退出」
- 右侧固定显示「手动选择」按钮，点击切换至手动点选模式
- 侧边面板打开后提示条隐藏

### 悬停高亮（蓝色描边边框）
- 目标段落出现 2px 蓝色实线边框
- 背景不变，不遮挡内容
- 光标变为十字/瞄准十字

### 选中状态（浅蓝填充 + 虚线边框）
- 背景：浅蓝色（#E8F0FE）
- 边框：蓝色虚线

### 侧边预览面板
- 位置：页面右侧固定显示
- 功能：展示已选文本列表，支持编辑/删除某段，显示字数统计
- 关闭：显式关闭按钮
- 主题：跟随系统明暗模式（CSS 变量支持）

---

## 七、技术选型

| 模块 | 方案 | 说明 |
|------|------|------|
| 插件平台 | Chrome Extension MV3 | 兼容 Edge；Service Worker 替代 Background Page |
| 正文识别 | @mozilla/readability | npm 安装，Firefox 阅读模式内核，单文件引入 |
| 内容脚本 | content_script.js（原生 JS） | 无框架依赖，Shadow DOM 隔离样式 |
| 面板 UI | popup.html + chrome.sidePanel | popup 做控制，侧边 panel 做预览 |
| 本地存储 | chrome.storage.local | 暂存已选内容；API Key 用 AES-GCM 加密 |
| 文件下载 | chrome.downloads API | Blob URL 生成 TXT，触发原生下载 |
| AI 清洗 | Anthropic / OpenAI API | 用户自填 Key，直连 API，插件不做中转 |
| 动态内容 | MutationObserver | 监听 DOM 变化，适配无限滚动/懒加载 |

---

## 八、主要风险与应对

| 风险 | 应对 |
|------|------|
| Canvas / 图片渲染文字 | innerText 无法读取；检测到 Canvas 时提示用户切换截图 + OCR |
| Shadow DOM 内容 | content script 递归检查 shadowRoot，读取 shadowRoot.innerText |
| 插件样式被页面覆盖 | Shadow DOM 隔离注入 UI；高亮用极高 z-index + !important |
| 平台反插件检测 | 只读取文本，不修改 CSS 属性；聚焦个人学习笔记用途 |
| API Key 安全 | AES-GCM 加密存储，Key 不出现在日志或可见文本中 |

---

## 九、文件结构（开发阶段）

```
zhcp2/
├── manifest.json          # 扩展配置（MV3）
├── README.md              # 安装与使用说明
├── docs/
│   ├── design.md          # 早期产品规划
│   ├── extractor_product_plan.html  # 完整产品方案（参考）
│   └── PRD.md             # 本文档
├── src/
│   ├── background.js      # Service Worker（AI 请求代理）
│   ├── content/
│   │   ├── content_script.js    # 注入页面：高亮 + 文本提取
│   │   ├── highlight.css         # 高亮样式（Shadow DOM 隔离）
│   │   └── readability.esm.js    # Readability 库
│   ├── popup/
│   │   ├── popup.html            # 弹出控制面板
│   │   └── popup.js              # 逻辑
│   ├── sidebar/
│   │   ├── sidebar.html          # 侧边预览面板
│   │   └── sidebar.js            # 逻辑
│   ├── settings/
│   │   ├── settings.html        # LLM 配置页（Provider/Endpoint/Model）
│   │   └── settings.js           # 加密存储逻辑
│   └── shared/
│       ├── storage.js            # chrome.storage 封装
│       ├── crypto.js             # AES-GCM 加密工具
│       └── constants.js          # 常量配置
└── test/
    ├── content.test.js           # 内容脚本单元测试
    └── integration.test.js      # 集成测试
```

> **MVP 快速路径**：前三周只搭建 `manifest.json` + `content_script.js` + `popup.html`，验证核心链路后再扩展。

---

## 十、开发里程碑

| 周期 | 目标 |
|------|------|
| 第 1 周 | MVP 核心链路：激活模式、悬停高亮、点击提取、保存下载 |
| 第 2 周 | 引入 Readability（第一层）+ 侧边预览面板 + 多块选择管理 |
| 第 3 周 | AI 清洗（第三层）+ API Key 设置 + 快捷键 + MutationObserver |
| 后续迭代 | 历史记录、Markdown 导出、iframe 支持、Chrome Web Store 发布 |