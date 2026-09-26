import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const [folder] = JSON.parse(readFileSync(path.join(root, 'dist/package-path.json'), 'utf8'));
const mac = process.platform === 'darwin';
const executable = mac ? path.join(folder, 'PnX Platform.app/Contents/MacOS/PnX Platform') : path.join(folder, 'PnX Platform');
if (mac) {
  // Local ad-hoc signature covers the bundled Rust executable too. This is not notarization.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(folder, 'PnX Platform.app')], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', path.join(folder, 'PnX Platform.app')], { stdio: 'inherit' });
}
for (const [script, args] of [
  ['electron-standalone-smoke.mjs', [executable, path.join(root, '.cache', `standalone-${process.pid}`)]],
  ['electron-ui-smoke.mjs', [executable]],
]) execFileSync(process.execPath, [path.join(root, 'scripts', script), ...args], { stdio: 'inherit' });
const release = path.join(root, 'dist/release');
mkdirSync(release, { recursive: true });
const name = `PnX-Platform-${mac ? 'macOS' : 'linux'}-${process.arch}.${mac ? 'dmg' : 'tar.gz'}`;
const archive = path.join(release, name);
if (mac) {
  execFileSync('hdiutil', ['create', '-volname', 'PnX Platform', '-srcfolder', folder, '-ov', '-format', 'UDZO', archive], { stdio: 'inherit' });
} else {
  execFileSync('tar', ['-czf', archive, '-C', path.dirname(folder), path.basename(folder)], { stdio: 'inherit' });
}
writeFileSync(path.join(release, `SHA256SUMS-${process.platform}-${process.arch}.txt`), `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${name}\n`);
