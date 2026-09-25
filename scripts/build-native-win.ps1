param([string]$Target = $env:PNX_NATIVE_TARGET)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $root 'native\Cargo.toml'
$cargo = (Get-Command cargo.exe -ErrorAction Stop).Source
$args = @('build', '--release', '--locked', '--manifest-path', $manifest, '-p', 'pnx-dap')
if ($Target) { $args += @('--target', $Target) }
& $cargo @args
if ($LASTEXITCODE -ne 0) { throw 'The PnX Rust backend build failed.' }
$targetDir = if ($Target) { Join-Path $root "native\target\$Target\release" } else { Join-Path $root 'native\target\release' }
$binary = Join-Path $targetDir 'pnx-dap.exe'
if (-not (Test-Path -LiteralPath $binary)) { throw "Missing compiled backend: $binary" }
$binDir = Join-Path $root 'bin'
New-Item -ItemType Directory -Path $binDir -Force | Out-Null
Copy-Item -LiteralPath $binary -Destination (Join-Path $binDir 'pnx-dap.exe') -Force
Write-Output "Built: $(Join-Path $binDir 'pnx-dap.exe')"
