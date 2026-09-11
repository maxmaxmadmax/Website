<#
    FIT A PARTNER LOGO

    Crops, trims and resizes a logo down to the largest size the site will
    ever draw it at, then saves it into images/partners with a tidy name.

        powershell -File tools/fit-logo.ps1 -In "C:\path\whatever.png" -Name grand-view-hotel
        powershell -File tools/fit-logo.ps1 -In "...\dash.png" -Name don-river-dash -KeepTop 0.74
        powershell -File tools/fit-logo.ps1 -In "...\cape.jpg" -Name cape-gloucester-eco-resort -Trim

    WHY BOTHER
    The strip draws every logo inside a box no bigger than 170 x 60 CSS
    pixels. A 2534px wide original is drawn at about a sixth of that and
    costs the visitor the whole file to do it. Saving at twice the drawn
    size keeps it sharp on a retina screen and throws the rest away.

    -Trim removes a uniform white or transparent border. Logos often arrive
    floating in a square of padding, which the box then counts as part of
    the logo - so the mark itself is drawn smaller than its neighbours and
    the row looks uneven.

    -KeepTop <0-1> keeps only that fraction of the height before trimming,
    for a logo with something underneath it that should not be there - a
    date, a tagline, a strapline too small to read at this size.

    IT DOES ARTIST PHOTOGRAPHS TOO
    The same job with a different target and somewhere else to land:

        powershell -File tools/fit-logo.ps1 -In "...\maxx.jpg" -Name dj-maxx `
                   -OutDir images\talent -MaxWidth 600 -MaxHeight 800

    FORMAT IS CHOSEN, NOT ASSUMED
    A logo with transparency is saved as PNG, because JPG cannot hold it and
    would fill it with white - which looks right on today's white band and
    breaks the moment that band changes colour.

    A logo that arrived on a solid background has nothing to preserve, and
    PNG is the wrong tool for it: forcing the Cape Gloucester mark to PNG
    turned 7.7 KB into 27 KB. Those are saved as JPG instead.
#>

param(
    [Parameter(Mandatory = $true)][string]$In,
    [Parameter(Mandatory = $true)][string]$Name,
    [double]$KeepTop = 1.0,
    [switch]$Trim,
    [int]$MaxWidth = 400,
    [int]$MaxHeight = 120,
    [int]$Quality = 88,
    [string]$OutDir = 'images\partners'
)

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $In)) { Write-Error "No such file: $In"; exit 1 }

$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root $OutDir
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$src = [System.Drawing.Image]::FromFile($In)
$orig = "$($src.Width)x$($src.Height)"

# work on a bitmap copy so the source file handle can be released
$work = New-Object System.Drawing.Bitmap $src
$src.Dispose()

# ---- keep only the top slice, if asked ----
if ($KeepTop -lt 1.0) {
    $h = [int][Math]::Round($work.Height * $KeepTop)
    $rect = New-Object System.Drawing.Rectangle 0, 0, $work.Width, $h
    $cropped = $work.Clone($rect, $work.PixelFormat)
    $work.Dispose()
    $work = $cropped
}

# ---- trim a uniform white / transparent border ----
if ($Trim) {
    $stride = [Math]::Max(1, [int]($work.Width / 260))   # sample, do not read every pixel
    $minX = $work.Width; $minY = $work.Height; $maxX = -1; $maxY = -1

    for ($y = 0; $y -lt $work.Height; $y += $stride) {
        for ($x = 0; $x -lt $work.Width; $x += $stride) {
            $p = $work.GetPixel($x, $y)
            # anything that is not near-white and not transparent counts as ink
            $ink = ($p.A -gt 24) -and -not ($p.R -gt 242 -and $p.G -gt 242 -and $p.B -gt 242)
            if ($ink) {
                if ($x -lt $minX) { $minX = $x }
                if ($y -lt $minY) { $minY = $y }
                if ($x -gt $maxX) { $maxX = $x }
                if ($y -gt $maxY) { $maxY = $y }
            }
        }
    }

    if ($maxX -ge 0) {
        # give back the sampling step, so nothing is shaved off the edge
        $pad = $stride + 1
        $minX = [Math]::Max(0, $minX - $pad)
        $minY = [Math]::Max(0, $minY - $pad)
        $maxX = [Math]::Min($work.Width - 1, $maxX + $pad)
        $maxY = [Math]::Min($work.Height - 1, $maxY + $pad)

        $rect = New-Object System.Drawing.Rectangle $minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1)
        $trimmed = $work.Clone($rect, $work.PixelFormat)
        $work.Dispose()
        $work = $trimmed
    }
}

# ---- does the source actually use transparency? ----
#  Asked of the original, not the resized copy. A bicubic resize onto a
#  transparent canvas leaves faintly see-through pixels all along the edge,
#  so the result always looks like it has alpha even when the logo arrived
#  on a solid white background.
$hasAlpha = $false
if ([System.Drawing.Image]::IsAlphaPixelFormat($work.PixelFormat)) {
    $step = [Math]::Max(1, [int]($work.Width / 140))
    for ($y = 0; $y -lt $work.Height -and -not $hasAlpha; $y += $step) {
        for ($x = 0; $x -lt $work.Width; $x += $step) {
            if ($work.GetPixel($x, $y).A -lt 250) { $hasAlpha = $true; break }
        }
    }
}

# ---- scale to fit ----
$scale = [Math]::Min($MaxWidth / $work.Width, $MaxHeight / $work.Height)
if ($scale -gt 1) { $scale = 1 }          # never enlarge - it only blurs

$w = [int][Math]::Round($work.Width * $scale)
$h = [int][Math]::Round($work.Height * $scale)

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
if ($hasAlpha) {
    $g.Clear([System.Drawing.Color]::Transparent)
} else {
    # no transparency to keep, so the edges blend into white rather than
    # into nothing - which is what left them half see-through before
    $g.Clear([System.Drawing.Color]::White)
}
$g.InterpolationMode = 'HighQualityBicubic'
$g.SmoothingMode = 'HighQuality'
$g.PixelOffsetMode = 'HighQuality'
$g.DrawImage($work, 0, 0, $w, $h)

if ($hasAlpha) {
    $ext = 'png'
    $out = Join-Path $outDir "$Name.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
} else {
    # JPG - smaller, and there is no transparency to lose
    $ext = 'jpg'
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
             Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, $Quality)

    $out = Join-Path $outDir "$Name.jpg"
    $bmp.Save($out, $codec, $params)
}

$g.Dispose(); $bmp.Dispose(); $work.Dispose()

$before = [math]::Round((Get-Item $In).Length / 1KB, 1)
$after = [math]::Round((Get-Item $out).Length / 1KB, 1)
$saved = [math]::Round(100 - ($after / $before * 100))

Write-Output "$Name.$ext"
Write-Output "  $orig -> ${w}x${h}"
Write-Output "  ${before} KB -> ${after} KB  (${saved}% smaller)"
