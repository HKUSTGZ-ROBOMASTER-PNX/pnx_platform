$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assets = Join-Path $PSScriptRoot '..\assets'
$source = [Drawing.Image]::FromFile((Resolve-Path (Join-Path $assets 'pnx-icon.png')).Path)
try {
  $frames = @()
  foreach ($size in @(16,24,32,48,64,128,256,1024)) {
    $bitmap = New-Object Drawing.Bitmap($size,$size)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.DrawImage($source,0,0,$size,$size)
    $stream = New-Object IO.MemoryStream
    $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
    $frames += ,@{ Size=$size; Data=$stream.ToArray() }
    $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
  }
  $ico = [IO.File]::Create((Join-Path $assets 'pnx-icon.ico'))
  $writer = New-Object IO.BinaryWriter($ico)
  try {
    $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]7)
    $offset=6+16*7
    foreach ($frame in $frames[0..6]) {
      $dimension = if($frame.Size -eq 256){0}else{$frame.Size}
      $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
      $writer.Write([byte]0); $writer.Write([byte]0); $writer.Write([uint16]1); $writer.Write([uint16]32)
      $writer.Write([uint32]$frame.Data.Length); $writer.Write([uint32]$offset)
      $offset += $frame.Data.Length
    }
    foreach ($frame in $frames[0..6]) { $writer.Write([byte[]]$frame.Data) }
  } finally { $writer.Dispose() }
  $icns = [IO.File]::Create((Join-Path $assets 'pnx-icon.icns'))
  try {
    $data=$frames[7].Data
    $header=[Text.Encoding]::ASCII.GetBytes('icns'); $icns.Write($header,0,4)
    $length=[BitConverter]::GetBytes([uint32]($data.Length+16)); [Array]::Reverse($length); $icns.Write($length,0,4)
    $type=[Text.Encoding]::ASCII.GetBytes('ic10'); $icns.Write($type,0,4)
    $length=[BitConverter]::GetBytes([uint32]($data.Length+8)); [Array]::Reverse($length); $icns.Write($length,0,4)
    $icns.Write($data,0,$data.Length)
  } finally { $icns.Dispose() }
} finally { $source.Dispose() }
