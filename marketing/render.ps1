# Exports every NOVA TV social piece (HTML) to PNG with Edge, at Instagram sizes.
#   story-*.html -> 1080x1920   post-*.html -> 1080x1350   avatar-*.html -> 1080x1080
# Usage (from this folder):  powershell -ExecutionPolicy Bypass -File render.ps1 [name-filter]
param([string]$Filter = "*")

$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw "Microsoft Edge not found." }

$here = $PSScriptRoot
$outDir = Join-Path $here "png"
New-Item -ItemType Directory -Force $outDir | Out-Null
# A separate profile, so it works while Edge is open.
$profileDir = Join-Path $env:TEMP "nova-render-profile"

Get-ChildItem $here -Filter "$Filter.html" | Where-Object { $_.Name -match '^(story|post|avatar)-' } | ForEach-Object {
  $size = if ($_.Name -like "story-*") { "1080,1920" } elseif ($_.Name -like "avatar-*") { "1080,1080" } else { "1080,1350" }
  $out = Join-Path $outDir ($_.BaseName + ".png")
  $url = "file:///" + ($_.FullName -replace '\\', '/')
  $arguments = @(
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
    "--window-size=$size", "--virtual-time-budget=8000", "--user-data-dir=`"$profileDir`"",
    "--screenshot=`"$out`"", "`"$url`""
  )
  Start-Process -FilePath $edge -ArgumentList $arguments -Wait -WindowStyle Hidden
  Write-Host "OK  $($_.Name) -> png\$($_.BaseName).png"
}
