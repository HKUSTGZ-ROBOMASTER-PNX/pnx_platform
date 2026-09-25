import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';
import path from 'node:path';

test('configure and build API executes the selected CMake preset', { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fixture = path.join(root, '.cache', 'cmake-command-fixture');
  mkdirSync(fixture, { recursive: true });
  writeFileSync(path.join(fixture, 'CMakeLists.txt'), [
    'cmake_minimum_required(VERSION 3.21)',
    'project(pnx_command_fixture NONE)',
    'add_custom_target(firmware ALL COMMAND "${CMAKE_COMMAND}" -E touch "${CMAKE_BINARY_DIR}/firmware-built")',
    '',
  ].join('\n'));
  writeFileSync(path.join(fixture, 'CMakePresets.json'), JSON.stringify({
    version: 3,
    configurePresets: [{ name: 'h723-debug', generator: 'Ninja', binaryDir: '${sourceDir}/build/h723-debug' }],
    buildPresets: [{ name: 'h723-debug', configurePreset: 'h723-debug' }],
  }));
  mkdirSync(path.join(fixture, 'configs', 'cmake'), { recursive: true });
  writeFileSync(path.join(fixture, 'configs', 'cmake', 'export_editor_context.cmake'), '# PnX fixture\n');
  const stale = path.join(fixture, 'build', 'h723-debug', 'CMakeCache.txt');
  mkdirSync(path.dirname(stale), { recursive: true });
  writeFileSync(stale, 'CMAKE_HOME_DIRECTORY:INTERNAL=D:/Workspace/robomaster/pnx_template\n');
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PNX_TEMPLATE_ROOT: fixture, PNX_WORKSPACE_ROOT: fixture, PNX_CACHE_ROOT: path.join(fixture, 'cache') },
  });
  let output = '', errors = '';
  child.stdout.on('data', bytes => { output += String(bytes); });
  child.stderr.on('data', bytes => { errors += String(bytes); });
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('PnX Platform: ') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const origin = /PnX Platform: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    assert.ok(origin, output + errors);
    const page = await (await fetch(origin)).text();
    const token = /window\.PNX_TOKEN = '([0-9a-f]+)'/.exec(page)?.[1];
    assert.ok(token);
    const post = async (route, data = { preset: 'h723-debug' }) => {
      const response = await fetch(`${origin}${route}`, { method: 'POST',
        headers: { 'X-PnX-Token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(data) });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const built = await post('/api/build');
    assert.match(output, new RegExp(`--parallel ${Math.max(1, Math.min(8, availableParallelism()))}`));
    const configured = await post('/api/configure');
    assert.equal(built.buildDir, configured.buildDir);
    assert.ok(built.buildDir.startsWith(path.join(fixture, 'build', 'pnx-platform') + path.sep));
    assert.ok(existsSync(path.join(built.buildDir, 'firmware-built')));
    assert.equal(readFileSync(stale, 'utf8'), 'CMAKE_HOME_DIRECTORY:INTERNAL=D:/Workspace/robomaster/pnx_template\n');

    const generic = path.join(root, '.cache', `generic-workspace-fixture-${process.pid}`);
    mkdirSync(generic, { recursive: true });
    writeFileSync(path.join(generic, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.21)\nproject(generic NONE)\nadd_custom_target(generic ALL COMMAND "${CMAKE_COMMAND}" -E touch "${CMAKE_BINARY_DIR}/generic-built")\n');
    writeFileSync(path.join(generic, 'CMakePresets.json'), JSON.stringify({ version: 3, configurePresets: [
      { name: 'Debug', generator: 'Ninja', binaryDir: '${sourceDir}/build/Debug' }] }));
    await post('/api/workspace/open', { folder: generic });
    const selection = await (await fetch(`${origin}/api/workspace/build-presets`, { headers: { 'X-PnX-Token': token } })).json();
    assert.deepEqual(selection.presets, ['Debug']);
    assert.equal(selection.isPnx, false);
    const genericBuild = await post('/api/build', { preset: 'Debug' });
    assert.ok(genericBuild.buildDir.startsWith(path.join(generic, 'build', 'pnx-platform') + path.sep));
    assert.ok(existsSync(path.join(genericBuild.buildDir, 'generic-built')));
    assert.equal(genericBuild.elf, undefined);
  } finally {
    if (child.exitCode === null) {
      child.stdin.end('shutdown\n');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill();
    }
  }
});
