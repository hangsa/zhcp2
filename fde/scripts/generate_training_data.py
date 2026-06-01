#!/usr/bin/env python3
"""Generate training images for CNN glyph classifier from reference fonts.

Renders each character at multiple sizes with optional augmentations,
organizing output into ImageFolder-compatible train/val/test splits.

Usage:
    python scripts/generate_training_data.py --dry-run
    python scripts/generate_training_data.py --fonts-dir data/reference/fonts --chars-file data/reference/target_chars.txt
"""

import argparse
import json
import logging
import math
import os
import random
import sys
from pathlib import Path

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageFilter

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.glyph_renderer import render_glyph

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent


def _apply_augmentation(img: Image.Image) -> Image.Image:
    """Apply random augmentation to a 64x64 glyph image."""
    # Rotation ±5°
    angle = random.uniform(-5.0, 5.0)
    img = img.rotate(angle, resample=Image.BILINEAR, fillcolor=0)

    # Translation ±3px
    dx = random.randint(-3, 3)
    dy = random.randint(-3, 3)
    if dx != 0 or dy != 0:
        img = img.transform(img.size, Image.AFFINE, (1, 0, dx, 0, 1, dy), fillcolor=0)

    # Scale 0.9-1.1x
    scale = random.uniform(0.9, 1.1)
    if scale != 1.0:
        new_size = int(64 * scale)
        scaled = img.resize((new_size, new_size), resample=Image.BILINEAR)
        img = Image.new("L", (64, 64), 0)
        offset = ((64 - new_size) // 2, (64 - new_size) // 2)
        img.paste(scaled, offset)

    # Gaussian noise (sigma 0-2)
    if random.random() < 0.5:
        arr = np.array(img, dtype=np.float32)
        noise = np.random.normal(0, random.uniform(0, 2.0), arr.shape)
        arr = np.clip(arr + noise, 0, 255).astype(np.uint8)
        img = Image.fromarray(arr, mode="L")

    # Brightness jitter ±10%
    if random.random() < 0.5:
        factor = random.uniform(0.9, 1.1)
        arr = np.array(img, dtype=np.float32) * factor
        arr = np.clip(arr, 0, 255).astype(np.uint8)
        img = Image.fromarray(arr, mode="L")

    return img


def _render_char_in_fonts(
    char: str,
    fonts: list[TTFont],
    sizes: list[int],
    augment_count: int,
) -> list[Image.Image]:
    """Render a character across all available fonts and sizes.

    Renders at native 64x64, then scales to each target size via LANCZOS
    and back to 64x64 with BILINEAR (simulates different font rendering
    resolutions). Augmentations are applied at the final 64x64 size.
    """
    images: list[Image.Image] = []
    for font in fonts:
        cmap = font.getBestCmap()
        if cmap is None:
            continue
        cp = ord(char)
        glyph_name = cmap.get(cp)
        if glyph_name is None:
            continue
        try:
            base_img = render_glyph(font, glyph_name)
            for size in sizes:
                # Downscale to target size then back, simulating low-res rendering
                if size != 64:
                    small = base_img.resize((size, size), Image.LANCZOS)
                    img = small.resize((64, 64), Image.BILINEAR)
                else:
                    img = base_img.copy()
                images.append(img)
                # Generate augmentations
                for _ in range(augment_count):
                    images.append(_apply_augmentation(img.copy()))
        except Exception:
            logger.debug("Failed to render U+%04X in font, skipping", cp)
    return images


def generate_dataset(
    fonts_dir: Path,
    chars_file: Path,
    output_dir: Path,
    sizes: list[int] | None = None,
    augment_count: int = 3,
    dry_run: bool = False,
    max_chars: int | None = None,
) -> dict:
    """Generate labeled glyph images in ImageFolder structure.

    Returns metadata dict with class counts and split sizes.
    """
    sizes = sizes or [64]
    fonts: list[TTFont] = []
    for font_path in sorted(fonts_dir.glob("*")):
        if font_path.suffix.lower() in (".ttf", ".otf", ".ttc"):
            try:
                if font_path.suffix.lower() == ".ttc":
                    f = TTFont(str(font_path), fontNumber=0)
                else:
                    f = TTFont(str(font_path))
                fonts.append(f)
                logger.info("Loaded font: %s", font_path.name)
            except Exception as e:
                logger.warning("Failed to load font %s: %s", font_path.name, e)

    if not fonts:
        raise FileNotFoundError(f"No usable fonts found in {fonts_dir}")

    # Read character list
    chars = chars_file.read_text(encoding="utf-8").strip().splitlines()
    chars = [ch.strip() for ch in chars if ch.strip() and not ch.startswith("#")]
    if dry_run and max_chars is None:
        max_chars = 50
    if max_chars:
        chars = chars[:max_chars]

    logger.info("Processing %d characters with %d fonts", len(chars), len(fonts))

    # Gather images per class
    class_images: dict[str, list[Image.Image]] = {}
    for i, ch in enumerate(chars):
        images = _render_char_in_fonts(ch, fonts, sizes, augment_count)
        if images:
            class_images[ch] = images
        if (i + 1) % 100 == 0:
            logger.info("Progress: %d/%d chars, %d classes with images",
                        i + 1, len(chars), len(class_images))

    if not class_images:
        raise RuntimeError("No renderable characters found — check fonts and charset")

    # Build label map (sorted by character for deterministic ordering)
    sorted_chars = sorted(class_images.keys())
    label_map: dict[int, str] = {i: ch for i, ch in enumerate(sorted_chars)}
    label_map_path = output_dir / "label_map.json"
    label_map_path.parent.mkdir(parents=True, exist_ok=True)
    label_map_path.write_text(json.dumps(label_map, ensure_ascii=False, indent=2), encoding="utf-8")

    # Split: 85% train, 10% val, 5% test
    rng = random.Random(42)
    split_counts = {"train": 0, "val": 0, "test": 0}

    for class_idx, ch in enumerate(sorted_chars):
        images = class_images[ch]
        rng.shuffle(images)
        n = len(images)
        n_train = max(1, math.floor(n * 0.85))
        n_val = max(1, math.floor(n * 0.10))
        n_test = max(1, n - n_train - n_val)

        splits = [("train", 0, n_train), ("val", n_train, n_train + n_val),
                  ("test", n_train + n_val, n)]

        for split_name, start, end in splits:
            split_dir = output_dir / split_name / str(class_idx)
            split_dir.mkdir(parents=True, exist_ok=True)
            for j, img in enumerate(images[start:end]):
                img.save(split_dir / f"{j:04d}.png")
            split_counts[split_name] += (end - start)

    # Write metadata
    meta = {
        "num_classes": len(sorted_chars),
        "chars_count": len(chars),
        "classes_with_images": len(class_images),
        "augment_count": augment_count,
        "sizes": sizes,
        "fonts_used": len(fonts),
        "split_counts": split_counts,
        "total_images": sum(split_counts.values()),
    }
    meta_path = output_dir / "meta.json"
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")

    # Cleanup fonts
    for f in fonts:
        f.close()

    logger.info("Dataset generated: %s", meta)
    return meta


def main():
    parser = argparse.ArgumentParser(description="Generate CNN training data")
    parser.add_argument("--fonts-dir", default=str(REPO_ROOT / "data" / "reference" / "fonts"))
    parser.add_argument("--chars-file", default=str(REPO_ROOT / "data" / "reference" / "target_chars.txt"))
    parser.add_argument("--output-dir", default=str(REPO_ROOT / "data" / "training"))
    parser.add_argument("--sizes", nargs="+", type=int, default=[64])
    parser.add_argument("--augment-count", type=int, default=3)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--max-chars", type=int, default=None)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    generate_dataset(
        fonts_dir=Path(args.fonts_dir),
        chars_file=Path(args.chars_file),
        output_dir=Path(args.output_dir),
        sizes=args.sizes,
        augment_count=args.augment_count,
        dry_run=args.dry_run,
        max_chars=args.max_chars,
    )


if __name__ == "__main__":
    main()
