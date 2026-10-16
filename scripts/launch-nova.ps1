# NOVA TV launcher (used by the desktop shortcut).
#
# Double-click and NOVA opens. If the source code changed since the last build,
# it rebuilds first (showing a small "Actualizando NOVA TV…" window) and then
# opens the new version. If the build fails, it says so and opens the last
# version that worked. No terminal needed.

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$exe = Join-Path $root "src-tauri\target\release\nova-tv.exe"
# Written after every successful build (the .exe itself isn't relinked when nothing in it changed).
$stamp = Join-Path $root "src-tauri\target\release\.nova-built"
$log = Join-Path $env:TEMP "nova-tv-build.log"

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Show-Message([string]$text, [string]$icon = "Information") {
  [System.Windows.Forms.MessageBox]::Show($text, "NOVA TV", "OK", $icon) | Out-Null
}

# Already open: bring it to the front instead of opening a second one.
$running = Get-Process -Name "nova-tv" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($running) {
  (New-Object -ComObject WScript.Shell).AppActivate($running.Id) | Out-Null
  exit 0
}

# What counts as "the code": everything that ends up inside the app.
$sources = @(
  "src", "public", "index.html", "package.json", "vite.config.ts", "tsconfig.json",
  "src-tauri\src", "src-tauri\remote", "src-tauri\capabilities", "src-tauri\permissions",
  "src-tauri\icons", "src-tauri\build.rs", "src-tauri\Cargo.toml", "src-tauri\tauri.conf.json"
) | ForEach-Object { Join-Path $root $_ } | Where-Object { Test-Path $_ }

$newest = $sources | ForEach-Object {
  if ((Get-Item $_).PSIsContainer) { Get-ChildItem $_ -Recurse -File } else { Get-Item $_ }
} | Sort-Object LastWriteTime -Descending | Select-Object -First 1

$builtAt = if (Test-Path $stamp) { (Get-Item $stamp).LastWriteTime } elseif (Test-Path $exe) { (Get-Item $exe).LastWriteTime } else { [datetime]::MinValue }
$needsBuild = -not (Test-Path $exe) -or ($newest -and $newest.LastWriteTime -gt $builtAt)

if ($needsBuild) {
  # Small dark window while it builds.
  $form = New-Object System.Windows.Forms.Form
  $form.FormBorderStyle = "None"; $form.StartPosition = "CenterScreen"; $form.TopMost = $true
  $form.Size = New-Object System.Drawing.Size(520, 150); $form.BackColor = [System.Drawing.Color]::FromArgb(7, 11, 24)
  $form.ShowInTaskbar = $true; $form.Text = "Actualizando NOVA TV"
  $title = New-Object System.Windows.Forms.Label
  $title.Text = "Actualizando NOVA TV…"; $title.ForeColor = [System.Drawing.Color]::White
  $title.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 16); $title.AutoSize = $true; $title.Location = New-Object System.Drawing.Point(28, 28)
  $detail = New-Object System.Windows.Forms.Label
  $detail.Text = "Has cambiado el código: compilando la versión nueva.`nSolo pasa cuando hay cambios; puede tardar unos minutos."
  $detail.ForeColor = [System.Drawing.Color]::FromArgb(185, 192, 224); $detail.Font = New-Object System.Drawing.Font("Segoe UI", 10)
  $detail.AutoSize = $true; $detail.Location = New-Object System.Drawing.Point(30, 72)
  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.Style = "Marquee"; $bar.MarqueeAnimationSpeed = 30; $bar.Size = New-Object System.Drawing.Size(464, 6); $bar.Location = New-Object System.Drawing.Point(28, 124)
  $form.Controls.AddRange(@($title, $detail, $bar))
  $form.Show(); [System.Windows.Forms.Application]::DoEvents()

  $build = Start-Process -FilePath "cmd.exe" -ArgumentList "/c", "npm run tauri build -- --no-bundle > `"$log`" 2>&1" `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru
  while (-not $build.HasExited) {
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 100
  }
  $form.Close()

  if ($build.ExitCode -eq 0) {
    Set-Content -Path $stamp -Value (Get-Date -Format o)
  } else {
    if (Test-Path $exe) {
      Show-Message "No se pudo compilar la versión nueva, así que se abre la anterior.`n`nDetalles en:`n$log" "Warning"
    } else {
      Show-Message "No se pudo compilar NOVA TV.`n`nDetalles en:`n$log" "Error"
      exit 1
    }
  }
}

Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe)
