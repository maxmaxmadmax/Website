<#
    FIT A PARTNER LOGO

    Resizes a logo down to the largest size the site will ever draw it at,
    and saves it into images/partners with a tidy name.

        powershell -File tools/fit-logo.ps1 -In "C:\path\to\whatever.png" -Name grand-view-hotel

    Why bother: the logo strip draws each mark inside a box no bigger than
    170 x 60 CSS pixels. A 2534px wide original is drawn at about a sixth of
    that and costs the visitor the whole file to do it. Shipping it at twice
    the drawn size keeps it crisp on a retina screen and throws the rest
    away.

    PNG, not JPG - these have transparent backgrounds and JPG would fill
    them with white, which only works until the band behind them changes.
#>

param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Name,
    [int]$MaxWidth = 400,
    [int]$MaxHeight = 120
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $In)) { Write-Error "No such file: $In"; exit 1 }

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root 'images\partners'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$src = [System.Drawing.Image]::FromFile($In)

# whichever edge runs out of room first decides the scale
$scale = [Math]::Min($MaxWidth / $src.Width, $MaxHeight / $src.Height)
if ($scale -gt 1) { $scale = 1 }        # never enlarge - it only blurs

$w = [int][Math]::Round($src.Width * $scale)
$h = [int][Math]::Round($src.Height * $scale)

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CompositingMode = 'SourceCopy'          # keeps the alpha channel intact
$g.InterpolationMode = 'HighQualityBicubic'
$g.SmoothingMode = 'HighQuality'
$g.PixelOffsetMode = 'HighQuality'
$g.DrawImage($src, 0, 0, $w, $h)

$out = Join-Path $outDir "$Name.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)

$g.Dispose(); $bmp.Dispose(); $src.Dispose()

$before = [math]::Round((Get-Item $In).Length / 1KB, 1)
$after = [math]::Round((Get-Item $out).Length / 1KB, 1)
$saved = [math]::Round(100 - ($after / $before * 100))

Write-Output "$Name.png"
Write-Output "  $($src.Width)x$($src.Height) -> ${w}x${h}"
Write-Output "  ${before} KB -> ${after} KB  (${saved}% smaller)"
