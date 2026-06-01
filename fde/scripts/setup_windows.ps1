# FDE Windows Environment Setup
# ================================
# Run: powershell -ExecutionPolicy Bypass -File scripts/setup_windows.ps1
#
# This script will:
#   1. Check Python 3.11+ is installed
#   2. Create a virtual environment at .venv\
#   3. Install CUDA-enabled PyTorch (for RTX 3060)
#   4. Install remaining Python dependencies
#   5. Verify GPU is accessible from PyTorch

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir
$VenvDir = Join-Path $ProjectDir ".venv"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  FDE Windows Training Setup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ---- Step 1: Check Python ----
Write-Host "[1/5] Checking Python installation..." -ForegroundColor Yellow

$python = $null
try {
    $pyVersion = python --version 2>&1
    Write-Host "  Found: $pyVersion"
    $python = "python"
} catch {
    try {
        $pyVersion = python3 --version 2>&1
        Write-Host "  Found: $pyVersion"
        $python = "python3"
    } catch {
        Write-Host "ERROR: Python 3.11+ is required. Install from https://www.python.org/downloads/" -ForegroundColor Red
        Write-Host "  IMPORTANT: Check 'Add Python to PATH' during installation." -ForegroundColor Red
        exit 1
    }
}

# Verify Python >= 3.11
$verOutput = & $python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
$verParts = $verOutput.Split('.')
if ([int]$verParts[0] -lt 3 -or ([int]$verParts[0] -eq 3 -and [int]$verParts[1] -lt 11)) {
    Write-Host "ERROR: Python 3.11+ required. Found: $verOutput" -ForegroundColor Red
    exit 1
}
Write-Host "  Python $verOutput OK" -ForegroundColor Green

# ---- Step 2: Create virtual environment ----
Write-Host ""
Write-Host "[2/5] Creating virtual environment at .venv\" -ForegroundColor Yellow

if (Test-Path $VenvDir) {
    Write-Host "  Virtual environment already exists. Removing..." -ForegroundColor DarkYellow
    Remove-Item -Recurse -Force $VenvDir
}

& $python -m venv $VenvDir
Write-Host "  Virtual environment created." -ForegroundColor Green

# Activate
$VenvActivate = Join-Path $VenvDir "Scripts\Activate.ps1"
. $VenvActivate
Write-Host "  Virtual environment activated." -ForegroundColor Green

# ---- Step 3: Upgrade pip ----
Write-Host ""
Write-Host "[3/5] Upgrading pip..." -ForegroundColor Yellow
python -m pip install --upgrade pip
Write-Host "  pip upgraded." -ForegroundColor Green

# ---- Step 4: Install PyTorch with CUDA ----
Write-Host ""
Write-Host "[4/5] Installing PyTorch with CUDA 12.4 support..." -ForegroundColor Yellow
Write-Host "  This may take several minutes (download ~2.5 GB)..." -ForegroundColor DarkYellow

# Detect CUDA version from nvidia-smi if available, otherwise default to cu124
$cudaIndex = "https://download.pytorch.org/whl/cu124"
try {
    $nvidiaSmi = nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>&1
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  NVIDIA Driver: $nvidiaSmi" -ForegroundColor Green
    }
} catch {
    Write-Host "  WARNING: nvidia-smi not found. Is NVIDIA driver installed?" -ForegroundColor Red
    Write-Host "  Will still attempt to install CUDA PyTorch..." -ForegroundColor DarkYellow
}

python -m pip install torch torchvision --index-url $cudaIndex
Write-Host "  PyTorch installed." -ForegroundColor Green

# ---- Step 5: Install remaining dependencies ----
Write-Host ""
Write-Host "[5/5] Installing remaining dependencies..." -ForegroundColor Yellow
python -m pip install -r (Join-Path $ProjectDir "requirements-windows.txt")
Write-Host "  Dependencies installed." -ForegroundColor Green

# ---- Verify GPU ----
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Verification" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$gpuCheck = python -c @"
import torch
print(f'  PyTorch:  {torch.__version__}')
print(f'  CUDA available: {torch.cuda.is_available()}')
if torch.cuda.is_available():
    print(f'  CUDA version:   {torch.version.cuda}')
    print(f'  GPU:            {torch.cuda.get_device_name(0)}')
    print(f'  GPU memory:     {torch.cuda.get_device_properties(0).total_memory / 1024**3:.1f} GB')
    print(f'  GPU count:      {torch.cuda.device_count()}')
else:
    print('  >>> GPU NOT DETECTED. Training will be extremely slow on CPU! <<<')
"@
Write-Host $gpuCheck

Write-Host ""
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Place reference fonts in data\reference\fonts\" -ForegroundColor White
Write-Host "     (download: powershell -ExecutionPolicy Bypass -File scripts\download_fonts.ps1)" -ForegroundColor White
Write-Host "  2. Run training:  powershell -ExecutionPolicy Bypass -File scripts\train_all.ps1" -ForegroundColor White
Write-Host ""
