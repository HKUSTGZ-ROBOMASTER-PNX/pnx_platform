import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('graphical configuration edits JSON with revision checks and board resources', { timeout: 30000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fixture = path.join(root, '.cache', `config-editor-fixture-${process.pid}`);
  const boardDir = path.join(fixture, 'configs', 'boards', 'h723_mc02');
  const cmakeDir = path.join(fixture, 'configs', 'cmake');
  mkdirSync(boardDir, { recursive: true }); mkdirSync(cmakeDir, { recursive: true });
  writeFileSync(path.join(boardDir, 'params.json'), JSON.stringify({ build: { usbx: false }, bindings: {}, custom: { gain: 42 } }, null, 2));
  writeFileSync(path.join(boardDir, 'robot.json'), JSON.stringify({ devices: { motors: { list: [] } } }, null, 2));
  writeFileSync(path.join(fixture, 'CMakePresets.json'), JSON.stringify({ version: 3, configurePresets: [{ name: 'h723-debug', generator: 'Ninja' }] }));
  const context = { formatVersion: 1, board: 'h723_mc02', files: {}, mcuFamily: 'stm32h7', hardware: {
    can: ['fdcan1'], uart: ['usart1'], spi: [], adc: [], gpio: [], gpio_input: [], gpio_output: [], gpio_input_role: [], gpio_output_role: [], pwm: [], usb: false } };
  writeFileSync(path.join(cmakeDir, 'export_editor_context.cmake'), `file(WRITE "\${PNX_EDITOR_OUTPUT}" [==[${JSON.stringify(context)}]==])\n`);
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, windowsHide: true, stdio: ['pipe','pipe','pipe'],
    env: { ...process.env, PNX_TEMPLATE_ROOT: fixture, PNX_WORKSPACE_ROOT: fixture, PNX_CACHE_ROOT: path.join(fixture, 'cache') } });
  let output = '', errors = '';
  child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { errors += String(data); });
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('PnX Platform: ') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const origin = /PnX Platform: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    assert.ok(origin, output + errors);
    const token = /window\.PNX_TOKEN = '([0-9a-f]+)'/.exec(await (await fetch(origin)).text())?.[1];
    assert.ok(token);
    const request = async (route, data) => {
      const response = await fetch(origin + route, { method: data ? 'POST' : 'GET', headers: { 'X-PnX-Token': token, 'Content-Type': 'application/json' }, body: data && JSON.stringify(data) });
      return { status: response.status, value: await response.json() };
    };
    const state = (await request('/api/config-editor/state?board=h723_mc02&role=params')).value;
    assert.ok(state.fields.some(field => field.path.join('.') === 'build.usbx'));
    assert.deepEqual(state.context.hardware.can, ['fdcan1']);
    const changed = await request('/api/config-editor/action', { board: 'h723_mc02', role: 'params', preset: 'h723-debug', version: state.version,
      action: 'set', path: ['build','usbx'], value: true });
    assert.equal(changed.status, 200, JSON.stringify(changed.value));
    assert.equal(JSON.parse(readFileSync(path.join(boardDir, 'params.json'))).build.usbx, true);
    assert.equal(JSON.parse(readFileSync(path.join(boardDir, 'params.json'))).custom.gain, 42);
    const stale = await request('/api/config-editor/action', { board: 'h723_mc02', role: 'params', preset: 'h723-debug', version: state.version,
      action: 'set', path: ['build','usbx'], value: false });
    assert.equal(stale.status, 400);
    assert.match(stale.value.error, /changed on disk/);
    const bound = await request('/api/config-editor/action', { board: 'h723_mc02', role: 'params', preset: 'h723-debug', version: changed.value.version,
      action: 'binding', operation: 'add', kind: 'can_buses', name: 'test_can', resource: 'fdcan1' });
    assert.equal(bound.status, 200, JSON.stringify(bound.value));
    assert.equal(JSON.parse(readFileSync(path.join(boardDir, 'params.json'))).bindings.can_buses.test_can, 'fdcan1');
    assert.ok(existsSync(path.join(fixture, 'cache', 'resources-h723_mc02.json')));
  } finally {
    if (child.exitCode === null) {
      child.stdin.end('shutdown\n');
      await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (child.exitCode === null) child.kill();
    }
  }
});
