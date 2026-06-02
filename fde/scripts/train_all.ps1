# FDE One-Click Training Pipeline
# ==================================
# Generates training dataset from reference fonts, then trains ViT-Tiny classifier.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1 -SkipDataGen
#
# Prerequisites:
#   - Run setup_windows.ps1 first to create .venv and install deps
#   - Place reference fonts in data\reference\fonts\
#   - Ensure data\reference\target_chars.txt exists

param(
    [switch]$DryRun,
    [switch]$SkipDataGen,
    [switch]$CleanStart,
    [ValidateRange(1,8192)]
    [int]$BatchSize = 256,
    [ValidateRange(1,500)]
    [int]$Epochs = 100,
    [int]$NumWorkers = 2,
    [string]$Device = "",
    [switch]$Resume
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir

# All paths are relative to project root
Set-Location $ProjectDir

# Paths
$VenvDir = Join-Path $ProjectDir ".venv"
$VenvActivate = Join-Path $VenvDir "Scripts\Activate.ps1"
$FontsDir = Join-Path $ProjectDir "data\reference\fonts"
$CharsFile = Join-Path $ProjectDir "data\reference\target_chars.txt"
$DataDir = Join-Path $ProjectDir "data\training"
$ModelOutput = Join-Path $ProjectDir "models\vit_tiny_gb2312.pt"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  FDE Training Pipeline" -ForegroundColor Cyan
Write-Host "  ViT-Tiny CNN Glyph Classifier" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ---- Check venv ----
if (-not (Test-Path $VenvActivate)) {
    Write-Host "ERROR: Virtual environment not found at .venv\" -ForegroundColor Red
    Write-Host "Run setup first:" -ForegroundColor Red
    Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\setup_windows.ps1" -ForegroundColor Yellow
    exit 1
}

Write-Host "Activating virtual environment..." -ForegroundColor Yellow
. $VenvActivate

# GPU detection
Write-Host "Checking GPU availability..." -ForegroundColor Yellow
$gpuResult = python -c @"
import torch
print('CUDA_AVAILABLE=' + str(torch.cuda.is_available()))
if torch.cuda.is_available():
    print('GPU=' + torch.cuda.get_device_name(0))
    print('MEM_GB=' + str(round(torch.cuda.get_device_properties(0).total_memory / 1024**3, 1)))
    print('DEVICE=cuda')
else:
    print('DEVICE=cpu')
"@
Write-Host "  $gpuResult"

$gpuStr = $gpuResult -join "`n"
if ($gpuStr -match "CUDA_AVAILABLE=True") {
    Write-Host "  GPU detected! Training will use GPU acceleration." -ForegroundColor Green
    if (-not $Device) { $Device = "cuda" }
    if ($gpuStr -match "MEM_GB=([\d.]+)") {
        $gpuMem = [double]$Matches[1]
        if ($gpuMem -lt 6 -and $BatchSize -gt 128) {
            Write-Host "  WARNING: < 6 GB VRAM, reducing batch_size from $BatchSize to 128" -ForegroundColor Yellow
            $BatchSize = 128
        }
    }
} else {
    Write-Host "  WARNING: No GPU detected! Training will be VERY slow on CPU." -ForegroundColor Red
    Write-Host "  For RTX 3060: ensure NVIDIA driver is installed and CUDA PyTorch was installed." -ForegroundColor Red
    Write-Host "  Continuing anyway..." -ForegroundColor DarkYellow
    if (-not $Device) { $Device = "cpu" }
}

# ---- Check prerequisites ----
Write-Host ""
Write-Host "Checking prerequisites..." -ForegroundColor Yellow

if (-not (Test-Path $FontsDir)) {
    Write-Host "ERROR: Fonts directory not found: $FontsDir" -ForegroundColor Red
    Write-Host "Run: powershell -ExecutionPolicy Bypass -File scripts\download_fonts.ps1" -ForegroundColor Yellow
    exit 1
}

$fontFiles = @(Get-ChildItem -Path $FontsDir -Include "*.otf","*.ttf","*.ttc" -Recurse)
if ($fontFiles.Count -eq 0) {
    Write-Host "ERROR: No font files found in $FontsDir" -ForegroundColor Red
    Write-Host "Run: powershell -ExecutionPolicy Bypass -File scripts\download_fonts.ps1" -ForegroundColor Yellow
    exit 1
}
Write-Host "  Fonts found: $($fontFiles.Count) file(s)" -ForegroundColor Green

if (-not (Test-Path $CharsFile)) {
    Write-Host "ERROR: Character set file not found: $CharsFile" -ForegroundColor Red
    exit 1
}
$charCount = (Get-Content $CharsFile | Where-Object { $_.Trim() -ne "" }).Count
Write-Host "  Target characters: $charCount" -ForegroundColor Green

# ---- Clean start ----
if ($CleanStart) {
    Write-Host ""
    Write-Host "Cleaning previous training data..." -ForegroundColor Yellow
    if (Test-Path $DataDir) {
        Remove-Item -Recurse -Force $DataDir
    }
    if (Test-Path $ModelOutput) {
        Remove-Item -Force $ModelOutput
    }
    if (Test-Path (Join-Path $ProjectDir "models\vit_tiny_gb2312.json")) {
        Remove-Item -Force (Join-Path $ProjectDir "models\vit_tiny_gb2312.json")
    }
    Write-Host "  Cleaned." -ForegroundColor Green
}

# ============================================
# STEP 1: Generate Training Dataset
# ============================================
if (-not $SkipDataGen) {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  STEP 1/2: Generate Training Dataset" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""

    $genArgs = @(
        "scripts\generate_training_data.py",
        "--fonts-dir", $FontsDir,
        "--chars-file", $CharsFile,
        "--output-dir", $DataDir,
        "--sizes", "64",
        "--augment-count", "3"
    )

    if ($DryRun) {
        $genArgs += "--dry-run"
        $genArgs += "--max-chars", "100"
        Write-Host "DRY RUN MODE: 100 characters only" -ForegroundColor Magenta
    }

    Write-Host "Running: python $($genArgs -join ' ')" -ForegroundColor DarkYellow
    Write-Host ""
    Write-Host "This will render glyphs across all fonts and generate augmented images." -ForegroundColor White
    Write-Host "Expected time: ~1-2 hours for full 6763-character set (CPU-bound)" -ForegroundColor White
    Write-Host ""

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $genExit = 0
    python $genArgs
    $genExit = $LASTEXITCODE
    $sw.Stop()

    if ($genExit -ne 0) {
        Write-Host "ERROR: Data generation failed with exit code $genExit" -ForegroundColor Red
        exit $genExit
    }

    Write-Host ""
    Write-Host "Data generation complete in $([math]::Round($sw.Elapsed.TotalMinutes, 1)) minutes." -ForegroundColor Green

    # Print dataset summary
    $metaPath = Join-Path $DataDir "meta.json"
    if (Test-Path $metaPath) {
        $meta = Get-Content $metaPath -Raw | ConvertFrom-Json
        Write-Host ""
        Write-Host "Dataset summary:" -ForegroundColor White
        Write-Host "  Classes:  $($meta.num_classes)" -ForegroundColor White
        Write-Host "  Fonts:    $($meta.fonts_used)" -ForegroundColor White
        Write-Host "  Images:   $($meta.total_images) (train=$($meta.split_counts.train), val=$($meta.split_counts.val), test=$($meta.split_counts.test))" -ForegroundColor White
        $reqImages = [int]$meta.num_classes * 100
        if ([int]$meta.total_images -lt $reqImages) {
            Write-Host "  WARNING: Less than 100 images/class. Add more fonts for better results." -ForegroundColor Yellow
        }
    }
} else {
    Write-Host ""
    Write-Host "Skipping data generation (--SkipDataGen)" -ForegroundColor DarkYellow
    if (-not (Test-Path $DataDir)) {
        Write-Host "ERROR: Training data directory not found: $DataDir" -ForegroundColor Red
        Write-Host "Run without --SkipDataGen first to generate training data." -ForegroundColor Red
        exit 1
    }
}

# ============================================
# STEP 2: Train ViT-Tiny Model
# ============================================
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  STEP 2/2: Train ViT-Tiny Classifier" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$trainArgs = @(
    "scripts\train_classifier.py",
    "--data-dir", $DataDir,
    "--output", $ModelOutput,
    "--epochs", $Epochs,
    "--batch-size", $BatchSize,
    "--num-workers", $NumWorkers
)

if ($Device) {
    $trainArgs += "--device", $Device
}

if ($DryRun) {
    $trainArgs += "--dry-run"
    Write-Host "DRY RUN MODE: 2 epochs, small model" -ForegroundColor Magenta
}

if ($Resume) {
    $trainArgs += "--resume"
    Write-Host "RESUME MODE: Continuing from checkpoint" -ForegroundColor Magenta
}

Write-Host "Running: python $($trainArgs -join ' ')" -ForegroundColor DarkYellow
Write-Host ""
Write-Host "Configuration:" -ForegroundColor White
Write-Host "  Model:     ViT-Tiny (~5.7M params)" -ForegroundColor White
Write-Host "  Input:     64x64 grayscale" -ForegroundColor White
Write-Host "  Batch:     $BatchSize" -ForegroundColor White
Write-Host "  Epochs:    $Epochs" -ForegroundColor White
Write-Host "  Device:    $Device" -ForegroundColor White
Write-Host "  Optimizer: AdamW (lr=3e-4, weight_decay=0.05)" -ForegroundColor White
Write-Host "  Early stop: patience=10" -ForegroundColor White
Write-Host ""
Write-Host "Expected time: ~2-4 hours on RTX 3060, ~4-6 hours on T4/Colab" -ForegroundColor White
Write-Host ""

$sw2 = [System.Diagnostics.Stopwatch]::StartNew()
$trainExit = 0
python $trainArgs
$trainExit = $LASTEXITCODE
$sw2.Stop()

if ($trainExit -ne 0) {
    Write-Host "ERROR: Training failed with exit code $trainExit" -ForegroundColor Red
    exit $trainExit
}

Write-Host ""
Write-Host "Training complete in $([math]::Round($sw2.Elapsed.TotalMinutes, 1)) minutes." -ForegroundColor Green

# Print training summary
$metricsPath = Join-Path $ProjectDir "models\vit_tiny_gb2312.json"
if (Test-Path $metricsPath) {
    $metrics = Get-Content $metricsPath -Raw | ConvertFrom-Json
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Training Results" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  Classes:        $($metrics.num_classes)" -ForegroundColor White
    Write-Host "  Best epoch:     $($metrics.best_epoch)" -ForegroundColor White
    Write-Host "  Best val acc:   $([math]::Round($metrics.best_val_acc * 100, 2))%" -ForegroundColor White
    if ($metrics.test_acc) {
        Write-Host "  Test acc:       $([math]::Round($metrics.test_acc * 100, 2))%" -ForegroundColor White
    }
    Write-Host ""
    if ([double]$metrics.best_val_acc -lt 0.95) {
        Write-Host "  WARNING: Validation accuracy below 95%." -ForegroundColor Yellow
        Write-Host "  Consider: more reference fonts, more training epochs, or hyperparameter tuning." -ForegroundColor Yellow
    } elseif ([double]$metrics.best_val_acc -gt 0.99) {
        Write-Host "  Excellent! Validation accuracy above 99%!" -ForegroundColor Green
    }
}

# Final summary
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Pipeline Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Output files to transfer back to Mac:" -ForegroundColor White
Write-Host "  1. models\vit_tiny_gb2312.pt   — trained model (~22 MB)" -ForegroundColor White
Write-Host "  2. models\vit_tiny_gb2312.json — training metrics" -ForegroundColor White
Write-Host "  3. data\training\label_map.json — class index to character mapping" -ForegroundColor White
Write-Host ""
Write-Host "Transfer these to the same paths on your Mac, then run tests:" -ForegroundColor White
Write-Host "  cd fde && python -m pytest tests/ -v" -ForegroundColor White
Write-Host ""
