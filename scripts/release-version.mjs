import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseFiles(root, tag) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag || '')) throw new Error('Expected release tag vMAJOR.MINOR.PATCH');
  const version = tag.slice(1);
  const files = new Map();
  const packagePath = path.join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  pkg.version = version;
  files.set(packagePath, JSON.stringify(pkg, null, 2) + '\n');
  const npmLockPath = path.join(root, 'package-lock.json');
  if (existsSync(npmLockPath)) {
    const npmLock = JSON.parse(readFileSync(npmLockPath, 'utf8'));
    npmLock.version = version;
    if (npmLock.packages?.['']) npmLock.packages[''].version = version;
    files.set(npmLockPath, JSON.stringify(npmLock, null, 2) + '\n');
  }
  const cargoPath = path.join(root, 'native/Cargo.toml');
  const cargo = readFileSync(cargoPath, 'utf8');
  const workspaceVersion = /(\[workspace\.package\][\s\S]*?\bversion\s*=\s*)"[^"]+"/;
  if (!workspaceVersion.test(cargo)) throw new Error('Missing Rust workspace version');
  files.set(cargoPath, cargo.replace(workspaceVersion, `$1"${version}"`));
  const lockPath = path.join(root, 'native/Cargo.lock');
  let lock = readFileSync(lockPath, 'utf8');
  for (const name of ['pnx-core', 'pnx-probe', 'pnx-dap']) {
    const pattern = new RegExp(`(name = "${name}"\\r?\\nversion = )"[^"]+"`, 'g');
    if ([...lock.matchAll(pattern)].length !== 1) throw new Error(`Expected one lock entry for ${name}`);
    lock = lock.replace(pattern, `$1"${version}"`);
  }
  files.set(lockPath, lock);
  return files;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const tag = process.argv[2] || process.env.RELEASE_TAG;
  for (const [file, content] of releaseFiles(root, tag)) writeFileSync(file, content);
  console.log(`Release version synchronized: ${tag}`);
}
