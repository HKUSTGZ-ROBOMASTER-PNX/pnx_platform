param([string]$ElectronVersion = '38.8.6', [string]$OutputName = 'PnX-Platform-electron-win32-x64')
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& (Join-Path $PSScriptRoot 'build-native-win.ps1')
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Native backend build failed' }
$zip = Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'electron\Cache') -Filter "electron-v$ElectronVersion-win32-x64.zip" -File -Recurse | Select-Object -First 1
if (-not $zip) { throw "Electron $ElectronVersion Windows x64 runtime is missing from the local cache." }
$distDir = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot 'dist'))
$outDir = [System.IO.Path]::GetFullPath((Join-Path $distDir $OutputName))
if (-not $outDir.StartsWith($distDir + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output path must be inside dist.' }
if (Test-Path -LiteralPath $outDir) {
  $outDir = [System.IO.Path]::GetFullPath((Join-Path $distDir ($OutputName + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))))
  if (-not $outDir.StartsWith($distDir + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output path must be inside dist.' }
  if (Test-Path -LiteralPath $outDir) { throw "Output already exists: $outDir" }
}

New-Item -ItemType Directory -Path $outDir -Force | Out-Null
Expand-Archive -LiteralPath $zip.FullName -DestinationPath $outDir
$appDir = Join-Path $outDir 'resources\app'
New-Item -ItemType Directory -Path $appDir -Force | Out-Null
foreach ($name in @('package.json', 'README.md')) { Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination $appDir }
foreach ($name in @('src', 'web', 'electron', 'assets')) { Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination $appDir -Recurse }
$binDir = Join-Path $appDir 'bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'bin\pnx-dap.exe') -Destination (Join-Path $binDir 'pnx-dap.exe')
Rename-Item -LiteralPath (Join-Path $outDir 'electron.exe') -NewName 'PnX-Platform.exe'
& (Join-Path $PSScriptRoot 'set-win-icon.ps1') -Executable (Join-Path $outDir 'PnX-Platform.exe') -Icon (Join-Path $sourceRoot 'assets\pnx-icon.ico')
$localeDir = [System.IO.Path]::GetFullPath((Join-Path $outDir 'locales'))
if (-not $localeDir.StartsWith($outDir + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid locale directory.' }
foreach ($locale in Get-ChildItem -LiteralPath $localeDir -File) {
  if ($locale.Name -notin @('en-US.pak', 'zh-CN.pak')) { Remove-Item -LiteralPath $locale.FullName -Force }
}
$defaultApp = [System.IO.Path]::GetFullPath((Join-Path $outDir 'resources\default_app.asar'))
if (-not $defaultApp.StartsWith($outDir + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid default app path.' }
if (Test-Path -LiteralPath $defaultApp) { Remove-Item -LiteralPath $defaultApp -Force }
Write-Output "Packaged: $(Join-Path $outDir 'PnX-Platform.exe')"
