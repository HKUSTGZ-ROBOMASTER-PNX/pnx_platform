import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backend = process.platform === 'win32' ? 'pnx-dap.exe' : 'pnx-dap';
execFileSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(source, 'native', 'Cargo.toml'), '-p', 'pnx-dap'], { stdio: 'inherit' });
const binary = path.join(source, 'native', 'target', 'release', backend);
if (!existsSync(binary)) throw new Error(`Native backend build did not produce ${binary}`);
const tempRoot = realpathSync(os.tmpdir());
const stage = mkdtempSync(path.join(tempRoot, 'pnx-electron-stage-'));
try {
  const sourcePackage = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
    name: sourcePackage.name, productName: 'PnX Platform', version: sourcePackage.version,
    private: true, type: 'module', main: 'electron/main.cjs',
  }, null, 2));
  for (const name of ['src', 'web', 'electron', 'assets']) cpSync(path.join(source, name), path.join(stage, name), { recursive: true });
  cpSync(path.join(source, 'README.md'), path.join(stage, 'README.md'));
  mkdirSync(path.join(stage, 'bin'));
  cpSync(binary, path.join(stage, 'bin', backend));

  const { default: packager } = await import('@electron/packager');
  const output = await packager({
    dir: stage, name: 'PnX Platform', electronVersion: sourcePackage.devDependencies.electron,
    appBundleId: 'org.pnx.platform',
    platform: process.platform, arch: process.arch,
    icon: path.join(source, 'assets', process.platform === 'win32' ? 'pnx-icon.ico' : process.platform === 'darwin' ? 'pnx-icon.icns' : 'pnx-icon.png'),
    out: path.join(source, 'dist'), overwrite: false, asar: false,
  });
  for (const folder of output) {
    cpSync(path.join(source, 'README.md'), path.join(folder, 'README.md'));
    if (process.platform === 'linux') cpSync(path.join(source, 'assets/70-pnx-probes.rules'), path.join(folder, '70-pnx-probes.rules'));
  }
  writeFileSync(path.join(source, 'dist', 'package-path.json'), JSON.stringify(output));
  for (const item of output) process.stdout.write(`Packaged: ${item}\n`);
} finally {
  const resolved = path.resolve(stage);
  if (resolved.startsWith(tempRoot + path.sep)) rmSync(resolved, { recursive: true, force: true });
}
