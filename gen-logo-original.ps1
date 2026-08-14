# Generate an ORIGINAL logo: whale-tail silhouette + DSH (no reference to the
# official mascot). Output: assets/logo-原创.png (256) and assets/tray-原创.png (32)

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$outDir = Join-Path $PSScriptRoot 'assets'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

# Whale-tail silhouette (symmetric V flukes), white polygon
function Add-TailPath($g, [single]$cx, [single]$cy, [single]$scale) {
    $pts = New-Object System.Drawing.PointF[] 10
    $pts[0] = New-Object System.Drawing.PointF(($cx), ($cy + 88 * $scale))
    $pts[1] = New-Object System.Drawing.PointF(($cx - 70 * $scale), ($cy + 10 * $scale))
    $pts[2] = New-Object System.Drawing.PointF(($cx - 95 * $scale), ($cy - 45 * $scale))
    $pts[3] = New-Object System.Drawing.PointF(($cx - 45 * $scale), ($cy - 70 * $scale))
    $pts[4] = New-Object System.Drawing.PointF(($cx - 8 * $scale), ($cy - 10 * $scale))
    $pts[5] = New-Object System.Drawing.PointF(($cx + 8 * $scale), ($cy - 10 * $scale))
    $pts[6] = New-Object System.Drawing.PointF(($cx + 45 * $scale), ($cy - 70 * $scale))
    $pts[7] = New-Object System.Drawing.PointF(($cx + 95 * $scale), ($cy - 45 * $scale))
    $pts[8] = New-Object System.Drawing.PointF(($cx + 70 * $scale), ($cy + 10 * $scale))
    $pts[9] = New-Object System.Drawing.PointF(($cx), ($cy + 88 * $scale))
    $g.FillPolygon([System.Drawing.Brushes]::White, $pts)
}

function New-Logo([int]$size, [bool]$withText, [string]$outPath) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $g.FillRectangle([System.Drawing.Brushes]::SteelBlue, 0, 0, $size, $size)

    Add-TailPath $g ([single]($size / 2)) ([single]($size * 0.42)) ([single]($size / 256))

    if ($withText) {
        $font = New-Object System.Drawing.Font('Segoe UI', ([single]($size * 0.13)), [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
        $sf = New-Object System.Drawing.StringFormat
        $sf.Alignment = [System.Drawing.StringAlignment]::Center
        $sf.LineAlignment = [System.Drawing.StringAlignment]::Near
        $trect = New-Object System.Drawing.RectangleF(0, ($size * 0.74), $size, ($size * 0.22))
        $g.DrawString('DSH', $font, [System.Drawing.Brushes]::White, $trect, $sf)
    }

    $g.Dispose()
    $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $outPath"
}

New-Logo 256 $true  (Join-Path $outDir 'logo-original.png')
New-Logo 32  $false (Join-Path $outDir 'tray-original.png')
