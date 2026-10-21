# Renders the installers' artwork (installer/art.html) with Edge at 2x and
# saves it as the 24-bit BMPs NSIS needs:
#   src-tauri/installer/{sidebar,header}.bmp  → NOVA TV (tauri.conf.json)
#   host/{sidebar,header}.bmp                 → NOVA Host (host/installer.nsi)
# The BMPs are committed: building an installer never needs Edge.
#
#   powershell -ExecutionPolicy Bypass -File scripts/installer-art.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$root = Split-Path $PSScriptRoot -Parent

$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found." }

$art = "file:///" + ((Join-Path $root "installer\art.html") -replace '\\', '/')
$work = Join-Path $root "src-tauri\target\installer-art"
New-Item -ItemType Directory -Force $work | Out-Null
# A separate profile, so it works while Edge is open.
$profileDir = Join-Path $env:TEMP "nova-installer-art-profile"

$pieces = @(
  @{ Piece = "sidebar"; Product = "tv"; Size = "164,314"; Out = "src-tauri\installer\sidebar.bmp" },
  @{ Piece = "header"; Product = "tv&theme=light"; Size = "150,57"; Out = "src-tauri\installer\header.bmp" },
  @{ Piece = "sidebar"; Product = "host"; Size = "164,314"; Out = "host\sidebar.bmp" },
  @{ Piece = "header"; Product = "host"; Size = "150,57"; Out = "host\header.bmp" }
)

foreach ($p in $pieces) {
  $png = Join-Path $work "$($p.Piece)-$($p.Product).png"
  $arguments = @(
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    "--window-size=$($p.Size)", "--virtual-time-budget=8000", "--user-data-dir=`"$profileDir`"",
    "--screenshot=`"$png`"", "`"$art`?piece=$($p.Piece)&product=$($p.Product)`""
  )
  Start-Process -FilePath $edge -ArgumentList $arguments -Wait -WindowStyle Hidden
  if (-not (Test-Path $png)) { throw "Edge did not render $($p.Piece)/$($p.Product)" }

  # NSIS only loads uncompressed 24-bit BMPs.
  $source = [System.Drawing.Image]::FromFile($png)
  $size = "$($source.Width)x$($source.Height)"
  try {
    $bmp = New-Object System.Drawing.Bitmap $source.Width, $source.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.DrawImage($source, 0, 0, $source.Width, $source.Height)
    $g.Dispose()
    $out = Join-Path $root $p.Out
    New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
  } finally { $source.Dispose() }
  Write-Host "OK  $($p.Out) ($size)"
}
