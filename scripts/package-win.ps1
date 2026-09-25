param([string]$OutputName = 'PnX-Platform-win32-x64')
$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$distDir = [System.IO.Path]::GetFullPath((Join-Path $sourceRoot 'dist'))
$outDir = [System.IO.Path]::GetFullPath((Join-Path $distDir $OutputName))
if (-not $outDir.StartsWith($distDir + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Output path must be inside dist.' }

$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$vendor = Join-Path $sourceRoot 'desktop\vendor'
foreach ($required in @($compiler, $node, (Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll'), (Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll'), (Join-Path $vendor 'WebView2Loader.dll'))) {
  if (-not (Test-Path -LiteralPath $required)) { throw "Missing build dependency: $required" }
}

if (Test-Path -LiteralPath $outDir) {
  $knownPackage = (Test-Path -LiteralPath (Join-Path $outDir 'PnX-Platform.exe')) -and ((Test-Path -LiteralPath (Join-Path $outDir 'src\server.mjs')) -or (Test-Path -LiteralPath (Join-Path $outDir 'resources\app\src\server.mjs')))
  if (-not $knownPackage) { throw "Refusing to replace an unknown folder: $outDir" }
  Remove-Item -LiteralPath $outDir -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $outDir 'bin') -Force | Out-Null
foreach ($name in @('src', 'web')) { Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination $outDir -Recurse }
Copy-Item -LiteralPath (Join-Path $sourceRoot 'README.md') -Destination $outDir
Copy-Item -Path (Join-Path $vendor '*.dll') -Destination $outDir
Copy-Item -LiteralPath $node -Destination (Join-Path $outDir 'bin\node.exe')

$backend = Join-Path $sourceRoot '..\cortex-kit\extension\bin\cortex-kit-dap.exe'
if (Test-Path -LiteralPath $backend) { Copy-Item -LiteralPath $backend -Destination (Join-Path $outDir 'bin\cortex-kit-dap.exe') }

& $compiler /nologo /target:winexe "/out:$(Join-Path $outDir 'PnX-Platform.exe')" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll /reference:System.Web.Extensions.dll "/reference:$(Join-Path $vendor 'Microsoft.Web.WebView2.Core.dll')" "/reference:$(Join-Path $vendor 'Microsoft.Web.WebView2.WinForms.dll')" (Join-Path $sourceRoot 'desktop\PnxDesktop.cs')
if ($LASTEXITCODE -ne 0) { throw 'C# desktop host compilation failed' }
Write-Output "Packaged: $(Join-Path $outDir 'PnX-Platform.exe')"
