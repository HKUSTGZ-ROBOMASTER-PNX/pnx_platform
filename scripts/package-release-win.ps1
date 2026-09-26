param([string]$PackageDir)
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dist = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot 'dist'))
if (-not $PackageDir) {
  $candidate = Get-ChildItem -LiteralPath $dist -Directory |
    Where-Object { $_.Name -like 'PnX-Platform-electron-win32-x64*' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'PnX-Platform.exe')) } |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $candidate) { throw 'Run npm run package:win first.' }
  $PackageDir = $candidate.FullName
}
$package = (Resolve-Path -LiteralPath $PackageDir).Path
if (-not $package.StartsWith($dist + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Package directory must be inside dist.' }
if (-not (Test-Path -LiteralPath (Join-Path $package 'PnX-Platform.exe'))) { throw 'Package directory has no PnX-Platform.exe.' }
$release = Join-Path $dist 'release'
New-Item -ItemType Directory -Path $release -Force | Out-Null
$payload = Join-Path $release 'PnX-Platform-windows-x64.zip'
$setup = Join-Path $release 'PnX-Platform-Setup-windows-x64.exe'
if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload -Force }
if (Test-Path -LiteralPath $setup) { Remove-Item -LiteralPath $setup -Force }
Push-Location $package
try { & tar.exe -a -cf $payload .; if ($LASTEXITCODE -ne 0) { throw 'ZIP packaging failed.' } }
finally { Pop-Location }
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler unavailable; ZIP is still distributable.' }
& $compiler /nologo /codepage:65001 /target:winexe /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.IO.Compression.dll "/win32icon:$(Join-Path $sourceRoot 'assets\pnx-icon.ico')" "/resource:$payload,PnXPayload.zip" "/out:$setup" (Join-Path $PSScriptRoot 'Setup.cs')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$sha = [System.Security.Cryptography.SHA256]::Create()
$stream = [System.IO.File]::OpenRead($setup)
try { $digest = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
finally { $stream.Dispose(); $sha.Dispose() }
Write-Output "SHA256 $digest  $setup"
Write-Output "Release assets: $setup ; $payload"
