# Publishes a new NOVA TV version so installed copies offer it as an update.
# Run by hand; NOVA itself never runs this.
#
#   1. Raise the version in package.json, src-tauri/Cargo.toml and src-tauri/tauri.conf.json.
#   2. Write the release notes (Markdown, Spanish: they're shown in NOVA's update window).
#   3. powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Notes notas.md
#
# Builds the signed installer (key: ~/.tauri/nova-tv.key, never in the repo),
# writes latest.json and uploads both to a GitHub release on the public
# releases repository, which is where NOVA looks for updates.

param(
  [Parameter(Mandatory = $true)][string]$Notes,
  [string]$Repo = "ivnovomi/nova-tv-releases",
  [switch]$Draft
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$key = Join-Path $env:USERPROFILE ".tauri\nova-tv.key"

if (-not (Test-Path $key)) { throw "Signing key not found at $key" }
if (-not (Test-Path $Notes)) { throw "Release notes not found: $Notes" }

# The three versions must agree.
$conf = Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
$version = $conf.version
$pkg = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
$cargo = (Select-String -Path (Join-Path $root "src-tauri\Cargo.toml") -Pattern '^version = "(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
if ($pkg -ne $version -or $cargo -ne $version) {
  throw "Versions differ: tauri.conf.json $version, package.json $pkg, Cargo.toml $cargo"
}
$tag = "v$version"
Write-Host "NOVA TV $version -> $Repo ($tag)"

# Signed build.
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
Push-Location $root
try {
  npm run tauri build
  if ($LASTEXITCODE -ne 0) { throw "Build failed" }
} finally {
  Pop-Location
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

$nsis = Join-Path $root "src-tauri\target\release\bundle\nsis"
$setup = Join-Path $nsis "NOVA TV_${version}_x64-setup.exe"
$sig = "$setup.sig"
if (-not (Test-Path $setup) -or -not (Test-Path $sig)) { throw "Installer or signature missing in $nsis" }

# GitHub turns spaces into dots in asset names: use a name without them.
$out = Join-Path $root "src-tauri\target\release\publish"
New-Item -ItemType Directory -Force $out | Out-Null
$asset = "NOVA-TV_${version}_x64-setup.exe"
Copy-Item $setup (Join-Path $out $asset) -Force

$notesText = Get-Content $Notes -Raw -Encoding UTF8
$manifest = [ordered]@{
  version   = $version
  notes     = $notesText.Trim()
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = (Get-Content $sig -Raw).Trim()
      url       = "https://github.com/$Repo/releases/download/$tag/$asset"
    }
  }
}
# UTF-8 without BOM: the updater reads it as plain JSON.
$latest = Join-Path $out "latest.json"
[System.IO.File]::WriteAllText($latest, ($manifest | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))

$ghArgs = @("release", "create", $tag, (Join-Path $out $asset), $latest, "--repo", $Repo, "--title", "NOVA TV $version", "--notes-file", $Notes)
if ($Draft) { $ghArgs += "--draft" }
gh @ghArgs
if ($LASTEXITCODE -ne 0) { throw "Upload failed" }
if ($Draft) { Write-Host "Draft created: publish it on GitHub (or gh release edit $tag --repo $Repo --draft=false) to make it the update." }
else { Write-Host "Published. Installed copies will offer $version within 6 hours (or at once from Ajustes -> Actualizaciones)." }
