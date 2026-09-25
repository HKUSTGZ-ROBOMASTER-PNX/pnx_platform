import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tempRoot = realpathSync(os.tmpdir());
const stage = mkdtempSync(path.join(tempRoot, 'pnx-electron-stage-'));
try {
  const sourcePackage = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: sourcePackage.name, productName: 'PnX Platform', version: sourcePackage.version,
    private: true, type: 'module', main: 'electron/main.cjs',
  }, null, 2));
  for (const name of ['src', 'web', 'electron', 'config']) cpSync(path.join(source, name), path.join(stage, name), { recursive: true });
  cpSync(path.join(source, 'README.md'), path.join(stage, 'README.md'));
  const backend = process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap';
  const binary = path.resolve(source, '..', 'cortex-kit', 'extension', 'bin', backend);
  if (existsSync(binary)) {
    mkdirSync(path.join(stage, 'bin'));
    cpSync(binary, path.join(stage, 'bin', backend));
  } else process.stderr.write(`Cortex Kit backend not found for ${process.platform}: ${binary}\n`);

  const { default: packager } = await import('@electron/packager');
  const output = await packager({
    dir: stage, name: 'PnX Platform', electronVersion: '38.8.6',
    platform: process.platform, arch: process.arch,
    out: path.join(source, 'dist'), overwrite: false, asar: false,
  });
  for (const item of output) process.stdout.write(`Packaged: ${item}\n`);
} finally {
  const resolved = path.resolve(stage);
  if (resolved.startsWith(tempRoot + path.sep)) rmSync(resolved, { recursive: true, force: true });
}
