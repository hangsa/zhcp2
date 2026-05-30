# FDE Reference Font Downloader
# ====================================
# Downloads free Chinese reference fonts for training.
# Run: powershell -ExecutionPolicy Bypass -File scripts/download_fonts.ps1
#
# Fonts: Source Han Sans SC + Source Han Serif SC (SIL OFL license, ~7000+ glyphs each)
# Same design as Google Noto CJK, packaged by Adobe per-language.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectDir = Split-Path -Parent $ScriptDir
Set-Location $ProjectDir
$FontsDir = Join-Path $ProjectDir "data\reference\fonts"
$TempDir = Join-Path $ProjectDir "data\reference\temp_download"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Download Reference Fonts" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

New-Item -ItemType Directory -Force -Path $FontsDir | Out-Null
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

$Downloads = @(
    @{
        Name = "Source Han Sans SC (思源黑体)"
        Url  = "https://github.com/adobe-fonts/source-han-sans/releases/download/2.004R/SourceHanSansSC.zip"
        File = "SourceHanSansSC.zip"
    },
    @{
        Name = "Source Han Serif SC (思源宋体)"
        Url  = "https://github.com/adobe-fonts/source-han-serif/releases/download/2.003R/SourceHanSerifSC.zip"
        File = "SourceHanSerifSC.zip"
    }
)

$total = $Downloads.Count
$current = 0

foreach ($dl in $Downloads) {
    $current++
    $zipPath = Join-Path $TempDir $dl.File

    Write-Host "[$current/$total] $($dl.Name)" -ForegroundColor Yellow

    if (Test-Path $zipPath) {
        Write-Host "  ZIP already cached, skipping download..." -ForegroundColor DarkYellow
    } else {
        Write-Host "  Downloading (~45 MB, may take a minute)..." -ForegroundColor DarkYellow
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $dl.Url -OutFile $zipPath -UseBasicParsing
        } catch {
            Write-Host "  FAILED to download: $_" -ForegroundColor Red
            Write-Host "  Please download manually and extract to: $FontsDir" -ForegroundColor Red
            continue
        }
    }

    Write-Host "  Extracting OTF files..." -ForegroundColor DarkYellow
    try {
        $extractDir = Join-Path $TempDir $dl.File.Replace(".zip", "")
        Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

        $otfFiles = Get-ChildItem -Path $extractDir -Filter "*.otf" -Recurse
        foreach ($fontFile in $otfFiles) {
            $dest = Join-Path $FontsDir $fontFile.Name
            Copy-Item -Path $fontFile.FullName -Destination $dest -Force
            Write-Host "    + $($fontFile.Name)" -ForegroundColor Green
        }
    } catch {
        Write-Host "  FAILED to extract: $_" -ForegroundColor Red
        Write-Host "  If on older Windows, install 7-Zip or extract manually." -ForegroundColor Red
    }
}

# Cleanup temp
Write-Host ""
Write-Host "Cleaning up temp files..." -ForegroundColor DarkYellow
Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue

# Summary
$fontCount = (Get-ChildItem -Path $FontsDir -Filter "*.otf" -ErrorAction SilentlyContinue).Count +
             (Get-ChildItem -Path $FontsDir -Filter "*.ttf" -ErrorAction SilentlyContinue).Count +
             (Get-ChildItem -Path $FontsDir -Filter "*.ttc" -ErrorAction SilentlyContinue).Count

Write-Host ""
Write-Host "Done! $fontCount font file(s) in: $FontsDir" -ForegroundColor Green
Write-Host ""
if ($fontCount -lt 4) {
    Write-Host "WARNING: Fewer than 4 fonts found. CNN generalization will suffer." -ForegroundColor Yellow
    Write-Host "Copy additional .ttf/.otf Chinese fonts to the directory above." -ForegroundColor Yellow
    Write-Host "Suggested: LXGW WenKai (霞鹜文楷), various open-source Chinese fonts." -ForegroundColor Yellow
}
Write-Host ""
