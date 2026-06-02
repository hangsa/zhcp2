# Training Pause/Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add graceful Ctrl+C interrupt handling to save full training checkpoint, and `--resume` flag to continue training from checkpoint.

**Architecture:** SIGINT handler sets a global flag checked after each epoch. On interrupt, saves model/optimizer/scheduler state + RNG states + progress metrics to `models/checkpoint.pt`. `--resume` rebuilds model from saved config, restores all state, continues training loop from next epoch.

**Tech Stack:** Python signal module, PyTorch checkpoint save/load, PowerShell switch parameter

---

### Task 1: Add signal handler and checkpoint helpers

**Files:**
- Modify: `fde/scripts/train_classifier.py:9-17` (add imports)
- Modify: `fde/scripts/train_classifier.py:28-32` (add globals + handler after logger)

- [ ] **Step 1: Add `signal` import and checkpoint helpers**

Add after line 17 (`from pathlib import Path`):

```python
import signal
```

Add after line 30 (`logger = logging.getLogger(__name__)`):

```python
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
```

- [ ] **Step 2: Add `_save_checkpoint` function**

Add after the signal handler:

```python
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
):
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
```

- [ ] **Step 3: Commit**

```bash
git add fde/scripts/train_classifier.py
git commit -m "feat: add checkpoint save helper and SIGINT handler for training"
```

---

### Task 2: Integrate interrupt + resume into train() function

**Files:**
- Modify: `fde/scripts/train_classifier.py:224-349` (train function signature + body)

- [ ] **Step 1: Register signal handler at top of `train()`**

At line ~242 (after `logger.info("Using device: %s", device)`), add:

```python
    signal.signal(signal.SIGINT, _signal_handler)
```

- [ ] **Step 2: Add `resume` and `checkpoint_path` parameters to `train()` signature**

Change lines 224-238 (the function signature):

```python
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
```

- [ ] **Step 3: Add resume logic after dataloader creation but before model init**

After the dataloader creation block (line ~253, after `num_classes = num_classes or detected_classes`), insert:

```python
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
        # Dataloaders already created; verify matches
        logger.info("Resuming from %s (epoch %d, best_val_acc=%.4f)",
                     resume_path, ckpt["epoch"], ckpt["best_val_acc"])
    else:
        ckpt = None
```

- [ ] **Step 4: Modify model creation to support resume**

Replace lines 255-266 (the dry_run / model creation block):

```python
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
```

- [ ] **Step 5: Modify optimizer/scheduler/metrics init to support resume**

Replace lines 268-282 (criterion through history init):

```python
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
```

- [ ] **Step 6: Change training loop to start from `start_epoch` and check interrupt**

Replace line 284 (`for epoch in range(1, epochs + 1):`):

```python
    for epoch in range(start_epoch, epochs + 1):
```

Add after the epoch's early-stopping / best-model logic (after the `logger.info(" -> saved best model...")` block, around line 320, right before the early-stopping `break`), add the interrupt check:

The interrupt check goes right after the early-stopping block (after `break`), at the same indentation level as `if val_acc > best_val_acc:`:

```python
        # Check for interrupt
        if _interrupted:
            _save_checkpoint(
                checkpoint_path, model, optimizer, scheduler,
                epoch, best_val_acc, best_epoch, no_improve,
                history, model_config,
            )
            logger.info("Training paused. Resume with: --resume")
            sys.exit(0)
```

This should be inserted after the closing of the early-stopping `if val_acc > best_val_acc: ... else: no_improve += 1 ... if no_improve >= patience: break` block, but still inside the `for epoch` loop.

- [ ] **Step 7: Commit**

```bash
git add fde/scripts/train_classifier.py
git commit -m "feat: add resume support and interrupt handling to train()"
```

---

### Task 3: Add CLI arguments and wire into main()

**Files:**
- Modify: `fde/scripts/train_classifier.py:352-365` (argparse)
- Modify: `fde/scripts/train_classifier.py:367-383` (main body)

- [ ] **Step 1: Add `--resume` and `--checkpoint-path` to argparse**

Add after line 364 (`parser.add_argument("--dry-run", ...)`):

```python
    parser.add_argument("--resume", nargs="?", const="auto", default=None,
                        help="Resume from checkpoint (default: models/checkpoint.pt)")
    parser.add_argument("--checkpoint-path", default=str(REPO_ROOT / "models" / "checkpoint.pt"),
                        help="Where to save checkpoint on interrupt")
```

- [ ] **Step 2: Wire `resume` into `train()` call**

In the `train()` call (lines 371-383), add `resume` and `checkpoint_path`:

Change:
```python
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
```

To:
```python
    resume_path = None
    if args.resume is not None:
        resume_path = args.resume if args.resume != "auto" else str(REPO_ROOT / "models" / "checkpoint.pt")
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
        resume=resume_path,
        checkpoint_path=args.checkpoint_path,
    )
```

- [ ] **Step 3: Commit**

```bash
git add fde/scripts/train_classifier.py
git commit -m "feat: add --resume and --checkpoint-path CLI args"
```

---

### Task 4: Add -Resume switch to PowerShell pipeline

**Files:**
- Modify: `fde/scripts/train_all.ps1:15-20` (param block)
- Modify: `fde/scripts/train_all.ps1:210-227` (train args construction)

- [ ] **Step 1: Add `-Resume` parameter**

After line 24 (`[string]$Device = ""`), add:

```powershell
    [switch]$Resume
```

- [ ] **Step 2: Pass `--resume` to training script**

After line 221 (`if ($DryRun) { ... }`), add:

```powershell
    if ($Resume) {
        $trainArgs += "--resume"
        Write-Host "RESUME MODE: Continuing from checkpoint" -ForegroundColor Magenta
    }
```

- [ ] **Step 3: Commit**

```bash
git add fde/scripts/train_all.ps1
git commit -m "feat: add -Resume switch to train_all.ps1"
```

---

### Task 5: Verify with dry run

**Files:**
- None (verification only)

- [ ] **Step 1: Test new training with dry run**

```bash
cd fde && python scripts/train_classifier.py --dry-run --epochs 5
```

Expected: Completes 5 epochs without error, no checkpoint saved.

- [ ] **Step 2: Test interrupt saves checkpoint**

```bash
cd fde && python scripts/train_classifier.py --dry-run --epochs 10 &
sleep 5 && kill -INT %1 && wait
```

Expected: Prints "Interrupted!", saves `models/checkpoint.pt`, exits cleanly.

Check: `ls -la fde/models/checkpoint.pt`

- [ ] **Step 3: Test resume from checkpoint**

```bash
cd fde && python scripts/train_classifier.py --dry-run --epochs 10 --resume
```

Expected: Prints "Resuming from ... (epoch N, ...)", continues from saved epoch.

- [ ] **Step 4: Verify checkpoint contains all required keys**

```bash
cd fde && python -c "
import torch
ckpt = torch.load('models/checkpoint.pt', weights_only=True)
print('Keys:', list(ckpt.keys()))
print('Epoch:', ckpt['epoch'])
print('Config:', ckpt['model_config'])
print('Has optimizer:', 'optimizer' in ckpt)
print('Has rng_states:', 'rng_states' in ckpt)
"
```

- [ ] **Step 5: Commit any fixes if needed, push all**

```bash
git push
```
