import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { releaseFiles } from '../scripts/release-version.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
test('release tag sets application and all internal Rust versions without changing dependencies', () => {
  const files = releaseFiles(root, 'v7.8.9');
  assert.equal(JSON.parse(files.get(path.join(root, 'package.json'))).version, '7.8.9');
  const npmLock = JSON.parse(files.get(path.join(root, 'package-lock.json')));
  assert.equal(npmLock.version, '7.8.9');
  assert.equal(npmLock.packages[''].version, '7.8.9');
  assert.match(files.get(path.join(root, 'native/Cargo.toml')), /\[workspace.package\]\s+version = "7.8.9"/);
  const lock = files.get(path.join(root, 'native/Cargo.lock'));
  for (const name of ['pnx-core', 'pnx-probe', 'pnx-dap']) assert.ok(lock.includes(`name = "${name}"\nversion = "7.8.9"`) || lock.includes(`name = "${name}"\r\nversion = "7.8.9"`));
  assert.equal((lock.match(/version = "7.8.9"/g) || []).length, 3);
  for (const tag of [undefined, 'main', 'v01.2.3', 'v1.2', '1.2.3', 'v1.2.3\n']) assert.throws(() => releaseFiles(root, tag));
});
