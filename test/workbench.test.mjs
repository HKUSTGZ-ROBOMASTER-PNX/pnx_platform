import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

test('standalone workbench loads board resources and streams mock samples', { timeout: 20000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const fixture = path.join(root, '.cache', `workbench-fixture-${process.pid}`);
  const boardDir = path.join(fixture, 'configs', 'boards', 'h723_mc02');
  mkdirSync(boardDir, { recursive: true });
  writeFileSync(path.join(fixture, 'CMakePresets.json'), JSON.stringify({ version: 3, configurePresets: [{ name: 'h723-debug' }] }));
  writeFileSync(path.join(boardDir, 'params.json'), JSON.stringify({ build: { usbx: false }, bindings: {} }));
  writeFileSync(path.join(boardDir, 'robot.json'), JSON.stringify({ devices: { motors: { list: [{ model: 'dji_m3508', name: 'test' }] } } }));
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PNX_WORKSPACE_ROOT: fixture, PNX_CACHE_ROOT: path.join(fixture, 'cache') } });
  let output = '';
  child.stdout.on('data', value => { output += String(value); });
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('PnX Platform: ') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    const origin = /PnX Platform: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    assert.ok(origin, output);
    const page = await (await fetch(origin)).text();
    const token = /window\.PNX_TOKEN = '([0-9a-f]+)'/.exec(page)?.[1];
    assert.ok(token);
    const get = async name => {
      const response = await fetch(`${origin}${name}`, { headers: { 'X-PnX-Token': token } });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const post = async (name, value) => {
      const response = await fetch(`${origin}${name}`, { method: 'POST', headers: { 'X-PnX-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const boards = await get('/api/boards'); assert.ok(boards.backend);
    const board = await get('/api/board?board=h723_mc02');
    assert.ok(board.hardware.can.includes('fdcan1'));
    assert.ok(board.config.robot.value.devices.motors.list.length);
    const folder = path.join(fileURLToPath(new URL('..', import.meta.url)), '.cache', 'editor-test');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'sample.txt'), 'before\n');
    const opened = await post('/api/workspace/open', { folder });
    assert.equal(opened.root, folder);
    const toolchainStatus = await get('/api/toolchain/status');
    assert.ok(Object.hasOwn(toolchainStatus, 'configured'));
    const toolchainScan = await get(`/api/toolchain/scan?folder=${encodeURIComponent(folder)}`);
    assert.ok(Array.isArray(toolchainScan.missing));
    assert.ok((await get('/api/workspace/list')).entries.some(entry => entry.name === 'sample.txt'));
    const file = await get('/api/workspace/file?path=sample.txt');
    assert.equal(file.text, 'before\n');
    await post('/api/workspace/file', { path: 'sample.txt', text: 'after\n', expectedHash: file.hash });
    assert.equal((await get('/api/workspace/file?path=sample.txt')).text, 'after\n');
    const escape = await fetch(`${origin}/api/workspace/file?path=../package.json`, { headers: { 'X-PnX-Token': token } });
    assert.equal(escape.status, 400);
    const session = await post('/api/connect', { mock: true, preset: 'h723-debug', rate: 1000 });
    assert.ok(session.variables.some(value => value.id === 'mock.ramp'));
    const writeInMock = await fetch(`${origin}/api/write-variable`, { method: 'POST', headers: { 'X-PnX-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'mock.ramp', value: '1' }) });
    assert.equal(writeInMock.status, 400);
    assert.match((await writeInMock.json()).error, /real target/);
    await post('/api/subscribe', { ids: ['mock.ramp'], rate: 1000 });
    const response = await fetch(`${origin}/api/events?token=${token}`);
    const reader = response.body.getReader();
    const expires = Date.now() + 5000;
    let stream = '';
    while (!stream.includes('event: samples') && Date.now() < expires) {
      const result = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error('samples timed out')), 5000))]);
      assert.equal(result.done, false);
      stream += new TextDecoder().decode(result.value);
    }
    assert.match(stream, /event: samples/);
    const reattached = await post('/api/connect', { mock: true, preset: 'h723-debug', rate: 1000 });
    assert.ok(reattached.variables.some(value => value.id === 'mock.ramp'));
    const switched = await Promise.all([
      post('/api/connect', { mock: true, preset: 'h723-debug', rate: 1000 }),
      post('/api/connect', { mock: true, preset: 'h723-debug', rate: 1000 }),
    ]);
    assert.ok(switched.every(value => value.variables.some(variable => variable.id === 'mock.ramp')));
    await post('/api/subscribe', { ids: ['mock.ramp'], rate: 1000 });
    const active = await get('/api/catalog');
    assert.equal(active.connected, true);
    assert.deepEqual(active.selected, ['mock.ramp']);
    const invalidRecording = await fetch(`${origin}/api/record/start`, {method:'POST',headers:{'X-PnX-Token':token,'Content-Type':'application/json'},body:JSON.stringify({ids:['missing']})});
    assert.equal(invalidRecording.status,400);
    await post('/api/record/start',{ids:['mock.ramp'],timeColumn:'sample_index'});
    await new Promise(resolve => setTimeout(resolve,150));
    const recorded = await post('/api/record/stop',{});
    assert.ok(recorded.rows > 0);
    const csv = await (await fetch(`${origin}/api/record/csv`,{headers:{'X-PnX-Token':token}})).text();
    assert.match(csv,/^"sample_index",[^\n]+\n1,/);
    reader.cancel();
    await post('/api/disconnect', {});
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  }
});
