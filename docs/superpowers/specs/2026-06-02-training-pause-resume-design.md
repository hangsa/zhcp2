# Training Pause/Resume via Ctrl+C Checkpoint

## Summary

Add graceful interrupt (SIGINT) handling to save full training state as a checkpoint, and `--resume` flag to continue training from checkpoint.

## Files

- `fde/scripts/train_classifier.py` — checkpoint save/load, SIGINT handler, `--resume` arg
- `fde/scripts/train_all.ps1` — `-Resume` switch

## Checkpoint Format

Saved to `models/checkpoint.pt`:
```
state_dict, optimizer (AdamW state), scheduler_step (WarmupCosineLR current_step),
epoch, best_val_acc, best_epoch, no_improve, history, model_config,
rng_states (python random, torch, cuda if available)
```

## Flow

**Interrupt**: SIGINT → set flag → finish current epoch → save checkpoint → exit 0

**Resume**: `--resume` → load checkpoint → rebuild model/optimizer/scheduler from saved config → restore epoch/best/history → continue from epoch+1

## New CLI Args

`train_classifier.py`:
- `--resume [PATH]` — resume from checkpoint (default: `models/checkpoint.pt`)

`train_all.ps1`:
- `-Resume` — pass through `--resume`

## Edge Cases

- Resume with missing checkpoint file → error
- Resume with mismatched num_classes → error  
- Ctrl+C during checkpoint write → OS-level, user can re-interrupt
