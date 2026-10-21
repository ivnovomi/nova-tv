# Builds the NOVA Host installer (NovaBridge + Sunshine + ViGEmBus) for the gaming PC.
#
#   powershell -ExecutionPolicy Bypass -File scripts/host.ps1            # build only
#   powershell -ExecutionPolicy Bypass -File scripts/host.ps1 -Publish   # and attach it to this version's release
#
# Sunshine is pinned (version + SHA-256 from its GitHub release): a different
# file never makes it into the installer. Output: src-tauri\target\host.

param(
  [switch]$Publish,
  [string]$Repo = "ivnovomi/nova-tv-releases"
)

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent

# Sunshine shipped inside NOVA Host. Update LICENCIAS.txt when this changes.
$sunshineTag = "v2026.914.233613"
$sunshineAsset = "Sunshine-Windows-AMD64-installer.msi"
$sunshineSha256 = "1d7fed8beecd5889dc7ff14cf9f42d6d38f37c3066c13c6c2a5f4e91847e0ccf"

# ViGEmBus: the virtual gamepad driver Sunshine uses (the TV's controller becomes
# an Xbox/PlayStation pad on the PC). Final release of an archived project;
# checked by hash and by its publisher's signature.
$vigemTag = "v1.22.0"
$vigemAsset = "ViGEmBus_1.22.0_x64_x86_arm64.exe"
$vigemSha256 = "89220a7865076b342892f98865f3499fb7c4cfd673159e89d352c360fd014c6a"
$vigemSigner = "CN=Nefarius Software Solutions e.U.*"

$version = (Get-Content (Join-Path $root "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json).version
$out = Join-Path $root "src-tauri\target\host"
New-Item -ItemType Directory -Force $out | Out-Null
Write-Host "NOVA Host $version"

# 1. NovaBridge.
Push-Location (Join-Path $root "src-tauri")
try {
  cargo build --release --bin nova-bridge
  if ($LASTEXITCODE -ne 0) { throw "NovaBridge build failed" }
} finally { Pop-Location }
$bridge = Join-Path $root "src-tauri\target\release\nova-bridge.exe"

# 2. Sunshine, checked against the pinned hash.
$msi = Join-Path $out "sunshine-$sunshineTag.msi"
if (-not (Test-Path $msi) -or (Get-FileHash $msi -Algorithm SHA256).Hash.ToLower() -ne $sunshineSha256) {
  Write-Host "Downloading Sunshine $sunshineTag"
  Invoke-WebRequest "https://github.com/LizardByte/Sunshine/releases/download/$sunshineTag/$sunshineAsset" -OutFile $msi -UseBasicParsing
}
$hash = (Get-FileHash $msi -Algorithm SHA256).Hash.ToLower()
if ($hash -ne $sunshineSha256) {
  Remove-Item $msi -Force
  throw "Sunshine does not match its pinned SHA-256 ($hash)"
}

# 3. ViGEmBus, checked against the pinned hash and its signature.
$vigem = Join-Path $out $vigemAsset
if (-not (Test-Path $vigem) -or (Get-FileHash $vigem -Algorithm SHA256).Hash.ToLower() -ne $vigemSha256) {
  Write-Host "Downloading ViGEmBus $vigemTag"
  Invoke-WebRequest "https://github.com/nefarius/ViGEmBus/releases/download/$vigemTag/$vigemAsset" -OutFile $vigem -UseBasicParsing
}
$hash = (Get-FileHash $vigem -Algorithm SHA256).Hash.ToLower()
$signature = Get-AuthenticodeSignature $vigem
if ($hash -ne $vigemSha256 -or $signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -notlike $vigemSigner) {
  Remove-Item $vigem -Force
  throw "ViGEmBus does not match its pinned SHA-256 or signature ($hash, $($signature.Status))"
}

# 4. The licence page reads UTF-8 only with a BOM.
$licenses = Join-Path $out "LICENCIAS.txt"
[System.IO.File]::WriteAllText($licenses, (Get-Content (Join-Path $root "host\LICENCIAS.txt") -Raw -Encoding UTF8), (New-Object System.Text.UTF8Encoding $true))

# 5. Installer (the NSIS that Tauri already downloads for NOVA's own installer).
$makensis = Join-Path $env:LOCALAPPDATA "tauri\NSIS\makensis.exe"
if (-not (Test-Path $makensis)) { throw "makensis not found at $makensis (run npm run tauri build once)" }
$setup = Join-Path $out "NOVA-Host_${version}_x64-setup.exe"
& $makensis /V2 /INPUTCHARSET UTF8 `
  "/DVERSION=$version" "/DBRIDGE=$bridge" "/DSUNSHINE=$msi" "/DVIGEM=$vigem" "/DLICENSES=$licenses" `
  "/DICON=$(Join-Path $root 'src-tauri\icons\icon.ico')" "/DOUTFILE=$setup" `
  (Join-Path $root "host\installer.nsi")
if ($LASTEXITCODE -ne 0) { throw "makensis failed" }
Write-Host "Built $setup ($([math]::Round((Get-Item $setup).Length / 1MB, 1)) MB)"

if ($Publish) {
  gh release upload "v$version" $setup --repo $Repo --clobber
  if ($LASTEXITCODE -ne 0) { throw "Upload failed" }
  Write-Host "Attached to v$version in $Repo"
}
