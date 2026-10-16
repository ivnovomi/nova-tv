# Renders the README images (docs/assets/*.png) from the HTML sources in this folder, with Edge.
# Usage:  powershell -ExecutionPolicy Bypass -File docs/assets/src/render.ps1 [name-filter]
param([string]$Filter = "*")

$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found." }

# name -> width, height, pixel ratio (2 = sharp on high-DPI screens)
$sizes = @{
  "banner"         = @(1280, 480, 2)
  "social-preview" = @(1280, 640, 1)   # GitHub needs < 1 MB
  "architecture"   = @(1600, 900, 1)
  "app-icon"       = @(1024, 1024, 1)  # source for `npx tauri icon docs/assets/app-icon.png`
}
$featureSize = @(1200, 720, 1)

$src = $PSScriptRoot
$out = Split-Path $src -Parent
$profileDir = Join-Path $env:TEMP "nova-render-profile"

Get-ChildItem $src -Filter "$Filter.html" | ForEach-Object {
  $size = if ($sizes.ContainsKey($_.BaseName)) { $sizes[$_.BaseName] } else { $featureSize }
  $png = Join-Path $out ($_.BaseName + ".png")
  $url = "file:///" + ($_.FullName -replace '\\', '/')
  $arguments = @(
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=$($size[2])", "--default-background-color=00000000",
    "--window-size=$($size[0]),$($size[1])", "--virtual-time-budget=8000", "--user-data-dir=`"$profileDir`"",
    "--screenshot=`"$png`"", "`"$url`""
  )
  Start-Process -FilePath $edge -ArgumentList $arguments -Wait -WindowStyle Hidden
  Write-Host ("OK  {0} -> docs/assets/{1}.png  ({2:N0} KB)" -f $_.Name, $_.BaseName, ((Get-Item $png).Length / 1KB))
}
