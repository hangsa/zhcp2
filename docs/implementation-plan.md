# FDE 详细实施计划

> 基于 [PRD-知乎字体反混淆系统](./PRD-知乎字体反混淆系统.md)，本文档定义各阶段的详细任务、技术规格、依赖关系和验收标准。

---

## 实施总览

```
Phase 0 (W1-2)     Phase 1 (W3-5)      Phase 2 (W6-8)      Phase 3 (W9-10)     Phase 4 (W11-12)    Phase 5 (W13-14)
┌──────────┐       ┌──────────┐        ┌──────────┐         ┌──────────┐         ┌──────────┐         ┌──────────┐
│ 预研     │  ──→  │ 方案 B   │  ───→  │ 方案 C   │  ────→  │ 方案 A   │  ────→  │ 监控告警 │  ────→  │ 稳定性   │
│ 参考字库 │       │ 主力引擎 │        │ 分类器   │         │ OCR兜底  │         │ Dashboard│         │ 压测上线 │
└──────────┘       └──────────┘        └──────────┘         └──────────┘         └──────────┘         └──────────┘
```

---

## Phase 0：预研与环境准备（第 1-2 周）

### 目标

确认知乎当前混淆机制的技术细节，建立参考字库 v0（覆盖 GB2312 一级 3755 字），搭建开发环境。

### Task 0.1：混淆机制逆向确认（2 天）

| 项 | 内容 |
|----|------|
| **负责人** | 算法工程师 |
| **依赖** | 无 |
| **产出** | `docs/phase0-obfuscation-report.md` |

**工作步骤**：

1. **字体文件采集（4h）**
   - 在知乎会员文章页面，通过 Chrome DevTools → Network → Font 过滤，拦截 10+ 个不同文章页面的 woff2 文件
   - 记录每个字体文件的 URL、请求时间、关联 Session Cookie
   - 保存原始 woff2 文件到 `data/samples/` 目录

2. **字体结构分析（8h）**
   - 使用 `fonttools` 的 `ttx` 工具将 woff2 转换为 XML 可读格式
   - 对比同篇文章不同刷新下的字体文件差异：
     ```bash
     ttx -o /tmp/font1.ttx data/samples/page1_refresh1.woff2
     ttx -o /tmp/font2.ttx data/samples/page1_refresh2.woff2
     diff /tmp/font1.ttx /tmp/font2.ttx
     ```
   - 分析 cmap 表、glyf 表、name 表的变化范围
   - 量化字形扰动幅度：提取同一字符在两次请求中的控制点坐标，计算最大偏移量
   - 输出结论：确认混淆等级（L1/L2/L3）、扰动范围（单位）、随机化策略

3. **Session 绑定验证（4h）**
   - 同一 Session 内重复请求字体文件，验证是否复用
   - 不同 Session（清除 Cookie）请求同一文章，验证字体是否不同
   - 记录字体请求的 Headers，识别可能的签名校验字段

**验收标准**：
- 明确知乎当前的混淆等级组合
- 量化字形扰动幅度（控制点偏移范围）
- 确认字体文件与 Session 的绑定关系

### Task 0.2：参考字库 v0 构建（5 天）

| 项 | 内容 |
|----|------|
| **负责人** | 算法工程师 |
| **依赖** | Task 0.1 |
| **产出** | `data/reference/gb2312_level1.db`（SQLite）、`data/reference/faiss_index.faiss` |

**工作步骤**：

1. **字体采集（4h）**
   - 下载思源黑体 SC（Regular、Medium、Bold）、思源宋体 SC（Regular、SemiBold）
   - 下载方正书宋、方正黑体、华文楷体、华文宋体（各 Regular 变体）
   - 目标：10+ 款中文字体，覆盖不同字重和风格
   - 统一放置到 `data/reference/fonts/` 目录

2. **字符集准备（2h）**
   - 生成 GB2312 一级汉字列表（3755 字）作为初始目标
   - 追加 GB2312 二级汉字（3008 字）
   - 追加 CJK 扩展 A 部分（~500 字，人名/地名用字）
   - 追加常用标点符号（~200 个）
   - 输出 `data/reference/target_chars.txt`（每行一个字符）
   - 对齐 PRD §5.6 参考字库需求：合计约 7500 字

3. **轮廓 Hash 提取脚本（8h）**
   - 实现 `scripts/build_ref_library.py`：
     ```python
     # 核心流程
     for font_path in reference_fonts:
         font = TTFont(font_path)
         cmap = font.getBestCmap()
         for char in target_chars:
             glyph_name = cmap.get(ord(char))
             if glyph_name:
                 coords = extract_coordinates(font, glyph_name)
                 normalized = normalize(coords, tolerance=1.0)
                 hash_value = md5(normalized)
                 save_to_db(char, hash_value, font_path, normalized)
     ```
   - `extract_coordinates()`: 从 glyf 表提取所有轮廓点 (x, y, on_curve_flag)
   - `normalize()`: 按 x/y 范围线性映射到 [0, 100]，round(value, 1) 量化

4. **数据库写入（4h）**
   - SQLite 表结构：
     ```sql
     CREATE TABLE glyph_hashes (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         char TEXT NOT NULL,
         unicode INTEGER NOT NULL,
         hash TEXT NOT NULL,
         font_name TEXT NOT NULL,
         coords_blob BLOB,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
     );
     CREATE INDEX idx_hash ON glyph_hashes(hash);
     CREATE INDEX idx_char ON glyph_hashes(char);
     CREATE INDEX idx_unicode ON glyph_hashes(unicode);
     ```

5. **FAISS 索引构建（4h）**
   - 从 SQLite 中提取所有规范化坐标数组
   - 将每组坐标展平为固定维度向量（补零对齐）
   - 构建 FAISS IVF 索引（nlist=100，nprobe=10）
   - 验证：对给定轮廓向量，top-1 搜索返回正确字符，top-3 包含正确字符

6. **覆盖率自检（2h）**
   - 统计：GB2312 一级字中至少有一种字体覆盖的字数 / 3755
   - 缺字报告：列出无任何参考字体覆盖的字符
   - 验收目标：覆盖率 ≥ 99%（即 ≤ 38 字缺失）

**验收标准**：
- SQLite 数据库包含 ≥ 3755 字 × ≥ 10 款字体 ≈ 37,550+ 条 Hash 记录
- FAISS 索引可执行 top-3 搜索，延迟 < 1ms
- GB2312 一级字覆盖率 ≥ 99%

### Task 0.3：开发环境搭建（1 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | 无 |
| **产出** | `docker-compose.yml`、`requirements.txt`、`pyproject.toml` |

**工作步骤**：

1. **项目骨架创建**
   ```
   fde/
   ├── proxy/              # mitmproxy 拦截模块
   ├── engine/             # 核心引擎
   ├── models/             # 模型文件
   ├── data/
   │   └── reference/
   │       ├── fonts/      # 参考字体
   │       └── db/         # 参考字库 SQLite
   ├── cache/              # Redis 缓存客户端
   ├── monitor/            # 漂移检测
   ├── api/                # REST API
   ├── scripts/            # 工具脚本
   ├── tests/              # 测试套件
   ├── docker-compose.yml
   ├── Dockerfile
   └── pyproject.toml
   ```

2. **依赖安装**
   ```toml
   # pyproject.toml
   [project]
   dependencies = [
       "fonttools>=4.50",
       "mitmproxy>=10.0",
       "Pillow>=10.0",
       "pycairo>=1.26",
       "faiss-cpu>=1.7",
       "torch>=2.0",
       "torchvision>=0.15",
       "fastapi>=0.110",
       "uvicorn>=0.27",
       "redis>=5.0",
       "playwright>=1.40",
       "paddleocr>=2.7",
       "prometheus-client>=0.19",
   ]
   ```

3. **Docker Compose 配置**
   ```yaml
   services:
     redis:
       image: redis:7-alpine
       ports: ["6379:6379"]
     fde-api:
       build: .
       ports: ["8000:8000"]
       environment:
         - REDIS_URL=redis://redis:6379
         - DB_PATH=/app/data/reference/db/glyphs.db
         - FAISS_INDEX=/app/data/reference/db/faiss_index.faiss
     mitmproxy:
       build:
         dockerfile: Dockerfile.mitm
       ports: ["8080:8080"]
   ```

4. **验证**
   - `docker compose up` 所有服务正常启动
   - `curl http://localhost:8000/health` 返回 200

**合规检查点**（对齐 PRD §9.2）：
1. 评估知乎服务条款中关于字体文件与内容提取的规定 — Phase 0 启动前
2. 仅在个人已购买会员内容的范围内使用系统 — 全阶段
3. 不公开发布可直接运行的完整字体逆向代码 — 代码仓库设为私有
4. 发现漏洞先向平台方负责任披露，给予 90 天修复期 — 若适用

---

## Phase 1：方案 B — 字体逆向引擎（第 3-5 周）

### 目标

实现 FontReverser 核心模块，在无扰动场景下达到 ≥ 97% 准确率。建立完整的测试框架。

### Task 1.1：轮廓提取与归一化引擎（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 算法工程师 |
| **依赖** | Phase 0 完成 |
| **产出** | `engine/glyph_normalizer.py` |

**技术规格**：

```python
# engine/glyph_normalizer.py

import hashlib
from dataclasses import dataclass
from typing import Sequence

@dataclass
class GlyphContour:
    """字形轮廓归一化后的表示"""
    coords: list[tuple[float, float, int]]  # (x, y, flag)
    hash: str                                # MD5 hex digest

def extract_raw_coordinates(
    font,
    glyph_name: str,
    max_depth: int = 10,
    _visited: set | None = None
) -> list[tuple[float, float, int]]:
    """
    从 TTFont 的 glyf 表中提取指定字形的所有轮廓点坐标。
    - 处理 compound glyphs（递归展开子字形引用，最大深度 max_depth）
    - 循环引用检测：_visited 集合跟踪已访问字形，防止无限递归
    - 坐标应用 'glyf' 变换矩阵（包括复合字形的平移/缩放/旋转）
    - flag: 0 = off-curve, 1 = on-curve (TrueType convention)
    - 超过 max_depth 或检测到循环引用时记录 warning，返回已提取的部分坐标
    """
    pass

def normalize_glyph(
    raw_coords: list[tuple[float, float, int]],
    tolerance: float = 1.0
) -> GlyphContour:
    """
    归一化流程：
    1. 计算 x/y 的范围 [min, max]
    2. 线性映射到 [0, 100] 坐标空间
    3. 量化：round(value / tolerance) * tolerance
       对齐 PRD §5.3「坐标量化精度：round(value, 1)」—— tolerance=1.0 时二者等价。
       更粗的 tolerance（如 2.0）可吸收更大的扰动噪声但会降低区分度。
    4. 按 (x, y, flag) 排序，确保序列化顺序稳定
    5. 序列化为字符串，计算 MD5
    """
    pass

def match_score(vec_a: list[float], vec_b: list[float]) -> float:
    """
    欧氏距离 → 相似度分数。
    使用指数衰减：score = exp(-dist / sigma)，sigma = 5.0
    - dist = 0    → score = 1.00（精确匹配）
    - dist = 2.5  → score ≈ 0.61（PRD 容差阈值 ε=2.5）
    - dist = 5.0  → score ≈ 0.37
    - dist = 15.0 → score ≈ 0.05（典型 ±3 扰动字形）
    返回 [0, 1]，1 为完全匹配。

    注：此处不使用 1/(1+dist)，因为归一化坐标在 [0,100] 空间，
    典型扰动字形距离约 15，1/(1+15)=0.06 会导致所有 KNN 结果被拒绝。
    """
    pass
```

**测试**：
- 用已知的两个同字符字体渲染，验证归一化后 Hash 一致
- 用两个不同字符渲染，验证 Hash 不同
- 对坐标加 ±2 单位噪声，验证 Hash 仍一致（tolerance=2.0 时）

### Task 1.2：FAISS 向量索引集成（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 算法工程师 |
| **依赖** | Task 1.1 |
| **产出** | `engine/faiss_index.py`、`engine/font_reverser.py` |

**技术规格**：

```python
# engine/faiss_index.py

class FAISSHashIndex:
    """FAISS IVF 索引封装，支持精确匹配 + 最近邻搜索"""

    def __init__(self, db_path: str, index_path: str):
        self._conn = sqlite3.connect(db_path)
        self._index = faiss.read_index(index_path)
        self._id_to_char: dict[int, tuple[str, float]] = {}  # faiss_id → (char, max_score)

    def exact_match(self, glyph_hash: str) -> str | None:
        """SQLite 精确 Hash 匹配，O(1)"""
        pass

    def knn_search(self, vector: np.ndarray, k: int = 3) -> list[tuple[str, float]]:
        """
        FAISS KNN 搜索。
        Returns: [(字符, 欧氏距离), ...] 距离越小越相似
        """
        pass

    def brute_force_search(self, vector: np.ndarray) -> tuple[str, float] | None:
        """
        FAISS 精确全量搜索（flat L2 index 或 IndexFlatL2 临时搜索）。
        当 IVF 近似搜索 top-1 距离 ≥ 5.0 时回退使用，避免遗漏正确聚类。
        比 KNN 慢（O(n) vs O(log n)），仅作为罕见兜底路径。
        """
        pass

    def batch_match(self, hashes: list[str], vectors: list[np.ndarray],
                    distance_threshold: float = 2.5) -> dict[str, str]:
        """批量匹配：优先精确，fallback 到 KNN（距离 < distance_threshold 即采纳）"""
        pass
```

```python
# engine/font_reverser.py

from fonttools.ttLib import TTFont
from io import BytesIO
import math

# KNN 距离阈值：对齐 PRD 容差 ε = 2.5
KNN_DISTANCE_THRESHOLD = 2.5

# 距离 → 置信度转换（用于上报 stats，非判定逻辑）
def distance_to_confidence(dist: float, sigma: float = 5.0) -> float:
    """欧氏距离 → [0,1] 置信度，exp(-dist/sigma)"""
    return math.exp(-dist / sigma)

class FontReverser:
    """方案 B：字体逆向还原引擎"""

    def __init__(self, faiss_index: FAISSHashIndex, tolerance: float = 1.0):
        self._index = faiss_index
        self._tolerance = tolerance

    def build_mapping(self, woff2_bytes: bytes) -> dict[int, dict]:
        """
        从 woff2 字节流构建混淆码点 → 真实字符映射

        Returns:
            {unicode_codepoint: {"char": str, "method": "exact"|"knn"|"knn_bf", "score": float}}
        """
        if len(woff2_bytes) > MAX_WOFF2_SIZE:
            raise ValueError(f"字体文件过大: {len(woff2_bytes)} bytes (max {MAX_WOFF2_SIZE})")
        font = TTFont(BytesIO(woff2_bytes))
        cmap = font.getBestCmap()

        mapping = {}
        for codepoint, glyph_name in cmap.items():
            raw_coords = extract_raw_coordinates(font, glyph_name)
            if not raw_coords:
                continue
            contour = normalize_glyph(raw_coords, self._tolerance)

            # 1. 精确 Hash 匹配
            matched = self._index.exact_match(contour.hash)
            if matched:
                mapping[codepoint] = {"char": matched, "method": "exact", "score": 1.0}
                continue

            # 2. KNN 最近邻搜索（距离阈值对齐 PRD ε = 2.5）
            vector = coords_to_vector(contour.coords)
            candidates = self._index.knn_search(vector, k=3)
            best_char, best_dist = candidates[0]
            if best_dist < KNN_DISTANCE_THRESHOLD:
                score = distance_to_confidence(best_dist)
                mapping[codepoint] = {"char": best_char, "method": "knn", "score": score}
            elif best_dist >= 5.0:
                # FAISS IVF 近似搜索可能遗漏正确聚类（nprobe 不足）
                # 回退到精确全量搜索（brute-force flat L2 over all vectors）
                result = self._index.brute_force_search(vector)
                if result and result[1] < KNN_DISTANCE_THRESHOLD:
                    score = distance_to_confidence(result[1])
                    mapping[codepoint] = {"char": result[0], "method": "knn_bf", "score": score}

        return mapping
```

**测试**：
- 无扰动字体：精确匹配率 100%
- ±3 单位扰动字体：精确匹配率 ≥ 90%，KNN 后 ≥ 97%

### Task 1.3：mitmproxy 字体拦截模块（5 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Phase 0 环境搭建 |
| **产出** | `proxy/interceptor.py`、`proxy/font_extractor.py` |

**技术规格**：

```python
# proxy/interceptor.py

from mitmproxy import http, ctx
import re

class FontInterceptor:
    """
    mitmproxy 插件：拦截知乎页面请求，提取 woff2 字体文件。

    功能：
    1. 检测知乎文章页面 URL pattern
    2. 拦截 CSS @font-face 中的 woff2 请求
    3. 将页面 HTML 和字体文件一起发送给 FDE Pipeline
    4. 将还原后的文本注入页面响应或返回给插件

    TLS 降级方案（对齐 PRD 风险 #3）：
    - 首选：mitmproxy 中间人 HTTPS 拦截（需用户安装 CA 证书）
    - 降级：若证书固定 (cert pinning) 导致拦截失败，回退到浏览器插件方案
      通过 Chrome Extension 的 webRequest API 直接读取字体响应体
    - 检测：首次拦截时自动探测目标站点 TLS 指纹，判断是否可拦截
    """

    FONT_URL_PATTERN = re.compile(r'\.woff2?\??', re.I)
    ZHIHU_ARTICLE_PATTERN = re.compile(r'zhihu\.com/(p|pin|question|column)/')

    def __init__(self, fde_api_url: str = "http://localhost:8000"):
        self._fde_url = fde_api_url
        self._font_cache: dict[str, bytes] = {}       # url → font_bytes
        self._pending_fonts: set[str] = set()          # 待处理的字体 URL
        self._collected_fonts: list[bytes] = []         # 当前页面的字体集合
        self._tls_interceptable: bool | None = None     # TLS 可拦截性探测

    def request(self, flow: http.HTTPFlow):
        """拦截字体请求，缓存 woff2 文件"""
        pass

    def response(self, flow: http.HTTPFlow):
        """拦截页面 HTML 响应，触发 FDE 处理"""
        pass

    def check_tls_interceptable(self, target_url: str) -> bool:
        """
        探测目标站点 TLS 是否可拦截。
        - 成功 → 启用代理模式
        - 证书固定 / key pinning → 建议用户切换到浏览器插件模式
        """
        pass
```

```python
# proxy/font_extractor.py

def extract_font_urls(html: str) -> list[str]:
    """从页面 HTML/CSS 中提取所有 woff2 字体 URL"""
    # 正则匹配 @font-face 中的 url(...)
    # 正则匹配 <link> 中的 font 预加载
    pass

def filter_zhihu_fonts(urls: list[str]) -> list[str]:
    """过滤出知乎混淆字体的 URL（排除第三方字体 CDN）"""
    pass

def download_font(url: str, headers: dict) -> bytes | None:
    """带 Session Cookie 下载字体文件"""
    pass
```

**测试**：
- 使用保存的知乎页面 HTML 离线测试 URL 提取准确率
- 在本地搭建测试服务器，验证拦截流程

### Task 1.4：Pipeline Orchestrator 框架（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Task 1.2、Task 1.3 |
| **产出** | `engine/pipeline.py`、`api/server.py`（骨架） |

```python
# engine/pipeline.py

from dataclasses import dataclass, field
from enum import Enum

class MatchMethod(Enum):
    EXACT = "exact"       # 方案 B 精确 Hash
    KNN = "knn"           # 方案 B KNN 最近邻
    CLASSIFIER = "cnn"    # 方案 C CNN 分类器
    OCR = "ocr"           # 方案 A OCR
    UNKNOWN = "unknown"   # 未知

@dataclass
class CharMapping:
    codepoint: int
    char: str
    method: MatchMethod
    confidence: float

@dataclass
class DecodeResult:
    text: str
    mappings: dict[int, CharMapping]
    stats: dict

class PipelineOrchestrator:
    """
    FDE 流水线调度器。

    决策流程（对齐 PRD §5.1 优先级级联）：
    0. 方案 D（API 直取）—— 若可用则跳过字体处理，直接返回纯文本
       TODO: Phase 3+ 实现知乎 GraphQL/mobile API 端点探索
    1. 尝试方案 B（FontReverser）→ 精确 Hash + KNN
    2. 未匹配字形 → 方案 C（GlyphClassifier）
    3. 低置信度字形 → 方案 A（OCRFallback）
    """

    def __init__(self,
                 font_reverser: FontReverser,
                 classifier: 'GlyphClassifier | None' = None,
                 ocr: 'OCRFallback | None' = None):
        self._reverser = font_reverser
        self._classifier = classifier
        self._ocr = ocr
        self._cache: dict[str, dict] = {}

    async def process(self,
                      html: str,
                      font_bytes: list[bytes],
                      options: dict | None = None) -> DecodeResult:
        """
        主入口：处理页面，返回还原文本。

        级联策略：
        0. 检查方案 D（API 直取）是否可用 → 若命中则零成本返回
        1. 方案 B 精确 Hash + KNN（主力）
        2. 方案 C CNN 分类（兜底未匹配字形）
        3. 方案 A OCR（处理低置信度字形）
        """
        pass
```

```python
# api/server.py（Phase 1 骨架）

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="FDE API", version="0.1.0")

@app.get("/health")
async def health():
    return {"status": "ok"}

# POST /api/v1/decode — Phase 1 先不做，等 Pipeline 完整后再开放
```

### Task 1.4b：多字体映射与元素级匹配（2 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Task 1.3、Task 1.4 |
| **产出** | `engine/font_resolver.py`（新增）、更新 `proxy/font_extractor.py` |

**背景**：知乎页面通常加载多个混淆字体（zhfont 分支实测单页 4 个），不同 `<span>` 标签使用不同 `font-family`。Pipeline 需为每个字体独立建立映射表，并在文本替换时按元素匹配对应字体。

**设计方案**：

```python
# engine/font_resolver.py

@dataclass
class FontEntry:
    """单次页面加载中的一个混淆字体"""
    family: str           # CSS font-family 名称
    url: str              # woff2 文件 URL
    woff2_bytes: bytes    # 字体文件字节流
    mapping: dict[int, dict] | None = None  # 该字体的码点→字符映射

class FontResolver:
    """
    管理单次页面请求中的多字体映射。

    工作流：
    1. 解析页面 CSS，提取所有 @font-face → family/URL 对
    2. 拦截每个 woff2 文件，存入 FontEntry
    3. 对每个 FontEntry 独立运行方案 B/C/A，建立 mapping
    4. 文本替换时：对每个 DOM 元素 → 查 computed font-family → 用对应 mapping
    """

    def __init__(self):
        self._fonts: dict[str, FontEntry] = {}  # family → FontEntry

    def register_font(self, family: str, url: str, woff2_bytes: bytes):
        """注册一个页面字体"""
        self._fonts[family] = FontEntry(family=family, url=url, woff2_bytes=woff2_bytes)

    async def build_all_mappings(self, pipeline: PipelineOrchestrator):
        """对所有已注册字体运行 build_mapping"""
        for entry in self._fonts.values():
            if entry.mapping is None:
                entry.mapping = await pipeline.build_mapping_for_font(entry.woff2_bytes)

    def decode_element(self, element_text: str, font_family: str) -> str:
        """对指定元素的文本应用对应字体的映射表"""
        entry = self._fonts.get(font_family)
        if not entry or not entry.mapping:
            return element_text
        return apply_mapping(element_text, entry.mapping)

    def get_merged_mapping(self) -> dict[int, dict]:
        """
        合并所有字体的映射表。
        同一码点在不同字体中有不同映射时，保留首次出现的映射。
        用于无法确定具体 font-family 的 fallback 场景。
        """
        merged = {}
        for entry in self._fonts.values():
            if entry.mapping:
                for cp, info in entry.mapping.items():
                    if cp not in merged:
                        merged[cp] = info
        return merged
```

**font_extractor.py 更新**：CSS 解析时记录 `font-family → URL` 映射。

```python
# proxy/font_extractor.py 新增

def extract_font_family_map(html: str, styles: list[str]) -> dict[str, str]:
    """
    从 @font-face 规则中提取 {font-family: woff2_url} 映射。
    去重：同一 URL 不同 family 是同一个字体文件，合并处理。
    """
    pass
```

**Pipeline 更新**：`process()` 方法增加 font_family 参数。

```python
async def process(self,
                  html: str,
                  font_map: dict[str, bytes],  # {family: woff2_bytes}
                  options: dict | None = None) -> DecodeResult:
    resolver = FontResolver()
    for family, woff2_bytes in font_map.items():
        resolver.register_font(family, url="", woff2_bytes=woff2_bytes)
    await resolver.build_all_mappings(self)

    # 对正文区域文本元素逐一解码
    decoded_text = apply_multi_font_decode(html, resolver)
    return DecodeResult(text=decoded_text, ...)
```

**验收标准**：
- 页面包含 N 个自定义字体时，每个字体独立建立映射
- 文本元素按 computed font-family 匹配正确字体
- 合并 fallback 在无法确定 font-family 时仍可用

### Task 1.5：方案 B 端到端集成测试（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 测试工程师 + 算法工程师 |
| **依赖** | Task 1.1 ~ 1.4 |
| **产出** | `tests/test_font_reverser.py`、`tests/integration/test_pipeline_b.py` |

**测试用例**：

```python
# tests/test_font_reverser.py

class TestGlyphNormalizer:
    def test_same_char_same_font_same_hash(self): ...
    def test_same_char_different_font_different_hash(self): ...
    def test_noise_within_tolerance_same_hash(self): ...
    def test_different_chars_different_hash(self): ...
    def test_empty_glyph_handled(self): ...
    def test_compound_glyph_extraction(self): ...
    def test_compound_glyph_max_depth_handled(self): ...
    def test_compound_glyph_cycle_detection(self): ...

class TestFontReverser:
    def test_clean_font_100_percent_exact_match(self): ...
    def test_perturbed_font_90_percent_exact_match(self): ...
    def test_knn_fallback_on_unmatched(self): ...
    def test_batch_processing_performance(self): ...
```

**基准数据集**：
- `data/tests/clean_font.woff2`：已知映射的无扰动字体，包含 100 个字符
- `data/tests/noise_level1.woff2`：±1 单位扰动
- `data/tests/noise_level2.woff2`：±3 单位扰动
- `data/tests/noise_level3.woff2`：±5 单位扰动

**准确性评测流程**（对齐 PRD §4.1）：
- 双盲人工标注：从 50+ 篇知乎会员文章中各抽样 20 字，共 1000 字
- 标注员 A / B 独立判定每个字符的还原正确性
- 计算 Cohen's Kappa 一致性系数，目标 > 0.9
- 不一致样本由第三位标注员仲裁
- 最终准确率 = 一致判定正确的字符数 / 总字符数
- 形近字专项：单独抽样 200 字形近字对，计算形近字准确率

### Phase 1 交付清单

| 文件 | 说明 | 行数估 |
|------|------|--------|
| `engine/glyph_normalizer.py` | 轮廓提取与归一化 | ~200 |
| `engine/faiss_index.py` | FAISS 索引封装 | ~150 |
| `engine/font_reverser.py` | 字体逆向主引擎 | ~200 |
| `engine/pipeline.py` | 流水线调度器（骨架） | ~150 |
| `proxy/interceptor.py` | mitmproxy 插件 | ~200 |
| `proxy/font_extractor.py` | 字体提取器 | ~100 |
| `api/server.py` | REST API（骨架） | ~50 |
| `scripts/build_ref_library.py` | 参考字库构建（Phase 0） | ~200 |
| `tests/test_font_reverser.py` | 方案 B 单元测试 | ~200 |
| `tests/integration/test_pipeline_b.py` | 集成测试 | ~100 |
| **合计** | | **~1750 行** |

---

## Phase 2：方案 C — CNN 字形分类器（第 6-8 周）

### 目标

训练 ViT-Tiny 汉字字形分类模型，推理速度 ≤ 3ms/字（CPU），与方案 B 组合后综合准确率 ≥ 99%。

### Task 2.1：训练数据集构建（4 天）

| 项 | 内容 |
|----|------|
| **负责人** | 算法工程师 |
| **依赖** | Phase 0 参考字库 |
| **产出** | `data/training/` 目录下的训练/验证/测试集 |

**数据生成流程**：

```python
# scripts/generate_training_data.py

"""
生成方案 C 训练数据。

数据构成：
1. 基础数据 (~300 万)
   - 6763 GB2312 汉字 × 50 种字体 × 多种字号(16/24/32/48/64px)
   - 每种字体分别渲染为 64×64 灰度图

2. 增强数据 (基础数据的 2×)
   - 仿射变换：±3° 旋转 + ±5% 缩放
   - 高斯噪声：σ = 2.0 像素
   - 亮度抖动：±15%
   - 笔画宽度随机 ±1px（模拟不同字重）

3. 专项数据
   - 从知乎实际采集的混淆字形样本（需人工标注）
   - 形近字对专项增强（己/已/巳、未/末、土/士 等）

输出格式：
    data/training/
    ├── train/
    │   ├── 0/           # 类别 ID = Unicode 偏移
    │   │   ├── 00001.png
    │   │   └── ...
    │   └── ...
    ├── val/
    └── test/
    labels.json           # {class_id: char}
"""
```

**渲染实现**：

```python
# engine/glyph_renderer.py

import cairo
from PIL import Image
from fonttools.ttLib import TTFont

def render_glyph_to_image(
    font: TTFont,
    glyph_name: str,
    size: int = 64
) -> Image.Image:
    """
    使用 pycairo/Pillow 将字形渲染为灰度图。
    1. 提取 glyph 轮廓
    2. 在 64×64 画布上绘制
    3. 二值化（Otsu 阈值）
    4. 居中裁剪
    """
    pass

def render_with_augmentation(
    font: TTFont,
    glyph_name: str,
    size: int = 64,
    augment: bool = False
) -> list[Image.Image]:
    """生成原始图像 + 增强变体"""
    pass
```

### Task 2.2：ViT-Tiny 模型训练（5 天）

| 项 | 内容 |
|----|------|
| **负责人** | 算法工程师 |
| **依赖** | Task 2.1 |
| **产出** | `models/vit_tiny_zh.pt`、`scripts/train_classifier.py` |

**模型规格**：

| 参数 | 值 |
|------|-----|
| 架构 | ViT-Tiny (patch=4, dim=192, depth=12, heads=3) |
| 输入 | 64×64 灰度图（单通道，复制为 3 通道） |
| 分类头 | 6763 类（GB2312 全量） |
| 参数量 | ~5.7M |
| 模型大小 | ~22 MB（FP32）/ ~6 MB（INT8 量化） |

**训练参数**：

| 参数 | 值 |
|------|-----|
| Epochs | 100（early stop patience=10） |
| Batch size | 256 |
| Optimizer | AdamW (lr=3e-4, weight_decay=0.05) |
| Scheduler | Cosine annealing with warmup (5 epochs) |
| Loss | CrossEntropy + LabelSmoothing(0.1) |
| Augmentation | RandAugment (N=2, M=9) |

**训练脚本**：

```python
# scripts/train_classifier.py

"""
训练流程：
1. 加载数据集（ImageFolder）
2. 构建 ViT-Tiny 模型
3. 训练循环 + 验证
4. 形近字专项评估
5. 导出 TorchScript 模型和 ONNX 模型
"""

# 关键评估函数
def evaluate_shape_similar_chars(model, dataloader) -> dict:
    """形近字专项评估：己/已/巳、未/末、土/士 等"""
    similar_pairs = [
        ("己", "已"), ("已", "巳"), ("未", "末"),
        ("土", "士"), ("人", "入"), ("千", "干"),
        ("曰", "日"), ("天", "夭"), ...
    ]
    # 对每对形近字测试分类准确率
    pass
```

**验收标准**：
- 验证集 Top-1 准确率 ≥ 99.0%
- 形近字专项 Top-1 准确率 ≥ 98.0%
- 单次推理延迟 ≤ 3ms（CPU）

### Task 2.3：GlyphClassifier 服务封装（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 + 算法工程师 |
| **依赖** | Task 2.2 |
| **产出** | `engine/glyph_classifier.py` |

```python
# engine/glyph_classifier.py

import torch

class GlyphClassifier:
    """方案 C：基于 ViT-Tiny 的字形图像分类器"""

    def __init__(self, model_path: str, device: str = "cpu",
                 confidence_threshold: float = 0.95,
                 batch_size: int = 32):
        self._model = torch.jit.load(model_path).to(device)
        self._threshold = confidence_threshold
        self._batch_size = batch_size
        self._device = device

    def classify_glyph(self, image_tensor: torch.Tensor) -> list[tuple[str, float]]:
        """单字形分类，返回 Top-3 [(字符, 置信度), ...]"""
        pass

    def classify_batch(self,
                       font: TTFont,
                       glyph_names: list[str],
                       renderer: GlyphRenderer
                       ) -> dict[str, tuple[str, float, str]]:
        """
        批量分类。
        Returns: {glyph_name: (char, confidence, method)}
        仅返回 confidence ≥ threshold 的结果
        """
        pass
```

### Task 2.4：Pipeline 集成方案 B + C（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Task 2.3、Task 1.4 |
| **产出** | 更新 `engine/pipeline.py` |

```
新增处理节点：
  PipelineOrchestrator.process()
    ├─ 方案 B: FontReverser.build_mapping()  → 精确 + KNN 匹配
    ├─ 提取未覆盖字符的 glyph_name 列表
    ├─ 方案 C: GlyphClassifier.classify_batch()  → CNN 分类
    └─ 合并 mapping，记录 stats
```

**验收标准**：
- 方案 B + C 组合在测试字体（含扰动）上准确率 ≥ 99%
- 处理 1000 字页面平均延迟 ≤ 200ms

### Phase 2 交付清单

| 文件 | 说明 | 行数估 |
|------|------|--------|
| `engine/glyph_renderer.py` | 字形渲染（Cairo/Pillow） | ~150 |
| `engine/glyph_classifier.py` | CNN 分类器封装 | ~150 |
| `models/vit_tiny_zh.pt` | 训练好的模型文件 | 二进制 |
| `scripts/train_classifier.py` | 模型训练脚本 | ~300 |
| `scripts/generate_training_data.py` | 训练数据生成 | ~200 |
| `engine/pipeline.py`（更新）| 集成方案 C | +100 |
| `tests/test_glyph_classifier.py` | 分类器测试 | ~150 |
| **合计** | | **~1050 行 + 模型文件** |

---

## Phase 3：方案 A — OCR 兜底 + Pipeline 完整串联（第 9-10 周）

### 目标

集成 PaddleOCR 作为最终兜底方案，完成全链路 Pipeline 调度，全链路准确率 ≥ 99.5%。

### Task 3.1：OCR Fallback 模块（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Phase 2 |
| **产出** | `engine/ocr_fallback.py` |

```python
# engine/ocr_fallback.py

from paddleocr import PaddleOCR
from playwright.async_api import async_playwright
import asyncio

class OCRFallback:
    """方案 A：Playwright + PaddleOCR 截图识别兜底"""

    def __init__(self, pool_size: int = 4, timeout: float = 3.0):
        self._ocr = PaddleOCR(lang='ch', show_log=False)
        self._pool_size = pool_size
        self._timeout = timeout
        self._browsers: list = []

    async def _ensure_pool(self):
        """确保 Playwright 浏览器实例池可用"""
        if not self._browsers:
            self._playwright = await async_playwright().start()
            for _ in range(self._pool_size):
                browser = await self._playwright.chromium.launch()
                self._browsers.append(browser)

    async def recognize_chars(
        self,
        html_snippet: str,
        codepoints: list[int],
        font_family: str
    ) -> dict[int, tuple[str, float]]:
        """
        对指定码点列表进行 OCR 识别。

        优化策略：
        1. 将所有待识别字符合并为一个 HTML 片段
        2. 设置 font-family 为页面实际使用的混淆字体
        3. 截图后按字符位置切分
        4. 对每张子图调用 PaddleOCR

        Returns: {codepoint: (char, confidence)}
        """
        pass

    async def _ocr_single(self, image_bytes: bytes) -> tuple[str, float]:
        """单张图片 OCR"""
        pass

    async def shutdown(self):
        """清理 Playwright 实例"""
        pass
```

**关键优化**：
- 字符聚合：同一页面的兜底字符合并为一张大图，减少 Playwright 截取次数
- 实例池：复用 4 个 Chromium 进程，避免重复启动开销
- 超时控制：单字 > 3s 则标记为低置信度，进入人工复核队列

### Task 3.2：Redis 缓存层（2 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Phase 1 Pipeline |
| **产出** | `cache/redis_client.py` |

```python
# cache/redis_client.py

import redis
import hashlib
import json

# 字体文件大小上限（防止解压炸弹 / OOM）
MAX_WOFF2_SIZE = 5 * 1024 * 1024  # 5 MB

class MappingCache:
    """字体 Hash → 映射表缓存"""

    def __init__(self, redis_url: str, ttl: int = 3600):
        self._client = redis.from_url(redis_url)
        self._ttl = ttl  # Session 生命周期内有效（滑动续期）

    def _font_hash(self, font_bytes: bytes) -> str:
        """计算字体文件的整体 Hash 作为缓存键"""
        if len(font_bytes) > MAX_WOFF2_SIZE:
            raise ValueError(f"字体文件过大: {len(font_bytes)} bytes (max {MAX_WOFF2_SIZE})")
        return hashlib.sha256(font_bytes).hexdigest()[:16]

    def get_mapping(self, font_bytes: bytes) -> dict | None:
        """
        从缓存读取映射表，命中时续期 TTL（sliding TTL）。
        字体文件绑定 Session，滑动 TTL 保证活跃 Session 不掉缓存。
        """
        key = self._font_hash(font_bytes)
        pipe = self._client.pipeline()
        pipe.get(key)
        pipe.expire(key, self._ttl)  # 滑动续期
        data, _ = pipe.execute()
        return json.loads(data) if data else None

    def set_mapping(self, font_bytes: bytes, mapping: dict):
        """写入映射表缓存"""
        key = self._font_hash(font_bytes)
        self._client.setex(key, self._ttl, json.dumps(mapping))

    def get_stats(self) -> dict:
        """缓存命中统计"""
        pass
```

### Task 3.3：REST API 完整实现（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Task 3.1、3.2 |
| **产出** | `api/server.py`（完整版） |

```python
# api/server.py

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import Optional
import base64

class DecodeRequest(BaseModel):
    html: str = Field(..., description="页面 HTML 文本")
    font_bytes: str = Field(..., description="字体文件 Base64 编码")
    session_id: str = Field(..., description="会话标识符")
    options: Optional[DecodeOptions] = None

class DecodeOptions(BaseModel):
    fallback_ocr: bool = True
    confidence_threshold: float = 0.95

class DecodeResponse(BaseModel):
    text: str
    stats: DecodeStats

class DecodeStats(BaseModel):
    total_chars: int
    method_b_exact: int      # 方案 B 精确匹配
    method_b_knn: int         # 方案 B KNN 匹配
    method_c: int             # 方案 C 分类
    method_a: int             # 方案 A OCR
    unknown: int              # 未识别
    accuracy_estimate: float
    processing_time_ms: float

@app.post("/api/v1/decode", response_model=DecodeResponse)
async def decode(request: DecodeRequest):
    """主解码接口"""
    pass

@app.get("/api/v1/stats")
async def get_stats():
    """返回当前服务的统计信息"""
    pass

@app.get("/api/v1/health")
async def health():
    return {"status": "ok", "uptime": uptime}
```

### Task 3.4：全链路集成测试（2 天）

| 项 | 内容 |
|----|------|
| **负责人** | 测试工程师 |
| **依赖** | Task 3.3 |
| **产出** | `tests/integration/test_full_pipeline.py` |

**测试场景**：

```
场景 1: 无扰动字体
  - 方案 B 精确匹配应覆盖 ≥ 97% 字符
  - 方案 C 覆盖剩余 ≤ 3% 字符
  - 方案 A 触发率为 0

场景 2: ±3 单位扰动字体
  - 方案 B (精确+KNN) 覆盖 ≥ 85% 字符
  - 方案 C 覆盖剩余 ~13%
  - 方案 A 触发 ≤ 2%

场景 3: ±5 单位扰动 + 动态子集
  - 方案 B 覆盖 ≥ 70%
  - 方案 C 覆盖剩余 ~25%
  - 方案 A 触发 ≤ 5%

场景 4: 形近字集中场景
  - 方案 B 覆盖 ≥ 83%
  - 方案 C 覆盖 ≥ 14%
  - 综合准确率 ≥ 98%
```

**端到端测试**（需要安装 mitmproxy）：
```bash
mitmdump -s proxy/interceptor.py --set fde_api_url=http://localhost:8000 &
pytest tests/integration/test_full_pipeline.py -v
```

---

## Phase 4：监控与运维（第 11-12 周）

### 目标

实现策略漂移检测、Prometheus 指标导出、Grafana Dashboard，以及系统告警。

### Task 4.1：Drift Detector（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Phase 3 |
| **产出** | `monitor/drift_detector.py` |

```python
# monitor/drift_detector.py

from dataclasses import dataclass
from collections import deque
import statistics

@dataclass
class DriftThresholds:
    b_exact_rate_min: float = 0.70      # 方案 B 精确匹配率告警线
    c_confidence_min: float = 0.92      # 方案 C 平均置信度告警线
    a_trigger_rate_max: float = 0.05    # 方案 A 触发率告警线
    overall_accuracy_min: float = 0.98  # 整体准确率告警线
    window_size: int = 100              # 滑动窗口大小（最近 N 篇文章）

class DriftDetector:
    """策略漂移检测器"""

    def __init__(self, thresholds: DriftThresholds = DriftThresholds()):
        self._thresholds = thresholds
        self._history = deque(maxlen=thresholds.window_size)

    def record(self, stats: dict):
        """记录一次处理统计"""
        self._history.append(stats)

    def check(self) -> list[str]:
        """检查是否触发告警，返回告警消息列表"""
        if len(self._history) < 10:
            return []  # 数据不足，不告警

        alerts = []
        recent = list(self._history)[-20:]  # 最近 20 次

        # 方案 B 精确匹配率
        b_exact_rate = statistics.mean(
            [s['method_b_exact'] / max(s['total_chars'], 1) for s in recent]
        )
        if b_exact_rate < self._thresholds.b_exact_rate_min:
            alerts.append(f"方案B精确匹配率 {b_exact_rate:.1%} < {self._thresholds.b_exact_rate_min:.0%}")

        # 方案 C 平均置信度
        c_confidence = statistics.mean(
            [s.get('avg_confidence_c', 0) for s in recent if s.get('method_c', 0) > 0]
        )
        if c_confidence and c_confidence < self._thresholds.c_confidence_min:
            alerts.append(f"方案C平均置信度 {c_confidence:.3f} < {self._thresholds.c_confidence_min}")

        # 方案 A 触发率
        a_rate = statistics.mean(
            [s['method_a'] / max(s['total_chars'], 1) for s in recent]
        )
        if a_rate > self._thresholds.a_trigger_rate_max:
            alerts.append(f"方案A触发率 {a_rate:.1%} > {self._thresholds.a_trigger_rate_max:.0%}")

        return alerts
```

### Task 4.2：Prometheus 指标 & Grafana Dashboard（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Phase 3 |
| **产出** | `monitor/metrics.py`、`docker/grafana-dashboard.json` |

```python
# monitor/metrics.py

from prometheus_client import Counter, Histogram, Gauge, generate_latest

# 计数指标
chars_processed_total = Counter(
    'fde_chars_total', 'Total characters processed',
    ['method', 'result']  # method: exact/knn/cnn/ocr, result: success/fail
)
pages_processed_total = Counter(
    'fde_pages_total', 'Total pages processed',
    ['status']  # success/error
)

# 延迟指标
page_processing_seconds = Histogram(
    'fde_page_processing_seconds', 'Page processing latency',
    buckets=[0.01, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0]
)

# 实时指标
accuracy_gauge = Gauge('fde_accuracy_estimate', 'Estimated accuracy')
cache_hit_rate = Gauge('fde_cache_hit_rate', 'Cache hit rate')
method_b_exact_rate = Gauge('fde_method_b_exact_rate', 'Method B exact match rate')
```

**Grafana Dashboard 面板**：

| 面板 | 类型 | 数据源 |
|------|------|--------|
| 整体准确率趋势 | Graph (line) | `fde_accuracy_estimate` |
| 各方案命中占比 | Graph (stacked) | `fde_chars_total{method}` |
| 处理延迟 P50/P99 | Graph (line) | `fde_page_processing_seconds` |
| 方案 B 精确匹配率 | Gauge | `fde_method_b_exact_rate` |
| 缓存命中率 | Gauge | `fde_cache_hit_rate` |
| 漂移告警状态 | Stat | DriftDetector alerts |

### Task 4.3：Admin Dashboard（4 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Task 4.2 |
| **产出** | `api/admin.py`、简单 Web 页面 |

功能：
- 实时准确率统计（按方案拆分）
- 最近 N 次处理记录列表
- 手动校正入口（标注错误映射）
- 参考字库覆盖率面板
- 告警历史记录

---

## Phase 5：稳定性打磨与上线（第 13-14 周）

### 目标

通过压测验证性能指标，完善文档，达到可发布状态。

### Task 5.1：性能压测（4 天）

| 项 | 内容 |
|----|------|
| **负责人** | 测试工程师 + 后端工程师 |
| **依赖** | Phase 4 |
| **产出** | `docs/benchmark-report.md` |

**压测工具**：`locust` 或自定义 `pytest-benchmark`

**压测场景**：

| 场景 | 并发数 | 持续时间 | 目标 |
|------|--------|----------|------|
| 基准负载 | 5 | 30min | P50 < 200ms |
| 中等负载 | 10 | 30min | P99 < 800ms |
| 峰值负载 | 20 | 10min | 无 OOM，无雪崩 |
| 长时间稳定性 | 5 | 4h | 无内存泄漏，可用性 99.9% |

**测试数据准备**：
- 收集 50 个真实知乎文章页面的 HTML + woff2 文件
- 覆盖不同文章类型（技术/文学/社科）、不同长度（500~5000 字）

### Task 5.2：错误处理与边界情况（3 天）

| 项 | 内容 |
|----|------|
| **负责人** | 后端工程师 |
| **依赖** | Task 5.1 |
| **产出** | 更新各模块错误处理 |

**错误处理矩阵**：

| 故障场景 | 处理方式 |
|----------|----------|
| woff2 文件过大（>5MB） | 拒绝处理，返回错误（防止解压炸弹） |
| woff2 文件解析失败 | 跳过该字体，记录 warning，尝试其他字体 |
| FAISS 索引未加载 | 方案 B 跳过，直接走方案 C + A |
| CNN 模型推理失败 | 方案 C 跳过，扩大方案 A 处理范围 |
| PaddleOCR 超时 | 标记该字符为 UNKNOWN |
| Redis 连接失败 | 降级为无缓存模式 |
| mitmproxy 无法拦截 HTTPS | 提示用户安装 CA 证书 |
| 目标站点 TLS 证书固定 | 降级为浏览器插件 webRequest API 方案 |
| 页面无混淆字体 | 直接返回 innerText（无需处理） |

### Task 5.3：文档完善（3 天）

- `README.md`：项目概述、快速开始、架构图
- `docs/deployment.md`：部署指南（Docker / K8s）
- `docs/api-reference.md`：REST API 完整文档
- `docs/troubleshooting.md`：常见问题与排障
- `docs/contributing.md`：开发规范与贡献指南

---

## 附录

### A. 任务依赖关系图

```
Task 0.1 (逆向确认)
  ├─→ Task 0.2 (参考字库)
  │     └─→ Task 1.2 (FAISS 索引) ──→ Task 1.4 (Pipeline)
  └─→ Task 0.3 (环境搭建) ──→ Task 1.3 (mitmproxy 拦截) ──┘
                                          │
Task 1.1 (归一化引擎) ──→ Task 1.2 (FAISS 索引) ──┘
                                          │
                                    Task 1.5 (集成测试 B)
                                          │
Task 2.1 (训练数据) ──→ Task 2.2 (ViT 训练) ──→ Task 2.3 (分类器) ──→ Task 2.4 (B+C 集成)
                                          │
Task 3.1 (OCR) ──┐
Task 3.2 (缓存) ─┤
                 └──→ Task 3.3 (API 完整) ──→ Task 3.4 (全链路测试)
                                          │
Task 4.1 (漂移检测) ──┐
Task 4.2 (Prometheus) ─┤
                       └──→ Task 4.3 (Dashboard)
                                          │
Task 5.1 (压测) ──→ Task 5.2 (错误处理) ──→ Task 5.3 (文档)
```

### B. 关键风险缓解

| 风险 | 缓解措施 | 负责人 | 触发条件 |
|------|----------|--------|----------|
| 参考字库覆盖率不足 | 追加 CJK Ext-A/B 字符，人工复核队列 | 算法工程师 | Phase 0 覆盖率 < 99% |
| ViT 模型过拟合 | 持续收集新字体样本，季度重训 | 算法工程师 | 形近字准确率 < 95% |
| 字体扰动幅度升级 | 动态调整 tolerance 参数，增加 KNN 容差 | 算法工程师 | 方案 B 命中率 < 70% |
| Playwright 内存泄漏 | 实例池心跳检测 + 定时重启 | 后端工程师 | 内存持续增长 > 24h |

### C. 工具体系

```bash
# 开发
pip install -e ".[dev]"

# 测试
pytest tests/ -v --cov=engine --cov-report=html

# Lint
ruff check engine/ proxy/ api/

# 类型检查
mypy engine/ --strict

# 构建参考字库
python scripts/build_ref_library.py

# 训练模型
python scripts/train_classifier.py --epochs 100 --batch-size 256

# 启动服务
docker compose up -d

# 压测
locust -f tests/load/locustfile.py --host http://localhost:8000

# Lint
ruff check engine/ proxy/ api/

# 类型检查
mypy engine/ --strict
```
