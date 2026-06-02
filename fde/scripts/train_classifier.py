#!/usr/bin/env python3
"""Train ViT-Tiny on generated glyph images for Chinese character recognition.

Usage:
    python scripts/train_classifier.py --data-dir data/training --output models/vit_tiny_gb2312.pt
    python scripts/train_classifier.py --dry-run  # quick pipeline validation
"""

import argparse
import json
import logging
import math
import os
import sys
import time
from pathlib import Path
import signal

import random as _random

import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from torchvision import datasets, transforms
from torchvision.transforms import functional as _F

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.glyph_classifier import ViTTiny

logger = logging.getLogger(__name__)

_interrupted = False


def _signal_handler(signum, frame):
    global _interrupted
    if _interrupted:
        logger.warning("Forced exit. Checkpoint may be incomplete.")
        sys.exit(1)
    _interrupted = True
    logger.warning(
        "Interrupted! Will save checkpoint after current epoch. "
        "Press Ctrl+C again to force exit."
    )


def _save_checkpoint(
    path: Path,
    model: nn.Module,
    optimizer: torch.optim.Optimizer,
    scheduler: "_WarmupCosineLR",
    epoch: int,
    best_val_acc: float,
    best_epoch: int,
    no_improve: int,
    history: dict,
    model_config: dict,
) -> None:
    checkpoint = {
        "state_dict": model.state_dict(),
        "optimizer": optimizer.state_dict(),
        "scheduler_step": scheduler.current_step,
        "epoch": epoch,
        "best_val_acc": best_val_acc,
        "best_epoch": best_epoch,
        "no_improve": no_improve,
        "history": history,
        "model_config": model_config,
        "rng_states": {
            "python": _random.getstate(),
            "torch": torch.get_rng_state(),
            "cuda": torch.cuda.get_rng_state() if torch.cuda.is_available() else None,
        },
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(checkpoint, str(path))
    logger.info("Checkpoint saved to %s (epoch %d)", path, epoch)


REPO_ROOT = Path(__file__).resolve().parent.parent


def _detect_device() -> torch.device:
    if torch.cuda.is_available():
        return torch.device("cuda")
    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class _RandAugment:
    """Lightweight RandAugment for grayscale images (no timm dependency).

    Applies N random augmentations from a fixed set, each at magnitude M.
    """

    _OPS = [
        "identity", "rotate", "translate_x", "translate_y",
        "shear_x", "shear_y", "brightness", "sharpness",
    ]

    def __init__(self, n: int = 2, m: int = 9):
        self.n = n
        self.m = m

    def __call__(self, img: torch.Tensor) -> torch.Tensor:
        ops = _random.sample(self._OPS, self.n)
        for op in ops:
            img = self._apply(img, op)
        return img

    def _apply(self, img: torch.Tensor, op: str) -> torch.Tensor:
        mag = self.m / 10.0

        if op == "identity":
            return img
        elif op == "rotate":
            return _F.rotate(img, _random.uniform(-30 * mag, 30 * mag))
        elif op == "translate_x":
            return _F.affine(img, 0, [_random.uniform(-0.2 * mag, 0.2 * mag), 0], 1, 0)
        elif op == "translate_y":
            return _F.affine(img, 0, [0, _random.uniform(-0.2 * mag, 0.2 * mag)], 1, 0)
        elif op == "shear_x":
            return _F.affine(img, 0, [0, 0], 1, _random.uniform(-0.3 * mag, 0.3 * mag))
        elif op == "shear_y":
            return _F.affine(img, 0, [0, 0], 1, [0, _random.uniform(-0.3 * mag, 0.3 * mag)])
        elif op == "brightness":
            return _F.adjust_brightness(img, 1.0 + _random.uniform(-0.3 * mag, 0.3 * mag))
        elif op == "sharpness":
            return _F.adjust_sharpness(img, 1.0 + _random.uniform(-0.3 * mag, 0.3 * mag))
        return img


def create_dataloaders(
    data_dir: Path,
    batch_size: int = 256,
    num_workers: int = 0,
    augment: bool = True,
) -> tuple[DataLoader, DataLoader, DataLoader, int]:
    """Create train/val/test DataLoaders from ImageFolder structure."""

    val_transform = transforms.Compose([
        transforms.Grayscale(num_output_channels=1),
        transforms.ToTensor(),
    ])

    if augment:
        train_transform = transforms.Compose([
            transforms.Grayscale(num_output_channels=1),
            transforms.RandomRotation(5, fill=0),
            _RandAugment(n=2, m=9),
            transforms.ToTensor(),
        ])
    else:
        train_transform = val_transform

    train_dir = data_dir / "train"
    val_dir = data_dir / "val"
    test_dir = data_dir / "test"

    if not train_dir.exists():
        raise FileNotFoundError(f"Training data not found at {train_dir}")

    train_dataset = datasets.ImageFolder(str(train_dir), transform=train_transform)
    val_dataset = datasets.ImageFolder(str(val_dir), transform=val_transform) if val_dir.exists() else None
    test_dataset = datasets.ImageFolder(str(test_dir), transform=val_transform) if test_dir.exists() else None

    num_classes = len(train_dataset.classes)

    train_loader = DataLoader(
        train_dataset, batch_size=batch_size, shuffle=True,
        num_workers=num_workers, pin_memory=True,
    )
    val_loader = DataLoader(
        val_dataset, batch_size=batch_size, shuffle=False,
        num_workers=num_workers, pin_memory=True,
    ) if val_dataset else None
    test_loader = DataLoader(
        test_dataset, batch_size=batch_size, shuffle=False,
        num_workers=num_workers, pin_memory=True,
    ) if test_dataset else None

    return train_loader, val_loader, test_loader, num_classes


class _WarmupCosineLR(torch.optim.lr_scheduler.LRScheduler):
    """Linear warmup followed by cosine decay."""

    def __init__(self, optimizer, warmup_epochs: int, total_epochs: int,
                 steps_per_epoch: int, last_epoch: int = -1):
        self.warmup_steps = warmup_epochs * steps_per_epoch
        self.total_steps = total_epochs * steps_per_epoch
        self.steps_per_epoch = steps_per_epoch
        self.current_step = 0
        super().__init__(optimizer, last_epoch)

    def get_lr(self):
        if self.current_step < self.warmup_steps:
            alpha = self.current_step / max(1, self.warmup_steps)
        else:
            progress = (self.current_step - self.warmup_steps) / max(
                1, self.total_steps - self.warmup_steps)
            alpha = 0.5 * (1.0 + math.cos(math.pi * progress))
        return [base_lr * alpha for base_lr in self.base_lrs]

    def step(self, epoch=None):
        self.current_step += 1
        super().step(epoch)


def _train_epoch(
    model: nn.Module,
    loader: DataLoader,
    criterion: nn.Module,
    optimizer: torch.optim.Optimizer,
    scheduler: _WarmupCosineLR,
    device: torch.device,
    scaler=None,
) -> tuple[float, float]:
    model.train()
    running_loss = 0.0
    correct = 0
    total = 0

    for images, labels in loader:
        images, labels = images.to(device), labels.to(device)

        optimizer.zero_grad()

        if scaler is not None:
            with torch.cuda.amp.autocast():
                outputs = model(images)
                loss = criterion(outputs, labels)
            scaler.scale(loss).backward()
            scaler.step(optimizer)
            scaler.update()
        else:
            outputs = model(images)
            loss = criterion(outputs, labels)
            loss.backward()
            optimizer.step()

        running_loss += loss.item() * images.size(0)
        _, preds = torch.max(outputs, 1)
        correct += (preds == labels).sum().item()
        total += labels.size(0)
        scheduler.step()

    return running_loss / total, correct / total


@torch.no_grad()
def _evaluate(model: nn.Module, loader: DataLoader, criterion: nn.Module,
              device: torch.device) -> tuple[float, float]:
    model.eval()
    running_loss = 0.0
    correct = 0
    total = 0

    for images, labels in loader:
        images, labels = images.to(device), labels.to(device)
        outputs = model(images)
        loss = criterion(outputs, labels)
        running_loss += loss.item() * images.size(0)
        _, preds = torch.max(outputs, 1)
        correct += (preds == labels).sum().item()
        total += labels.size(0)

    return running_loss / total, correct / total


def train(
    data_dir: Path,
    output_path: Path,
    num_classes: int | None = None,
    epochs: int = 100,
    batch_size: int = 256,
    lr: float = 3e-4,
    weight_decay: float = 0.05,
    label_smoothing: float = 0.1,
    warmup_epochs: int = 5,
    patience: int = 10,
    num_workers: int = 0,
    device: torch.device | None = None,
    dry_run: bool = False,
    resume: str | None = None,
    checkpoint_path: str | None = None,
) -> dict:
    """Train ViT-Tiny classifier. Returns training metrics dict."""

    global _interrupted
    _interrupted = False

    device = device or _detect_device()
    logger.info("Using device: %s", device)

    signal.signal(signal.SIGINT, _signal_handler)

    if dry_run:
        epochs = 2
        batch_size = 32
        logger.info("DRY RUN: 2 epochs, batch_size=32")

    train_loader, val_loader, test_loader, detected_classes = create_dataloaders(
        data_dir, batch_size, num_workers, augment=not dry_run,
    )
    num_classes = num_classes or detected_classes
    logger.info("Training on %d classes", num_classes)

    checkpoint_path = Path(checkpoint_path) if checkpoint_path else (output_path.parent / "checkpoint.pt")

    start_epoch = 1
    if resume:
        resume_path = Path(resume)
        if not resume_path.exists():
            raise FileNotFoundError(f"Checkpoint not found: {resume_path}")
        ckpt = torch.load(str(resume_path), map_location=device, weights_only=True)
        model_config = ckpt["model_config"]
        if model_config["num_classes"] != num_classes:
            raise ValueError(
                f"Checkpoint num_classes ({model_config['num_classes']}) "
                f"does not match dataset ({num_classes})"
            )
        logger.info("Resuming from %s (epoch %d, best_val_acc=%.4f)",
                     resume_path, ckpt["epoch"], ckpt["best_val_acc"])
    else:
        ckpt = None

    if ckpt:
        model = ViTTiny(**model_config).to(device)
        model.load_state_dict(ckpt["state_dict"])
    elif dry_run:
        model_config = dict(
            num_classes=num_classes, img_size=64, patch_size=4,
            dim=96, depth=4, heads=3, mlp_ratio=4.0, dropout=0.0,
        )
        model = ViTTiny(**model_config)
        logger.info("Dry-run model: dim=96 depth=4 (~0.5M params)")
    else:
        model_config = dict(num_classes=num_classes)
        model = ViTTiny(**model_config)
    model = model.to(device)

    param_count = sum(p.numel() for p in model.parameters() if p.requires_grad)
    logger.info("Trainable params: %d", param_count)

    criterion = nn.CrossEntropyLoss(label_smoothing=label_smoothing)
    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=weight_decay)
    scheduler = _WarmupCosineLR(
        optimizer, warmup_epochs, epochs, len(train_loader))

    use_amp = device.type == "cuda"
    scaler = torch.amp.GradScaler("cuda") if use_amp else None

    if ckpt:
        optimizer.load_state_dict(ckpt["optimizer"])
        scheduler.current_step = ckpt["scheduler_step"]
        start_epoch = ckpt["epoch"] + 1
        best_val_acc = ckpt["best_val_acc"]
        best_epoch = ckpt["best_epoch"]
        no_improve = ckpt["no_improve"]
        history = ckpt["history"]
        rng = ckpt.get("rng_states", {})
        if rng.get("python"):
            _random.setstate(rng["python"])
        if rng.get("torch"):
            torch.set_rng_state(rng["torch"])
        if rng.get("cuda") and torch.cuda.is_available():
            torch.cuda.set_rng_state(rng["cuda"])
        logger.info("Resumed from epoch %d", start_epoch - 1)
    else:
        best_val_acc = 0.0
        best_epoch = 0
        no_improve = 0
        history = {"train_loss": [], "train_acc": [], "val_loss": [], "val_acc": []}

    for epoch in range(start_epoch, epochs + 1):
        start = time.time()
        train_loss, train_acc = _train_epoch(
            model, train_loader, criterion, optimizer, scheduler, device, scaler)
        history["train_loss"].append(train_loss)
        history["train_acc"].append(train_acc)

        val_loss = float("inf")
        val_acc = 0.0
        if val_loader:
            val_loss, val_acc = _evaluate(model, val_loader, criterion, device)
            history["val_loss"].append(val_loss)
            history["val_acc"].append(val_acc)

        elapsed = time.time() - start
        logger.info(
            "Epoch %d/%d (%.1fs) | train loss=%.4f acc=%.4f | val loss=%.4f acc=%.4f",
            epoch, epochs, elapsed, train_loss, train_acc, val_loss, val_acc,
        )

        # Early stopping
        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_epoch = epoch
            no_improve = 0
            output_path.parent.mkdir(parents=True, exist_ok=True)
            torch.save({
                "state_dict": model.state_dict(),
                "config": model_config,
            }, str(output_path))
            logger.info("  -> saved best model (val_acc=%.4f)", val_acc)
        else:
            no_improve += 1
            if no_improve >= patience:
                logger.info("Early stopping at epoch %d (no improvement for %d epochs)",
                            epoch, patience)
                break

        # Check for interrupt
        if _interrupted:
            _save_checkpoint(
                checkpoint_path, model, optimizer, scheduler,
                epoch, best_val_acc, best_epoch, no_improve,
                history, model_config,
            )
            logger.info("Training paused. Resume with: --resume")
            sys.exit(0)

    # Load best model for final evaluation
    checkpoint = torch.load(str(output_path), map_location=device, weights_only=True)
    model.load_state_dict(checkpoint["state_dict"])

    test_loss = None
    test_acc = None
    if test_loader:
        test_loss, test_acc = _evaluate(model, test_loader, criterion, device)
        logger.info("Test: loss=%.4f acc=%.4f", test_loss, test_acc)

    metrics = {
        "num_classes": num_classes,
        "param_count": param_count,
        "epochs_trained": epoch,
        "best_epoch": best_epoch,
        "best_val_acc": best_val_acc,
        "test_loss": test_loss,
        "test_acc": test_acc,
        "train_acc_final": history["train_acc"][-1],
        "history": history,
    }

    metrics_path = output_path.with_suffix(".json")
    metrics_path.write_text(json.dumps(metrics, indent=2, default=float), encoding="utf-8")

    logger.info("Training complete. Model saved to %s", output_path)
    logger.info("Metrics saved to %s", metrics_path)
    return metrics


def main():
    parser = argparse.ArgumentParser(description="Train ViT-Tiny glyph classifier")
    parser.add_argument("--data-dir", default=str(REPO_ROOT / "data" / "training"))
    parser.add_argument("--output", default=str(REPO_ROOT / "models" / "vit_tiny_gb2312.pt"))
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--weight-decay", type=float, default=0.05)
    parser.add_argument("--label-smoothing", type=float, default=0.1)
    parser.add_argument("--patience", type=int, default=10)
    parser.add_argument("--num-workers", type=int, default=0)
    parser.add_argument("--device", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s: %(message)s")

    device = torch.device(args.device) if args.device else _detect_device()

    train(
        data_dir=Path(args.data_dir),
        output_path=Path(args.output),
        epochs=args.epochs,
        batch_size=args.batch_size,
        lr=args.lr,
        weight_decay=args.weight_decay,
        label_smoothing=args.label_smoothing,
        patience=args.patience,
        num_workers=args.num_workers,
        device=device,
        dry_run=args.dry_run,
    )


if __name__ == "__main__":
    main()
