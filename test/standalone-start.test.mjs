import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('server starts without any project and uses its bundled serial backend', { timeout: 15000 }, async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const cache = path.join(root, '.cache', `standalone-start-${process.pid}`);
  mkdirSync(cache, { recursive: true });
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PNX_WORKSPACE_ROOT: '', PNX_CACHE_ROOT: cache } });
  let output = '';
  child.stdout.on('data', data => { output += String(data); });
  child.stderr.on('data', data => { output += String(data); });
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('PnX Platform: ') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const origin = /PnX Platform: (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
    assert.ok(origin, output);
    const page = await (await fetch(origin)).text();
    const token = /window\.PNX_TOKEN = '([0-9a-f]+)'/.exec(page)?.[1];
    assert.ok(token);
    const headers = { 'X-PnX-Token': token, 'Content-Type': 'application/json' };
    const workspace = await (await fetch(`${origin}/api/workspace`, { headers })).json();
    assert.equal(workspace.root, null);
    assert.equal(workspace.projectRoot, null);
    const boards = await (await fetch(`${origin}/api/boards`, { headers })).json();
    assert.equal(boards.backend, true);
    const diagnostic = await fetch(`${origin}/api/serial-test`, { method: 'POST', headers, body: JSON.stringify({ port: 'COM999', baud: 921600 }) });
    assert.equal(diagnostic.status, 400);
    assert.match(output, /Running: pnx-dap\.exe --serial-test --port COM999/);
    const mock = await fetch(`${origin}/api/connect`, { method: 'POST', headers, body: JSON.stringify({ mock: true, rate: 1000 }) });
    const connected = await mock.json();
    assert.equal(mock.status, 200, JSON.stringify(connected));
    const snapshot = await fetch(`${origin}/api/debug/snapshot`, { method: 'POST', headers,
      body: JSON.stringify({ ids: ['mock.ramp'] }) });
    assert.equal(snapshot.status, 200);
    assert.equal((await snapshot.json()).values[0].id, 'mock.ramp');
    const invalid = await fetch(`${origin}/api/debug/snapshot`, { method: 'POST', headers,
      body: JSON.stringify({ ids: ['unlisted.address'] }) });
    assert.equal(invalid.status, 400);
  } finally {
    child.stdin.end('shutdown\n');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (child.exitCode === null) child.kill();
  }
});
