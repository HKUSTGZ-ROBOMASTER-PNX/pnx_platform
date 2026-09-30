param([switch]$Probe, [switch]$CheckDecoder, [string]$SdkDirectory, [string]$UsbLibrary, [string]$Device, [string]$PipeName)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -Path (Join-Path $PSScriptRoot 'receiver.cs')
  if ($CheckDecoder) {
    [Console]::WriteLine([PnxBulletReceiver]::CheckDecoder($SdkDirectory))
  } elseif ($Probe) {
    $devices = @([PnxBulletReceiver]::Devices($UsbLibrary))
    [Console]::WriteLine('PNX_DEVICES ' + (ConvertTo-Json -InputObject $devices -Compress))
  } else {
    [PnxBulletReceiver]::Run($SdkDirectory, $UsbLibrary, $Device, $PipeName)
  }
} catch {
  [Console]::Error.WriteLine('PNX_ERROR ' + $_.Exception.GetBaseException().Message)
  exit 1
}
