import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';

export const TOOL_NAMES = ['cmake', 'ninja', 'arm'];
const armBinaries = ['arm-none-eabi-gcc', 'arm-none-eabi-g++', 'arm-none-eabi-objcopy', 'arm-none-eabi-objdump', 'arm-none-eabi-readelf', 'arm-none-eabi-size'];
const ignoredDirectories = new Set(['node_modules', '.git', 'build', 'cache', '.cache', 'temp', 'tmp', 'src', 'source', 'sources', 'include', 'lib', 'share', 'doc', 'docs']);
const binary = (name, platform) => `${name}${platform === 'win32' ? '.exe' : ''}`;

function matchesTool(directory, name, platform) {
  const files = name === 'arm' ? armBinaries : [name];
  return files.every(file => existsSync(path.join(directory, binary(file, platform))));
}
function uniquePaths(values, platform) {
  const seen = new Set();
  return values.filter(value => {
    if (typeof value !== 'string' || !value.trim()) return false;
    const normalized = path.resolve(value.trim().replace(/^"|"$/g, ''));
    const key = platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map(value => path.resolve(value.trim().replace(/^"|"$/g, '')));
}
export function pathEntries(env = process.env, platform = process.platform) {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  return uniquePaths(entry.split(platform === 'win32' ? ';' : ':'), platform);
}
function defaultRoots(env, platform, home) {
  if (platform === 'win32') return uniquePaths([
    env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    env.USERPROFILE && path.join(env.USERPROFILE, 'scoop', 'apps'), env.ChocolateyInstall,
    'C:\\ST', 'C:\\Tools', 'C:\\Apps', 'D:\\Apps', 'D:\\Tools',
  ], platform);
  return uniquePaths(['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/local', '/opt', path.join(home, '.local'), path.join(home, 'opt')], platform);
}
export function scanToolchain({ env = process.env, platform = process.platform, roots, home = os.homedir(), maxDirectories = 12000, preferRoots = false } = {}) {
  const found = {};
  const pathDirs = pathEntries(env, platform);
  const checkPath = () => { for (const directory of pathDirs) for (const name of TOOL_NAMES) {
    if (!found[name] && matchesTool(directory, name, platform)) found[name] = { directory, source: 'PATH' };
  } };
  if (!preferRoots) checkPath();
  const candidates = uniquePaths(roots ?? defaultRoots(env, platform, home), platform);
  const queue = candidates.map(directory => ({ directory, depth: 0 }));
  const visited = new Set((preferRoots ? [] : pathDirs).map(directory => platform === 'win32' ? directory.toLowerCase() : directory));
  let scannedDirectories = 0;
  for (let cursor = 0; cursor < queue.length && scannedDirectories < maxDirectories && TOOL_NAMES.some(name => !found[name]); cursor++) {
    const { directory, depth } = queue[cursor];
    const key = platform === 'win32' ? directory.toLowerCase() : directory;
    if (visited.has(key) || !existsSync(directory)) continue;
    visited.add(key); scannedDirectories++;
    for (const name of TOOL_NAMES) if (!found[name] && matchesTool(directory, name, platform)) found[name] = { directory, source: 'folder' };
    if (depth >= 8) continue;
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name.toLowerCase())) continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }
  if (preferRoots) checkPath();
  const missing = TOOL_NAMES.filter(name => !found[name]);
  return { tools: found, missing, scannedDirectories, complete: missing.length === 0 };
}
export function validateToolchain(tools, platform = process.platform) {
  if (!tools || typeof tools !== 'object') throw new Error('No toolchain scan result');
  const validated = {};
  for (const name of TOOL_NAMES) {
    const directory = tools[name]?.directory;
    if (!directory || !path.isAbsolute(directory) || !matchesTool(directory, name, platform)) throw new Error(`${name} executable not found in selected folder`);
    validated[name] = { directory: path.resolve(directory), source: tools[name].source === 'PATH' ? 'PATH' : 'folder' };
  }
  return validated;
}
function executableVersion(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['--version'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (failure, value) => { if (settled) return; settled = true; clearTimeout(timer); failure ? reject(failure) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error(`${path.basename(file)} version check timed out`)); }, 5000);
    child.stdout.on('data', data => { output += String(data); if (output.length > 8192) { child.kill(); finish(new Error('Version output too large')); } });
    child.stderr.on('data', data => { output += String(data); if (output.length > 8192) { child.kill(); finish(new Error('Version output too large')); } });
    child.on('error', finish);
    child.on('exit', code => finish(code === 0 ? null : new Error(`${path.basename(file)} failed its version check`), output));
  });
}
export async function verifyToolchain(tools, platform = process.platform) {
  const results = {};
  for (const [name, program] of [['cmake', 'cmake'], ['ninja', 'ninja'], ['arm', 'arm-none-eabi-gcc']]) {
    const output = await executableVersion(path.join(tools[name].directory, binary(program, platform)));
    results[name] = output.split(/\r?\n/)[0].trim();
  }
  const cmake = /cmake version (\d+)\.(\d+)/i.exec(results.cmake);
  if (!cmake || Number(cmake[1]) < 3 || Number(cmake[1]) === 3 && Number(cmake[2]) < 22) throw new Error(`PnX needs CMake 3.22 or newer; found ${results.cmake}`);
  return results;
}
export function toolchainPathDirectories(tools, env = process.env, platform = process.platform) {
  const present = new Set(pathEntries(env, platform).map(value => platform === 'win32' ? value.toLowerCase() : value));
  return uniquePaths(TOOL_NAMES.map(name => tools[name].directory), platform).filter(value => !present.has(platform === 'win32' ? value.toLowerCase() : value));
}
export function useToolchain(tools, env = process.env, platform = process.platform) {
  const additions = toolchainPathDirectories(tools, env, platform);
  const oldPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || '';
  const separator = platform === 'win32' ? ';' : ':';
  const chosen = uniquePaths(TOOL_NAMES.map(name => tools[name].directory), platform);
  const selected = new Set(chosen.map(value => platform === 'win32' ? value.toLowerCase() : value));
  const remaining = oldPath.split(separator).filter(value => value.trim()).filter(value => {
    const normalized = path.resolve(value.trim().replace(/^"|"$/g, ''));
    return !selected.has(platform === 'win32' ? normalized.toLowerCase() : normalized);
  });
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
  env[platform === 'win32' ? 'Path' : 'PATH'] = [...chosen, ...remaining].join(separator);
  return additions;
}
export function loadToolchain(file, env = process.env, platform = process.platform) {
  try {
    const tools = validateToolchain(JSON.parse(readFileSync(file, 'utf8')).tools, platform);
    useToolchain(tools, env, platform);
    return tools;
  } catch { return null; }
}
export function saveToolchain(file, tools) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ tools }, null, 2));
  renameSync(temporary, file);
}
export function addToWindowsUserPath(directories) {
  if (process.platform !== 'win32' || !directories.length) return Promise.resolve([]);
  const script = `$ErrorActionPreference='Stop'; $dirs = @(ConvertFrom-Json ([Console]::In.ReadToEnd())); $old = [Environment]::GetEnvironmentVariable('Path','User'); $parts = @($old -split ';' | Where-Object { $_ }); foreach ($dir in $dirs) { if (-not ($parts -contains $dir)) { $parts += $dir } }; [Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User'); Write-Output 'ok'`;
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let error = '', settled = false;
    const finish = failure => { if (settled) return; settled = true; clearTimeout(timer); failure ? reject(failure) : resolve(directories); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Writing user PATH timed out')); }, 10000);
    child.stderr.on('data', data => { error += String(data); if (error.length > 8192) error = error.slice(-8192); });
    child.on('error', finish);
    child.on('exit', code => finish(code === 0 ? null : new Error(error.trim() || `Updating user PATH failed (${code})`)));
    child.stdin.on('error', finish);
    child.stdin.end(JSON.stringify(directories));
  });
}
