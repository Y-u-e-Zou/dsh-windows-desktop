# convert-logo.ps1 - turn a square source image into the app/tray icons.
#
# Usage:
#   1. Put your whale-girl image at  assets\logo-source.png
#   2. Run:  powershell -NoProfile -ExecutionPolicy Bypass -File convert-logo.ps1
#   3. Rebuild:  double-click dist.bat
#
# It center-crops to a square, resizes to 256x256 (icon.png) and 32x32 (tray.png).
# Add -Round to give the icon rounded corners (macOS/Android style).

param(
    [string]$Source = "assets\logo-source.png",
    [string]$OutDir = "assets",
    [switch]$Round
)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$Source = Join-Path $PSScriptRoot $Source
$OutDir = Join-Path $PSScriptRoot $OutDir

if (-not (Test-Path $Source)) {
    Write-Host "ERROR: source image not found: $Source"
    Write-Host "Put your image at assets\logo-source.png first."
    exit 1
}
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

$src = [System.Drawing.Image]::FromFile($Source)

function Convert-One([int]$size, [string]$outPath, [bool]$round) {
    $side = [Math]::Min($src.Width, $src.Height)
    $x = [int](($src.Width - $side) / 2)
    $y = [int](($src.Height - $side) / 2)

    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    if ($round) {
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $r = [int]($size * 0.22)
        $d = $r * 2
        $path.AddArc(0, 0, $d, $d, 180, 90)
        $path.AddArc($size - $d, 0, $d, $d, 270, 90)
        $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
        $path.AddArc(0, $size - $d, $d, $d, 90, 90)
        $path.CloseFigure()
        $g.SetClip($path)
    }

    $dstRect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $g.DrawImage($src, $dstRect, $x, $y, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $outPath"
}

Convert-One 256 (Join-Path $OutDir 'icon.png') $Round
Convert-One 32  (Join-Path $OutDir 'tray.png') $false

$src.Dispose()
Write-Host "Done. Now double-click dist.bat to rebuild with the new logo."
