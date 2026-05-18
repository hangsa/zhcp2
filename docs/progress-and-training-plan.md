# FDE 项目整体进度与训练计划

> 更新日期：2026-05-18 | 分支：`zhextra`

## 一、项目概述

FDE（Font De-Obfuscation Engine）是一个字体反混淆引擎，用于将网页中通过自定义字体混淆的中文文本还原为可读文字。采用三级级联架构：

```
Solution B（精确哈希 + KNN） → Solution C（ViT-Tiny CNN） → Solution A（OCR，Phase 3 待实施）
```

同时项目包含一个 Chrome 扩展（MV3），用于绕过 CSS/JS 复制限制提取付费页面文本。

---

## 二、整体进度

### Phase 0 — 基础架构（已完成）

| 模块 | 文件 | 行数 | 状态 |
|------|------|------|------|
| 字形规范化 | `engine/glyph_normalizer.py` | 224 | 完成 |
| FAISS 索引 | `engine/faiss_index.py` | 168 | 完成 |
| 参考库构建 | `scripts/build_ref_library.py` | 512 | 完成 |
| 字体逆向 | `engine/font_reverser.py` | 169 | 完成 |
| 字体解析 | `engine/font_resolver.py` | 138 | 完成 |
| 字体提取代理 | `proxy/font_extractor.py` | 148 | 骨架 |
| MITM 拦截器 | `proxy/interceptor.py` | 165 | 骨架 |

### Phase 1 — 管线集成（已完成）

| 模块 | 文件 | 行数 | 状态 |
|------|------|------|------|
| 管线编排 | `engine/pipeline.py` | 277 | 完成（已集成 Solution C） |
| API 服务 | `api/server.py` | 197 | 完成 |
| 管线集成测试 | `tests/integration/test_pipeline_b.py` | 194 | 11 通过 |
| 逆向器测试 | `tests/test_font_reverser.py` | 360 | 22 通过，1 跳过 |

### Phase 2 — CNN 字形分类器 Solution C（已完成）

| 模块 | 文件 | 行数 | 状态 |
|------|------|------|------|
| 字形渲染 | `engine/glyph_renderer.py` | 227 | 完成 |
| ViT-Tiny + 推理包装 | `engine/glyph_classifier.py` | 306 | 完成 |
| 训练数据生成 | `scripts/generate_training_data.py` | 238 | 完成（需完整数据集生成） |
| 训练脚本 | `scripts/train_classifier.py` | 387 | 完成（需 GPU 完整训练） |
| 分类器测试 | `tests/test_glyph_classifier.py` | 407 | 52 通过，3 环境相关失败 |

### Phase 3 — OCR Solution A（待设计）

- 现状：未开始
- 范围：对 Solution B + C 均未匹配的字符，使用 OCR 兜底
- 预期用途：处理超大字体、冷僻字形、以及 CNN 未覆盖的字符

### Chrome 扩展（并行维护）

- MV3 架构，使用 Mozilla Readability 自动检测正文
- 支持手动/自动选择模式、侧边栏预览、TXT 导出、AI 文本清洗
- 已完成功能稳定，非 AI 清洗版本可用

---

## 三、测试状态汇总

```
测试总数：57
通过：    52  (91.2%)
跳过：     2  (大 TTC 字体、无复合字形)
失败：     3  (NumPy 版本兼容性，非代码 Bug)
```

| 测试文件 | 用例数 | 通过 | 跳过 | 失败 |
|----------|--------|------|------|------|
| `test_font_reverser.py` | 23 | 22 | 1 | 0 |
| `test_pipeline_b.py` | 11 | 11 | 0 | 0 |
| `test_glyph_classifier.py` | 23 | 19 | 1 | 3 |

**说明**：3 个失败用例均位于 `TestGlyphClassifier`，错误为 `RuntimeError: Numpy is not available`，原因是系统 Python 3.9 环境下 NumPy 2.x 与 PyTorch 2.2.2（基于 NumPy 1.x 编译）不兼容。`.venv` 中的 Python 3.11 可正常工作。非 Phase 2 代码逻辑问题。

---

## 四、代码规模

```
类别        文件数   代码行数
引擎核心      6      1,509
脚本工具      3      1,137
API 服务     1        197
代理/拦截    2        313
测试          3        961
───────────────────────────
合计         15      4,117
```

---

## 五、本地系统配置

| 项目 | 参数 |
|------|------|
| 型号 | MacBook Pro 15,2 (Intel) |
| CPU | Intel Core i5-8259U @ 2.30GHz |
| 核心 | 4 物理核 / 8 逻辑核 |
| 内存 | 8 GB |
| GPU | 无 — Intel Mac，不支持 CUDA |
| MPS | 不可用 — Apple Silicon 专有 |
| PyTorch | 2.2.2 CPU-only (x86_64) |
| Python | 3.9.6（系统）/ 3.11（.venv） |
| NumPy 兼容 | ⚠️ 系统 Python 下 NumPy 2.x 与 PyTorch 不兼容 |

---

## 六、训练耗时估算

### 6.1 数据集生成

| 条件 | 估算 |
|------|------|
| 规模 | 6,763 字符 × N 字体 × 5 尺寸 × 4 增强 = ~80,000 张图片 |
| CPU（本地） | **~1–2 小时**（纯渲染，不依赖 GPU） |
| GPU | ~30–60 分钟 |

### 6.2 ViT-Tiny 模型训练

| 模型配置 | 参数量 | 输入 | 数据集 |
|----------|--------|------|--------|
| ViT-Tiny（patch=4, dim=192, depth=12） | ~570 万 | 64×64 灰度 | ~8 万张，6,763 类 |

| 硬件环境 | batch_size | epoch 数 | 每次迭代耗时 | 总耗时 |
|----------|------------|----------|-------------|--------|
| CPU（本地 i5-8259U） | 256 | 100 | ~1.5 秒 | **~4–6 天**（不推荐） |
| GPU（RTX 3060+） | 256 | 100 | ~0.1 秒 | **~2–4 小时** |
| GPU（T4 / Colab） | 256 | 100 | ~0.15 秒 | **~4–6 小时** |

### 6.3 缩减范围训练（备选方案）

| 方案 | 类别数 | 图像数 | 参数 | epoch | CPU 耗时 |
|------|--------|--------|------|-------|----------|
| 微型验证 | 50 | 600 | 47.8 万 | 2 | ~20 秒（已完成 dry-run） |
| 常用字集 | ~1,000 | ~12,000 | 227 万 | 50 | ~8–12 小时 |
| 常用字集 | ~2,000 | ~24,000 | 376 万 | 50 | ~15–20 小时 |

---

## 七、训练方案建议

### 方案 A：云 GPU 训练（推荐）

使用云 GPU 服务完成完整 6,763 类训练：

| 平台 | GPU 型号 | 估价 | 训练时长 |
|------|----------|------|----------|
| Lambda Labs | RTX 4090 / A6000 | ~$1.10/hr | 2–4 小时 |
| RunPod | RTX 3090 / 4090 | ~$0.50/hr | 2–4 小时 |
| Google Colab Pro | T4 / V100 | ~$10/month | 4–6 小时 |

**总成本**：约 **$2–5**（一次性）即可完成完整训练。

**操作步骤**：

1. 本地生成训练数据（`scripts/generate_training_data.py`，~1–2 小时 CPU），上传到云 GPU
2. 云 GPU 上运行 `scripts/train_classifier.py` 完整训练
3. 下载 `vit_tiny_gb2312.pt` 和 `label_map.json` 到本地 `models/` 目录
4. 配置 API 服务加载模型，Solution C 即可上线

### 方案 B：缩减范围先验证（零成本）

1. 本地 CPU 生成 ~1,000 个高频汉字的训练数据
2. CPU 训练 50 个 epoch（过夜 ~8–12 小时）
3. 验证 pipeline 端到端效果
4. 满足精度要求后再按方案 A 完整训练

**适用场景**：快速迭代、成本敏感、或 CNN 仅做辅助兜底。

### 方案 C：直接跳过 CNN（当前可用）

当前系统已完成 Solution B（精确哈希 + KNN），可独立工作：
- 对于常见字体的常见混淆方式已有效果
- 每次 `POST /api/v1/decode` 时，统计中 `cnn: 0` 表示 CNN 未参与
- 待 CNN 模型就绪后，无需代码改动即可启用

---

## 八、后续工作计划

### 近期（条件就绪即可推进）

| 优先级 | 任务 | 前置条件 | 预估工作量 |
|--------|------|----------|------------|
| P1 | 生成完整训练数据集 | 准备参考字体文件 | 1–2 小时 CPU |
| P1 | 云 GPU 完成 ViT-Tiny 训练 | 完整数据集 | 2–4 小时 GPU |
| P2 | 加载模型，启用 Solution C | 训练完成 | 即时 |
| P2 | 端到端集成测试 | Solution C 上线 | 1–2 小时 |

### 中期（Phase 3）

| 优先级 | 任务 | 说明 |
|--------|------|------|
| P3 | OCR Solution A 设计 | 对 Solution B + C 均未匹配的字符兜底 |
| P3 | MITM 代理完整集成 | `proxy/interceptor.py` + `proxy/font_extractor.py` |

### 长期

| 优先级 | 任务 | 说明 |
|--------|------|------|
| P4 | 性能优化 | FAISS GPU 加速、模型量化 |
| P4 | 生产部署 | Docker 部署、监控告警 |
| P4 | 多字体联合映射优化 | 提高多字体场景下 KNN 匹配准确率 |

---

## 九、当前阻塞项

| 阻塞项 | 原因 | 解决路径 |
|--------|------|----------|
| 完整训练数据集未生成 | 用户暂停（等待 GPU 资源） | 方案 A 或 B |
| ViT-Tiny 模型未训练 | CPU 训练耗时太长 | 方案 A 或 B |
| 3 个测试用例失败 | Python 3.9 系统环境 NumPy 不兼容 | 使用 .venv (Python 3.11) 或降级 NumPy |
