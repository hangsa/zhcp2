from __future__ import annotations

"""ViT-Tiny CNN classifier for glyph character recognition (Solution C).

Provides a standalone ViT-Tiny implementation (no timm dependency for inference)
and a GlyphClassifier wrapper with model loading, single/batch classification,
and integration with Solution B's unmatched-glyph pipeline.

Architecture: patch=4, dim=192, depth=12, heads=3, mlp_ratio=4
Input: 64x64 grayscale → ~5.7M params → 6763-class softmax
Target: <= 3ms/char CPU inference, >= 99.4% Top-1 accuracy
"""

import logging
from io import BytesIO
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
from fontTools.ttLib import TTFont
from PIL import Image
from torchvision import transforms

from engine.glyph_renderer import GlyphRenderError, render_glyph

logger = logging.getLogger(__name__)


# --------------- ViT-Tiny Model ---------------


class TransformerBlock(nn.Module):
    """Pre-LN transformer block with multi-head self-attention and MLP."""

    def __init__(self, dim: int, heads: int, mlp_ratio: float = 4.0, dropout: float = 0.0):
        super().__init__()
        self.norm1 = nn.LayerNorm(dim)
        self.attn = nn.MultiheadAttention(dim, heads, dropout=dropout, batch_first=True)
        self.norm2 = nn.LayerNorm(dim)
        self.mlp = nn.Sequential(
            nn.Linear(dim, int(dim * mlp_ratio)),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(int(dim * mlp_ratio), dim),
            nn.Dropout(dropout),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.attn(self.norm1(x), self.norm1(x), self.norm1(x))[0]
        x = x + self.mlp(self.norm2(x))
        return x


class ViTTiny(nn.Module):
    """Vision Transformer Tiny for 64x64 grayscale glyph classification.

    Args:
        num_classes: Number of output classes (characters).
        img_size: Input image size (default 64).
        patch_size: Patch size for embedding (default 4).
        dim: Embedding dimension (default 192).
        depth: Number of transformer blocks (default 12).
        heads: Number of attention heads (default 3).
        mlp_ratio: MLP hidden dimension ratio (default 4.0).
        dropout: Dropout rate (default 0.0).
    """

    def __init__(
        self,
        num_classes: int = 6763,
        img_size: int = 64,
        patch_size: int = 4,
        dim: int = 192,
        depth: int = 12,
        heads: int = 3,
        mlp_ratio: float = 4.0,
        dropout: float = 0.0,
    ):
        super().__init__()
        self.img_size = img_size
        self.patch_size = patch_size
        self.num_patches = (img_size // patch_size) ** 2

        # Patch embedding: 1-channel grayscale → dim
        self.patch_embed = nn.Conv2d(1, dim, kernel_size=patch_size, stride=patch_size)

        # CLS token + position embedding
        self.cls_token = nn.Parameter(torch.zeros(1, 1, dim))
        self.pos_embed = nn.Parameter(torch.zeros(1, self.num_patches + 1, dim))

        # Transformer blocks
        self.blocks = nn.ModuleList([
            TransformerBlock(dim, heads, mlp_ratio, dropout)
            for _ in range(depth)
        ])

        # Classification head
        self.norm = nn.LayerNorm(dim)
        self.head = nn.Linear(dim, num_classes)

        self._init_weights()

    def _init_weights(self):
        nn.init.trunc_normal_(self.pos_embed, std=0.02)
        nn.init.trunc_normal_(self.cls_token, std=0.02)
        self.apply(_init_linear_weights)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        # x: (B, 1, 64, 64)
        x = self.patch_embed(x)          # (B, dim, 16, 16)
        x = x.flatten(2).transpose(1, 2)  # (B, 256, dim)

        cls_tokens = self.cls_token.expand(x.shape[0], -1, -1)
        x = torch.cat([cls_tokens, x], dim=1)  # (B, 257, dim)
        x = x + self.pos_embed

        for block in self.blocks:
            x = block(x)

        x = self.norm(x[:, 0])  # CLS token
        return self.head(x)      # (B, num_classes)


def _init_linear_weights(m: nn.Module):
    if isinstance(m, nn.Linear):
        nn.init.trunc_normal_(m.weight, std=0.02)
        if m.bias is not None:
            nn.init.zeros_(m.bias)


# --------------- Inference Wrapper ---------------


class GlyphClassifier:
    """ViT-Tiny inference wrapper for glyph classification.

    Usage:
        classifier = GlyphClassifier("models/vit_tiny_gb2312.pt",
                                      num_classes=6763,
                                      label_to_char={0: '一', 1: '丁', ...})
        results = classifier.classify_glyph(image)  # top-3 predictions
        additional = classifier.classify_unmatched(woff2_bytes, existing_mapping)
    """

    def __init__(
        self,
        model_path: str | Path,
        num_classes: int,
        label_to_char: dict[int, str],
        device: str = "cpu",
        confidence_threshold: float = 0.95,
    ):
        self._threshold = confidence_threshold
        self._device = torch.device(device)
        self._label_to_char = label_to_char

        checkpoint = torch.load(str(model_path), map_location=self._device, weights_only=True)

        # Checkpoint carries architecture config if saved by train_classifier.py;
        # otherwise fall back to default ViT-Tiny architecture.
        if isinstance(checkpoint, dict) and "config" in checkpoint:
            config = checkpoint["config"]
            self._model = ViTTiny(**config).to(self._device)
            self._model.load_state_dict(checkpoint["state_dict"])
        else:
            self._model = ViTTiny(num_classes=num_classes).to(self._device)
            self._model.load_state_dict(checkpoint)
        self._model.eval()

        self._transform = transforms.Compose([
            transforms.Grayscale(num_output_channels=1),
            transforms.ToTensor(),
        ])

    @property
    def num_classes(self) -> int:
        return self._model.head.out_features

    def classify_glyph(self, image: Image.Image) -> list[tuple[str, float]]:
        """Classify a single 64x64 glyph image. Returns top-3 (char, confidence) pairs."""
        tensor = self._transform(image).unsqueeze(0).to(self._device)
        with torch.no_grad():
            logits = self._model(tensor)
            probs = torch.softmax(logits, dim=-1).squeeze(0)
        top3_values, top3_indices = torch.topk(probs, min(3, probs.shape[0]))
        return [
            (self._label_to_char[idx.item()], val.item())
            for idx, val in zip(top3_indices, top3_values)
        ]

    def classify_batch(
        self, images: list[Image.Image], max_batch_size: int = 256,
    ) -> list[list[tuple[str, float]]]:
        """Classify multiple glyph images, chunked to avoid OOM on large input."""
        if not images:
            return []

        results: list[list[tuple[str, float]]] = []
        for start in range(0, len(images), max_batch_size):
            chunk = images[start:start + max_batch_size]
            batch = torch.stack([self._transform(img) for img in chunk]).to(self._device)
            with torch.no_grad():
                logits = self._model(batch)
                probs = torch.softmax(logits, dim=-1)
            top3_values, top3_indices = torch.topk(probs, min(3, probs.shape[1]), dim=-1)
            for i in range(len(chunk)):
                preds = [
                    (self._label_to_char[idx.item()], val.item())
                    for idx, val in zip(top3_indices[i], top3_values[i])
                ]
                results.append(preds)
        return results

    def classify_unmatched(
        self,
        woff2_bytes: bytes,
        existing_mapping: dict[int, dict],
    ) -> dict[int, dict]:
        """Classify CJK glyphs not matched by Solution B.

        Re-opens the font, finds unmatched CJK codepoints, renders each glyph,
        and runs batch classification. Only accepts predictions with confidence
        >= self._threshold.

        Args:
            woff2_bytes: Raw woff2/ttf font bytes.
            existing_mapping: {codepoint: {"char", "method", "score"}} from
                              Solution B (exact + KNN).

        Returns:
            Additional mappings for unmatched glyphs:
            {codepoint: {"char": str, "method": "cnn", "score": float}}
        """
        # Skip oversized fonts — they would produce too many unmatched glyphs
        # and cause OOM during batch classification. These should be handled
        # by OCR (Solution A) instead.
        max_size = 10 * 1024 * 1024  # 10MB
        if len(woff2_bytes) > max_size:
            logger.debug(
                "Font too large for classifier: %d bytes (max %d)",
                len(woff2_bytes), max_size,
            )
            return {}

        font = TTFont(BytesIO(woff2_bytes))
        try:
            cmap = font.getBestCmap()
            if not cmap:
                logger.warning("No cmap table in font for classifier")
                return {}

            cjk_codepoints = [
                cp for cp in cmap
                if (0x2E80 <= cp <= 0x2FDF)
                or (0x3000 <= cp <= 0x9FFF)
                or (0xF900 <= cp <= 0xFAFF)
                or (0xFF00 <= cp <= 0xFFEF)
            ]

            unmatched = [cp for cp in cjk_codepoints if cp not in existing_mapping]
            if not unmatched:
                return {}

            # Cap to avoid OOM — large unmatched sets should go to OCR
            max_unmatched = 500
            if len(unmatched) > max_unmatched:
                logger.debug(
                    "Too many unmatched glyphs: %d (max %d), skipping classifier",
                    len(unmatched), max_unmatched,
                )
                return {}

            # Render and classify in batch
            images: list[Image.Image] = []
            valid_cps: list[int] = []
            for codepoint in unmatched:
                glyph_name = cmap[codepoint]
                try:
                    img = render_glyph(font, glyph_name)
                    images.append(img)
                    valid_cps.append(codepoint)
                except GlyphRenderError:
                    logger.debug("Classifier: failed to render U+%04X", codepoint)
                    continue

            if not images:
                return {}

            batch_results = self.classify_batch(images)

            results: dict[int, dict] = {}
            for cp, preds in zip(valid_cps, batch_results):
                if not preds:
                    continue
                top_char, top_conf = preds[0]
                if top_conf >= self._threshold:
                    results[cp] = {
                        "char": top_char,
                        "method": "cnn",
                        "score": top_conf,
                    }

            return results
        finally:
            font.close()
