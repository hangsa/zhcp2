# FDE Windows Docker 部署指南

> 适用于 Windows 10/11 + NVIDIA RTX 3060 + Docker Desktop

## 前置条件

| 项目 | 要求 | 状态 |
|------|------|------|
| 操作系统 | Windows 10/11 (64-bit) | |
| Docker Desktop | 最新版 (WSL2 后端) | 需安装 |
| Python | 3.11+ (.venv 已创建) | `setup_windows.ps1` 已执行 |
| 参考字体 | `data/reference/fonts/` | `download_fonts.ps1` 已执行 |
| 训练好的模型 | `models/vit_tiny_gb2312.pt` (27MB) | `train_all.ps1` 已执行 |
| 标签映射 | `data/training/label_map.json` (148KB) | `train_all.ps1` 已执行 |
| 参考数据库 | `data/reference/db/glyphs.db` + `faiss_index.faiss` | 部署脚本自动构建 |

---

## 部署步骤

### 1. 安装 Docker Desktop

下载安装：https://www.docker.com/products/docker-desktop/

- 安装时选择 **WSL 2** 后端（默认）
- 安装完成后启动 Docker Desktop
- 等待任务栏鲸鱼图标停止动画（表示 Docker 引擎已就绪）

验证：
```powershell
docker --version
docker info
```

### 2. 拉取最新代码

```powershell
cd D:\path\to\fde
git pull origin zhextra
```

### 3. 一键部署

```powershell
powershell -ExecutionPolicy Bypass -File scripts\deploy_windows.ps1
```

脚本会自动：
1. 检查 Docker 运行状态
2. 验证所有前置文件存在
3. 构建参考数据库（首次运行，~10-20 分钟 CPU）
4. 构建 Docker 镜像（首次 ~5-10 分钟）
5. 启动所有服务（redis + fde-api + mitmproxy）
6. 等待服务就绪 → 健康检查

**首次运行总耗时**：约 15-30 分钟（含数据库构建 + Docker 构建）。
**后续运行**：约 30 秒（直接启动已有容器）。

### 4. 验证部署

```powershell
# 健康检查
curl http://localhost:8000/health
```

期望输出：
```json
{
    "status": "ok",
    "uptime": 12.3,
    "index_vectors": 8995,
    "classifier": "loaded",
    "version": "0.1.0"
}
```

### 5. 测试解码

```powershell
curl -X POST http://localhost:8000/api/v1/decode `
  -H "Content-Type: application/json" `
  -d '{"html":"<html><body><span style=\"font-family:test\">Hello</span></body></html>","fonts":[{"family":"test","url":"","data_base64":"dGVzdA=="}]}'
```

---

## 部署脚本参数

```powershell
# 标准部署（构建数据库 + 构建镜像 + 启动）
powershell -ExecutionPolicy Bypass -File scripts\deploy_windows.ps1

# 跳过 Docker 镜像构建（已有镜像）
powershell -ExecutionPolicy Bypass -File scripts\deploy_windows.ps1 -SkipBuild

# 重建参考数据库
powershell -ExecutionPolicy Bypass -File scripts\deploy_windows.ps1 -Clean
```

---

## 服务架构

```
                    Docker Compose
┌─────────────────────────────────────────┐
│                                         │
│  Client ──► mitmproxy :8080             │
│                │                        │
│                ▼                        │
│  Client ──► fde-api :8000               │
│                │                        │
│           ┌────┴────┐                   │
│           ▼         ▼                   │
│      Solution B  Solution C             │
│      (FAISS KNN) (ViT-Tiny)             │
│           │         │                   │
│           └────┬────┘                   │
│                ▼                        │
│           redis :6379 (cache)           │
│                                         │
└─────────────────────────────────────────┘
```

### 服务说明

| 服务 | 端口 | 功能 |
|------|------|------|
| `fde-api` | 8000 | REST API：健康检查 + 字体解码 |
| `mitmproxy` | 8080 | HTTP 代理：自动拦截网页字体 |
| `redis` | 6379 | 结果缓存 |

---

## 日常管理

```powershell
# 查看日志
docker compose logs -f fde-api

# 查看所有容器状态
docker compose ps

# 停止服务
docker compose down

# 重启服务
docker compose restart

# 完全清理（删除容器+网络+数据卷）
docker compose down -v

# 更新代码后重新部署
git pull origin zhextra
docker compose build --no-cache
docker compose up -d
```

---

## API 接口

### GET /health

服务健康检查，返回各组件状态。

```bash
curl http://localhost:8000/health
```

### POST /api/v1/decode

解码含混淆字体的网页文本。

**请求体**：
```json
{
    "html": "<html>...</html>",
    "fonts": [
        {
            "family": "zh-font-1",
            "url": "https://example.com/font.woff2",
            "data_base64": "<base64编码的woff2字体>"
        }
    ],
    "session_id": "optional-session-id"
}
```

**响应**：
```json
{
    "text": "解码后的纯文本",
    "stats": {
        "total_chars": 100,
        "exact": 85,
        "knn": 10,
        "cnn": 3,
        "unknown": 2,
        "accuracy_estimate": 0.97
    }
}
```

**统计字段说明**：

| 字段 | 含义 |
|------|------|
| `exact` | Solution B 精确哈希匹配 |
| `knn` | Solution B FAISS KNN 匹配 |
| `cnn` | Solution C ViT-Tiny CNN 分类 |
| `unknown` | 未能识别的字符（待 Solution A OCR） |

---

## 故障排除

### Docker 未运行

```
ERROR: Docker is installed but not running.
```

**解决**：启动 Docker Desktop，等待鲸鱼图标停止动画。

### 参考数据库构建失败

```
ERROR: Reference database build failed.
```

**解决**：
1. 确认 `data\reference\fonts\` 下有字体文件（运行 `download_fonts.ps1`）
2. 确认 `.venv` 已创建（运行 `setup_windows.ps1`）
3. 手动运行：`.\.venv\Scripts\Activate.ps1; python scripts\build_ref_library.py`

### 健康检查超时

```
WARNING: Health check timed out.
```

**解决**：
1. 查看日志：`docker compose logs fde-api`
2. 常见原因：内存不足（需 ≥8GB RAM）、模型加载失败
3. 检查环境变量：`docker compose config`

### 端口冲突

```
Error: port 8000 already in use
```

**解决**：修改 `docker-compose.yml` 中的端口映射，或停止占用端口的进程。

### 内存不足

Docker 容器需约 4-6 GB RAM。在 Docker Desktop 设置中调整：
- Settings → Resources → Memory → 设为 8 GB 以上

---

## 完整环境搭建顺序（新机器）

如果是全新的 Windows 机器，按以下顺序执行：

```powershell
# 1. 安装 Python 3.11+ (python.org)
#    勾选 "Add Python to PATH"

# 2. 克隆项目
git clone git@github.com:hangsa/zhcp2.git
cd zhcp2/fde
git checkout zhextra

# 3. 安装 Python 环境（~10 分钟）
powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1

# 4. 下载参考字体（~5 分钟）
powershell -ExecutionPolicy Bypass -File scripts\download_fonts.ps1

# 5. 训练模型（~6-8 小时）  ← 如果已有模型文件可跳过
powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1

# 6. 安装 Docker Desktop
#     https://www.docker.com/products/docker-desktop/

# 7. 一键部署（~15-30 分钟）
powershell -ExecutionPolicy Bypass -File scripts\deploy_windows.ps1
```
