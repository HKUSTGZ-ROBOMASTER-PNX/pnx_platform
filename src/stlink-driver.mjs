import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
export const driverUrl = 'https://www.st.com/en/development-tools/stsw-link009.html';
// Product IDs supported by our bundled probe-rs ST-Link backend.
const devicePattern = /VID_0483&PID_(3748|374B|374A|3742|3752|374E|374F|3753|3754|3757)(?:&|\\|$)/i;
export function summarizeDevices(rows) {
  const devices = rows.filter(row => devicePattern.test(row.id || '')).map(row => {
    const code = row.problem == null ? null : Number(row.problem);
    const state = code === 28 ? 'missing' : code != null && code !== 0 ? 'error' : code === 0 ? 'ready' : 'unknown';
    return { ...row, problem: code, state };
  });
  return { platform: 'win32', driverUrl, devices,
    state: !devices.length ? 'absent' : devices.some(d => d.state === 'missing') ? 'missing'
      : devices.some(d => d.state === 'error') ? 'error' : devices.some(d => d.state === 'unknown') ? 'unknown' : 'ready' };
}
const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$rows=@(Get-PnpDevice -PresentOnly -ErrorAction Stop | Where-Object { $_.InstanceId -match '^USB\\VID_0483&PID_(3748|374B|374A|3742|3752|374E|374F|3753|3754|3757)(&|\\)' } | ForEach-Object {
  $device=$_
  $props=@{}
  Get-PnpDeviceProperty -InstanceId $device.InstanceId -ErrorAction Stop | ForEach-Object { $props[$_.KeyName]=$_.Data }
  [PSCustomObject]@{ id=$device.InstanceId; name=$device.FriendlyName; status=[string]$device.Status;
    problem=$props['DEVPKEY_Device_ProblemCode']; service=$props['DEVPKEY_Device_Service'];
    provider=$props['DEVPKEY_Device_DriverProvider']; version=$props['DEVPKEY_Device_DriverVersion']; inf=$props['DEVPKEY_Device_DriverInfPath'] }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 4
`;
export async function checkStlinkDriver({ platform = process.platform, execute = run } = {}) {
  if (platform !== 'win32') return { platform, driverUrl, state: 'unsupported', devices: [] };
  try {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const { stdout } = await execute(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
    const rows = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    return summarizeDevices(Array.isArray(rows) ? rows : rows ? [rows] : []);
  } catch (error) {
    return { platform, driverUrl, state: 'unknown', devices: [], error: error.killed ? '系统设备查询超时，请稍后重试。' : '无法读取 Windows 即插即用设备信息，请检查系统权限或在设备管理器中查看。' };
  }
}
