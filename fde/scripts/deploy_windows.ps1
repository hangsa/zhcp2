# FDE Windows Deployment Script
# ================================
# Builds reference database (if needed) and launches Docker containers.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\deploy_windows.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\deploy_windows.ps1 -SkipBuild
#   powershell -ExecutionPolicy Bypass -File scripts\deploy_windows.ps1 -Clean
#
# Prerequisites:
#   - Run setup_windows.ps1 first (creates .venv, installs deps)
#   - Run download_fonts.ps1 (places reference fonts)
#   - Run train_all.ps1 (generates model + training data)
#   - Install Docker Desktop (https://www.docker.com/products/docker-desktop/)

param(
    [switch]$SkipBuild,
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir

# Paths
$VenvDir = Join-Path $ProjectDir ".venv"
$VenvActivate = Join-Path $VenvDir "Scripts\Activate.ps1"
$FontsDir = Join-Path $ProjectDir "data\reference\fonts"
$DbPath = Join-Path $ProjectDir "data\reference\db\glyphs.db"
$FaissPath = Join-Path $ProjectDir "data\reference\db\faiss_index.faiss"
$ModelPath = Join-Path $ProjectDir "models\vit_tiny_gb2312.pt"
$LabelMapPath = Join-Path $ProjectDir "data\training\label_map.json"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  FDE Docker Deployment" -ForegroundColor Cyan
Write-Host "  ViT-Tiny CNN + FAISS KNN + Redis" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# ---- Check Docker ----
Write-Host "[1/4] Checking Docker..." -ForegroundColor Yellow

# Temporarily disable ErrorActionPreference for native-command checks
# to prevent PowerShell from converting docker stderr to terminating errors
$prevEAP = $ErrorActionPreference
$ErrorActionPreference = "Continue"

$dockerVersion = docker --version 2>&1
if ($LASTEXITCODE -ne 0) {
    $ErrorActionPreference = $prevEAP
    Write-Host "ERROR: Docker not found. Install Docker Desktop first:" -ForegroundColor Red
    Write-Host "  https://www.docker.com/products/docker-desktop/" -ForegroundColor Yellow
    exit 1
}
Write-Host "  $dockerVersion" -ForegroundColor Green

# Verify Docker is running
$null = docker info 2>&1
if ($LASTEXITCODE -ne 0) {
    $ErrorActionPreference = $prevEAP
    Write-Host "ERROR: Docker is installed but not running." -ForegroundColor Red
    Write-Host "  Start Docker Desktop, wait for the whale icon to stop animating, then retry." -ForegroundColor Yellow
    exit 1
}
$ErrorActionPreference = $prevEAP
Write-Host "  Docker is running." -ForegroundColor Green

# ---- Check prerequisites ----
Write-Host ""
Write-Host "[2/4] Checking prerequisites..." -ForegroundColor Yellow

$missing = @()

if (-not (Test-Path $VenvActivate)) {
    $missing += ".venv (run: setup_windows.ps1)"
}
if (-not (Test-Path $ModelPath)) {
    $missing += "Trained model (run: train_all.ps1)"
}
if (-not (Test-Path $LabelMapPath)) {
    $missing += "Label map (run: train_all.ps1)"
}
if (-not (Test-Path $FontsDir)) {
    $missing += "Reference fonts (run: download_fonts.ps1)"
} else {
    $fontFiles = @(Get-ChildItem -Path $FontsDir -Include "*.otf","*.ttf","*.ttc" -Recurse)
    if ($fontFiles.Count -eq 0) {
        $missing += "Reference fonts (run: download_fonts.ps1)"
    }
}

if ($missing.Count -gt 0) {
    Write-Host "ERROR: Missing prerequisites:" -ForegroundColor Red
    foreach ($m in $missing) {
        Write-Host "  - $m" -ForegroundColor Red
    }
    exit 1
}
Write-Host "  .venv              OK" -ForegroundColor Green
Write-Host "  Model (27 MB)      OK" -ForegroundColor Green
Write-Host "  Label map          OK" -ForegroundColor Green
Write-Host "  Reference fonts    OK" -ForegroundColor Green

# ---- Build reference database ----
Write-Host ""
Write-Host "[3/4] Building reference database..." -ForegroundColor Yellow

$needBuild = $false
if (-not (Test-Path $DbPath) -or -not (Test-Path $FaissPath)) {
    $needBuild = $true
    Write-Host "  Reference database not found. Building..." -ForegroundColor DarkYellow
} elseif ($Clean) {
    $needBuild = $true
    Write-Host "  Clean mode: rebuilding reference database..." -ForegroundColor DarkYellow
    Remove-Item -Force $DbPath -ErrorAction SilentlyContinue
    Remove-Item -Force $FaissPath -ErrorAction SilentlyContinue
} else {
    Write-Host "  Reference database already exists. Use -Clean to rebuild." -ForegroundColor Green
}

if ($needBuild) {
    Write-Host "  Activating .venv..." -ForegroundColor DarkYellow
    . $VenvActivate

    Write-Host "  Running build_ref_library.py (this may take 10-20 minutes)..." -ForegroundColor DarkYellow
    Write-Host "  Extracting glyph contours from reference fonts..." -ForegroundColor White
    Write-Host "  Building FAISS IVF index (141 MB) + SQLite DB (137 MB)..." -ForegroundColor White
    Write-Host ""

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    python scripts\build_ref_library.py
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: Reference database build failed." -ForegroundColor Red
        exit $LASTEXITCODE
    }
    $sw.Stop()

    Write-Host ""
    Write-Host "  Database built in $([math]::Round($sw.Elapsed.TotalMinutes, 1)) minutes." -ForegroundColor Green
}

# Verify DB files exist
if (-not (Test-Path $DbPath)) {
    Write-Host "ERROR: glyphs.db not found at $DbPath" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $FaissPath)) {
    Write-Host "ERROR: faiss_index.faiss not found at $FaissPath" -ForegroundColor Red
    exit 1
}

$dbSizeMB = [math]::Round((Get-Item $DbPath).Length / 1MB, 1)
$faissSizeMB = [math]::Round((Get-Item $FaissPath).Length / 1MB, 1)
Write-Host "  glyphs.db          $dbSizeMB MB" -ForegroundColor Green
Write-Host "  faiss_index.faiss  $faissSizeMB MB" -ForegroundColor Green

# ---- Build and start Docker containers ----
Write-Host ""
Write-Host "[4/4] Docker Compose..." -ForegroundColor Yellow

# Docker sends build progress to stderr; prevent PowerShell from treating it as errors
$ErrorActionPreference = "Continue"

if ($SkipBuild) {
    Write-Host "  Skipping build (--SkipBuild)." -ForegroundColor DarkYellow
} else {
    Write-Host "  Building Docker image (this may take 5-10 minutes)..." -ForegroundColor DarkYellow
    Write-Host "  Downloading Python deps: torch, fastapi, uvicorn, faiss..." -ForegroundColor White
    Write-Host ""

    docker compose build
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "ERROR: Docker build failed." -ForegroundColor Red
        Write-Host ""
        Write-Host "This is usually caused by inability to reach Docker Hub." -ForegroundColor Yellow
        Write-Host "If you are in China, configure a registry mirror (镜像加速器):" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  1. Open Docker Desktop -> Settings -> Docker Engine" -ForegroundColor White
        Write-Host "  2. Add this inside the JSON config:" -ForegroundColor White
        Write-Host '    "registry-mirrors": [' -ForegroundColor DarkYellow
        Write-Host '      "https://docker.1ms.run",' -ForegroundColor DarkYellow
        Write-Host '      "https://docker.xuanyuan.me"' -ForegroundColor DarkYellow
        Write-Host '    ]' -ForegroundColor DarkYellow
        Write-Host "  3. Click 'Apply & Restart'" -ForegroundColor White
        Write-Host "  4. After restart, retry: .\scripts\deploy_windows.ps1 -SkipBuild" -ForegroundColor White
        Write-Host ""
        Write-Host "  Other mirrors to try if those fail:" -ForegroundColor DarkGray
        Write-Host "    https://hub.rat.dev" -ForegroundColor DarkGray
        Write-Host "    https://docker.chenby.cn" -ForegroundColor DarkGray
        Write-Host "    https://dhub.uuug.pro" -ForegroundColor DarkGray
        exit $LASTEXITCODE
    }
    Write-Host "  Build complete." -ForegroundColor Green
}

# Stop existing containers if any
docker compose down 2>$null

Write-Host ""
Write-Host "  Starting services (redis + fde-api + mitmproxy)..." -ForegroundColor DarkYellow
docker compose up -d
if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Docker compose up failed." -ForegroundColor Red
    exit $LASTEXITCODE
}

# Wait for healthy
Write-Host ""
Write-Host "  Waiting for services to be healthy..." -ForegroundColor DarkYellow
$maxWait = 60
for ($i = 1; $i -le $maxWait; $i++) {
    Start-Sleep -Seconds 2
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8000/health" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            Write-Host "  Services ready after $($i*2)s" -ForegroundColor Green
            break
        }
    } catch {
        Write-Host "  ...waiting ($($i*2)s)" -ForegroundColor Gray
    }
    if ($i -eq $maxWait) {
        Write-Host "  WARNING: Health check timed out. Check logs: docker compose logs fde-api" -ForegroundColor Yellow
    }
}

# ---- Final verification ----
Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Deployment Complete!" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# Health check
try {
    $healthResp = Invoke-WebRequest -Uri "http://localhost:8000/health" -UseBasicParsing -TimeoutSec 5
    $health = $healthResp.Content | ConvertFrom-Json
    Write-Host "  Status:      $($health.status)" -ForegroundColor White
    Write-Host "  Classifier:  $($health.classifier)" -ForegroundColor White
    Write-Host "  Vectors:     $($health.index_vectors)" -ForegroundColor White
    Write-Host "  Version:     $($health.version)" -ForegroundColor White
} catch {
    Write-Host "  Health check failed. Check: docker compose logs fde-api" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Endpoints:" -ForegroundColor Cyan
Write-Host "  API:        http://localhost:8000" -ForegroundColor White
Write-Host "  Health:     http://localhost:8000/health" -ForegroundColor White
Write-Host "  Decode:     POST http://localhost:8000/api/v1/decode" -ForegroundColor White
Write-Host "  Proxy:      http://localhost:8080" -ForegroundColor White
Write-Host ""
Write-Host "Management:" -ForegroundColor Cyan
Write-Host "  Logs:       docker compose logs -f fde-api" -ForegroundColor White
Write-Host "  Stop:       docker compose down" -ForegroundColor White
Write-Host "  Restart:    docker compose restart" -ForegroundColor White
Write-Host "  Full reset: docker compose down -v" -ForegroundColor White
Write-Host ""
