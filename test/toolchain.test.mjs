import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { scanToolchain, validateToolchain, toolchainPathDirectories, useToolchain, saveToolchain, loadToolchain } from '../src/toolchain.mjs';

test('Unix tool lookup rejects same-named directories on every host', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pnx-unix-tools-'));
  try {
    for (const name of ['cmake', 'ninja']) {
      mkdirSync(path.join(root, name, 'bin'), { recursive: true });
      writeFileSync(path.join(root, name, 'bin', name), 'fixture');
    }
    for (const platform of ['linux', 'darwin']) {
      const result = scanToolchain({ platform, env: {}, roots: [root] });
      assert.equal(result.tools.cmake.directory, path.join(root, 'cmake', 'bin'));
      assert.equal(result.tools.ninja.directory, path.join(root, 'ninja', 'bin'));
    }
  } finally {
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) rmSync(root, { recursive: true });
  }
});

test('toolchain setup checks PATH, scans folders, and persists app configuration', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pnx-toolchain-test-'));
  try {
    const bins = Object.fromEntries(['cmake', 'ninja', 'arm'].map(name => [name, path.join(root, name, 'bin')]));
    for (const directory of Object.values(bins)) mkdirSync(directory, { recursive: true });
    const suffix = process.platform === 'win32' ? '.exe' : '';
    for (const [name, files] of Object.entries({ cmake: ['cmake'], ninja: ['ninja'], arm: [
      'arm-none-eabi-gcc', 'arm-none-eabi-g++', 'arm-none-eabi-objcopy', 'arm-none-eabi-objdump', 'arm-none-eabi-readelf', 'arm-none-eabi-size'] })) {
      for (const file of files) writeFileSync(path.join(bins[name], file + suffix), 'fixture');
    }
    const separator = process.platform === 'win32' ? ';' : ':';
    const env = { [process.platform === 'win32' ? 'Path' : 'PATH']: bins.cmake };
    const result = scanToolchain({ env, roots: [root], maxDirectories: 100 });
    assert.equal(result.complete, true);
    assert.equal(result.tools.cmake.source, 'PATH');
    assert.equal(result.tools.arm.source, 'folder');
    const preferred = scanToolchain({ env, roots: [root], preferRoots: true, maxDirectories: 100 });
    assert.equal(preferred.tools.cmake.source, 'folder');
    assert.deepEqual(validateToolchain(result.tools), result.tools);
    assert.deepEqual(toolchainPathDirectories(result.tools, env).sort(), [bins.ninja, bins.arm].sort());
    useToolchain(result.tools, env);
    assert.equal(Object.values(env)[0].split(separator)[0], bins.cmake);
    assert.ok(Object.values(env)[0].split(separator).includes(bins.arm));
    const config = path.join(root, 'config', 'toolchain.json');
    saveToolchain(config, result.tools);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).tools, result.tools);
    assert.deepEqual(loadToolchain(config, { [process.platform === 'win32' ? 'Path' : 'PATH']: bins.cmake }), result.tools);
  } finally {
    const resolved = path.resolve(root), tempRoot = path.resolve(os.tmpdir());
    if (resolved.startsWith(tempRoot + path.sep)) rmSync(resolved, { recursive: true });
  }
});
