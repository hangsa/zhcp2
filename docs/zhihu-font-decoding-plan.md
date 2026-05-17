# 知乎字体反爬 - 页面锚点校准解码方案

## Context

知乎对付费内容使用字体反爬：将正文汉字替换为 Unicode PUA 码点（U+E000-U+F8FF），通过自定义 @font-face 字体在视觉上映射回正确汉字。扩展通过 `innerText` 提取到的是 PUA 乱码。需要在不下载外部工具的情况下（纯浏览器端 JS）解码。

## 核心思路

利用知乎页面上的已知锚点文字（UI 标签如"赞同""收藏""评论"等不会被编码的纯文本），与自定义字体中 PUA 码点的字形进行几何特征比对，建立 PUA → 真实汉字的映射表，解码正文。

## 技术选型

- **字体解析**：opentype.js（npm 包，纯 JS，可解析 ArrayBuffer 中的 woff/woff2）
- **字形比对**：Canvas 渲染 + ImageData 像素相似度计算
- **注入方式**：独立 bundle 文件 `font-decoder-bundle.js`（opentype.js + font-decoder.js）
- **作用域**：页面加载时校准一次，当次有效（知乎每次访问映射不同）

## 新增文件

```
src/content/font-decoder.js          # 解码逻辑 IIFE → window.ZhihuFontDecoder
src/content/font-decoder-bundle.js   # 生成: opentype.js + font-decoder.js
scripts/bundle-font-decoder.js       # 打包脚本
```

## 修改文件

| 文件 | 改动 |
|------|------|
| `manifest.json` | `js` 数组追加 `font-decoder-bundle.js` |
| `package.json` | 添加 `opentype.js` 依赖 |
| `content_script.js` | 添加 `getDecodedText()` 包装函数，替换 4 处 `innerText` 调用，文件末尾调用 `ZhihuFontDecoder.init()` |

## 数据流

```
页面加载
  ├─ readability-bundle.js 执行（现有）
  └─ font-decoder-bundle.js 执行
       └─ init():
            1. 检测知乎页面 ✓
            2. 扫描 @font-face 提取字体 URL
            3. fetch 下载字体 → ArrayBuffer
            4. opentype.parse() 解析字体
            5. 枚举 PUA 码点列表
            6. 收集锚点文字（页面 UI + 静态备选 200 字）
            7. 逐字形 Canvas 渲染 → 像素比对 → 建立映射表
            8. status = 'ready'

用户选中段落
  getDecodedText(element)
    → 遍历字符，查映射表替换 PUA → 真实汉字
    → 未覆盖字符保留原样，显示解码率
```

## 锚点文字来源

1. **页面采集**：扫描 UI 元素（按钮、导航、标签）提取所有中文字符
2. **静态备选集**（~200 字）：知乎高频 UI 汉字 + 汉语常用字表 top 100

实际覆盖预计 150-200 个锚点字符，可解码正文中大部分常见字。

## 与现有代码的集成点

`content_script.js` 添加一个包装函数，替换 4 处调用：

```js
function getDecodedText(element) {
  if (window.ZhihuFontDecoder?.isReady()) {
    return window.ZhihuFontDecoder.decodeElement(element);
  }
  return element.innerText;
}
```

替换位置：
1. `findTextBlock()` line 204 — 判断文本长度
2. `saveSelectedBlocksToStorage()` line 225 — 提取文本存入 storage
3. `findMainContentElement()` line 265 — 判断正文区域
4. `saveSelectedBlocksToFile()` 从 storage 读取，已被解码

## 降级策略

| 场景 | 行为 |
|------|------|
| 非知乎页面 | `isReady()` → false，走 `innerText` |
| 字体下载/解析失败 | `getStatus()` → 'error'，走 `innerText` |
| 校准中 | 暂时走 `innerText`，完成后自动切换 |
| 部分字符未覆盖 | 解码率提示（如"87% 已解码"），未覆盖字符留空 |

## 实施步骤

1. `npm install opentype.js`，创建打包脚本和 `font-decoder.js` 骨架
2. 实现检测 + 字体下载 + 解析（Phase 1）
3. 实现 Canvas 渲染 + 像素比对校准引擎（Phase 2）
4. 集成到 `content_script.js`（Phase 3）
5. 手动端到端测试（知乎文章页面）

## 验证

- 知乎会员文章页面，开启选择模式，选中正文段落
- 侧栏显示可读中文（非 PUA 乱码）
- 下载 TXT 文件内容为正确中文
- 非知乎页面不受影响
