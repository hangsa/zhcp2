# FDE Windows 训练指南

本指南覆盖将 FDE 项目迁移到 Windows（NVIDIA RTX 3060）进行完整模型训练的完整流程。

## 前置条件

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10/11 (64-bit) |
| GPU | NVIDIA RTX 3060 (12GB VRAM) 或类似 |
| 驱动 | NVIDIA Game Ready / Studio Driver 535+ |
| Python | 3.11+（安装时勾选 "Add Python to PATH"） |
| 磁盘 | ~10 GB 空闲空间（训练数据 ~2-5 GB，依赖 ~3 GB） |

## 迁移步骤

### 1. 从 Mac 拷贝项目到 Windows

将整个 `fde/` 目录拷贝到 Windows 机器。可以使用 U 盘、网络共享或云盘。

```
需要拷贝的目录结构：
fde/
├── data/
│   └── reference/
│       └── target_chars.txt       # 8996 个目标字符
├── engine/                        # 核心引擎代码
├── scripts/                       # 工具脚本
│   ├── setup_windows.ps1          # 环境安装
│   ├── download_fonts.ps1         # 字体下载
│   ├── train_all.ps1              # 一键训练
│   ├── generate_training_data.py  # 数据生成
│   └── train_classifier.py        # 模型训练
├── models/                        # 模型输出目录
└── requirements-windows.txt       # Windows 依赖
```

### 2. 安装环境

打开 **PowerShell**（以管理员身份运行），进入项目目录：

```powershell
cd D:\path\to\fde
powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1
```

此脚本会：
- 检查 Python 版本（需 3.11+）
- 创建 `.venv` 虚拟环境
- 安装 CUDA 12.4 版本的 PyTorch
- 安装其他依赖（fonttools, Pillow 等）
- 验证 GPU 是否可用

### 3. 准备参考字体

#### 方案 A：自动下载（推荐）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\download_fonts.ps1
```

自动下载 6 款免费开源中文字体：
- Source Han Sans SC Regular/Bold/Medium（思源黑体）
- Source Han Serif SC Regular/SemiBold/Bold（思源宋体）

#### 方案 B：手动放置

将 `.ttf`、`.otf`、`.ttc` 格式的中文字体文件放入 `data\reference\fonts\` 目录。

建议 6+ 款字体覆盖不同风格和字重——字体越多，CNN 泛化能力越强。

Windows 系统自带的中文字体可以参考（位于 `C:\Windows\Fonts\`）：
- `msyh.ttc` — 微软雅黑
- `simsun.ttc` — 宋体
- `simhei.ttf` — 黑体
- `simkai.ttf` — 楷体

> **注意**：系统字体的许可通常不允许分发，仅限个人研究使用。

### 4. 一键训练

```powershell
# 完整训练（生成数据 + 训练模型）
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1

# 试运行（100 个字符，2 个 epoch，验证流程正确性）
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -DryRun

# 仅训练模型（跳过数据生成，使用已有数据）
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -SkipDataGen

# 从头开始（清空之前的训练数据）
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -CleanStart

# 从检查点恢复训练（Ctrl+C 暂停后继续）
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -SkipDataGen -Resume
```

#### 训练流程

```
Step 1: 生成训练数据集（~1-2 小时，纯 CPU）
  ├── 读取 data/reference/fonts/ 下所有字体
  ├── 对 target_chars.txt 中每个字符渲染 64×64 灰度图
  ├── 数据增强（旋转/平移/缩放/噪声/亮度）
  └── 输出到 data/training/{train,val,test}/

Step 2: 训练 ViT-Tiny 模型（~2-4 小时，GPU RTX 3060）
  ├── 模型：ViT-Tiny（patch=4, dim=192, depth=12, ~5.7M 参数）
  ├── 输入：64×64 单通道灰度图
  ├── 分类头：由 label_map.json 决定（GB2312 全量 ~6763 类）
  ├── 优化器：AdamW (lr=3e-4, weight_decay=0.05)
  ├── 调度器：5 epoch warmup + cosine annealing
  ├── 损失函数：CrossEntropy + LabelSmoothing(0.1)
  ├── 混合精度：自动 AMP (CUDA)
  ├── 早停：validation accuracy 10 epoch 不提升则停止
  └── 输出：models/vit_tiny_gb2312.pt + vit_tiny_gb2312.json
```

#### 训练暂停与恢复

训练过程中按 **Ctrl+C** 即可优雅暂停：

```
按一次 Ctrl+C → 当前 epoch 完成后自动保存检查点到 models/checkpoint.pt → 退出
按两次 Ctrl+C → 强制退出（检查点可能不完整）
```

恢复训练：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -SkipDataGen -Resume
```

检查点包含完整训练状态：模型权重、优化器状态、学习率调度器步数、epoch 进度、最佳指标、随机种子。恢复后训练从下一 epoch 无缝继续。

#### 自定义参数

```powershell
# 自定义 batch size 和 epochs
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -BatchSize 512 -Epochs 150

# 指定检查点保存路径
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -SkipDataGen
# （Python 端：python scripts/train_classifier.py --checkpoint-path models/my_ckpt.pt）
```

#### GPU 显存自动适配

脚本根据检测到的 GPU 显存自动调整 batch_size：

| 显存 | batch_size | gradient checkpointing | 说明 |
|------|-----------|----------------------|------|
| < 4 GB | 64 | 开启 | 低端卡/集成显卡 |
| 4-8 GB | 128 | 开启 | 笔记本 GPU / GTX 1060 等 |
| 8-12 GB | 256 | 关闭 | RTX 3060 Ti / RTX 3070 等 |
| 12-16 GB | **384** | 关闭 | **RTX 3060 12GB** — 预计显存占用 ~9-10 GB |
| ≥ 16 GB | 512 | 关闭 | RTX 3080/4080/4090 等 |

也可手动指定任意 batch_size 覆盖自动检测：
```powershell
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -BatchSize 256 -SkipDataGen
```

> **Windows 注意**：`num_workers` 默认为 0（Windows 多进程 DataLoader 会导致死锁）。即使手动指定
> `-NumWorkers > 0`，Python 端也会自动检测 Windows 环境并强制设为 0。

### 5. 结果传回 Mac

训练完成后，将以下 3 个文件拷贝回 Mac 的对应位置：

| 文件 | 大小 | 路径 |
|------|------|------|
| 训练好的模型 | ~22 MB | `models/vit_tiny_gb2312.pt` |
| 训练指标 | ~1 KB | `models/vit_tiny_gb2312.json` |
| 标签映射 | ~50 KB | `data/training/label_map.json` |

```powershell
# 在 Windows 上验证文件存在
dir models\vit_tiny_gb2312.pt
dir models\vit_tiny_gb2312.json
dir data\training\label_map.json
```

### 6. 回到 Mac 验证

```bash
cd fde

# 验证模型可加载
python -c "
import torch
from engine.glyph_classifier import GlyphClassifier
import json
with open('data/training/label_map.json') as f:
    label_map = {int(k): v for k, v in json.load(f).items()}
classifier = GlyphClassifier('models/vit_tiny_gb2312.pt', len(label_map), label_map)
print('Model loaded successfully:', classifier.num_classes, 'classes')
"

# 运行测试套件
python -m pytest tests/ -v

# 启动 API 服务（需设置环境变量）
DB_PATH=data/reference/db/glyphs.db \
CLASSIFIER_MODEL=models/vit_tiny_gb2312.pt \
CLASSIFIER_LABEL_MAP=data/training/label_map.json \
python -m uvicorn api.server:app --port 8000

# 验证 API
curl http://localhost:8000/health
# 应返回: {"status":"ok","classifier":"loaded",...}
```

## 期望结果

### 训练指标

| 指标 | 目标值 | 说明 |
|------|--------|------|
| Top-1 准确率（验证集） | ≥ 99.0% | 越高越好 |
| 形近字准确率 | ≥ 98.0% | 专项测试 |
| 模型大小 | ~22 MB | FP32，可量化至 ~6 MB |
| 单次推理延迟 | ≤ 3ms | CPU |

### 如果准确率不达标

1. **增加参考字体数量和种类**——不同风格的字体越多，模型泛化越好
2. **增加 epoch 数**——`-Epochs 200`
3. **调整学习率**——编辑 `scripts/train_classifier.py` 中 `lr` 参数
4. **增加数据增强强度**——编辑 `scripts/generate_training_data.py` 中增强参数
5. **检查训练数据质量**——查看 `data/training/` 下的渲染图片是否有问题

## 故障排除

### nvidia-smi 找不到

确保 NVIDIA 驱动已安装：https://www.nvidia.com/download/index.aspx

### PyTorch 无法使用 GPU

```powershell
.\.venv\Scripts\Activate.ps1
python -c "import torch; print(torch.cuda.is_available())"
# 如果返回 False，重新安装 CUDA PyTorch：
pip uninstall torch torchvision -y
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124
```

### 字体下载失败

GitHub 下载可能较慢。可以手动下载：
1. 思源黑体：https://github.com/adobe-fonts/source-han-sans/releases/tag/2.004R
2. 思源宋体：https://github.com/adobe-fonts/source-han-serif/releases/tag/2.003R
3. 下载 `SourceHanSansSC.zip` 和 `SourceHanSerifSC.zip`
4. 解压后将所有 `.otf` 文件放入 `data/reference/fonts/`

### 内存/显存不足 (OOM)

优先使用 GPU 显存自动适配（脚本会自动选择合适 batch_size）。

如需手动降低 batch size：
```powershell
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -BatchSize 64 -SkipDataGen
```

### DataLoader 卡住不动

Windows 上 `num_workers > 0` 会导致 DataLoader 死锁。脚本已默认为 0，Python 端也会自动检测 Windows 并强制清零。确保不要手动指定 `-NumWorkers` 为非零值。
