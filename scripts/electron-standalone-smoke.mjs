import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const executable = process.argv[2];
const dataRoot = process.argv[3];
if (!executable || !dataRoot) throw new Error('Pass a packaged executable and an empty data directory');
mkdirSync(dataRoot, { recursive: true });
const portServer = net.createServer();
portServer.listen(0, '127.0.0.1');
await once(portServer, 'listening');
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));

const child = spawn(path.resolve(executable), [`--remote-debugging-port=${port}`], {
  cwd: path.dirname(path.resolve(executable)), windowsHide: true, stdio: 'ignore',
  env: { ...process.env, PNX_WORKSPACE_ROOT: '', PNX_DESKTOP_DATA_ROOT: path.resolve(dataRoot),
    PNX_ELECTRON_TEST_MODE: '1', PNX_ELECTRON_AUTOCLOSE_MS: '30000' },
});
let socket;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let target;
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Packaged app exited early: ${child.exitCode}`);
    try {
      const entries = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = entries.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
      if (target) break;
    } catch { /* Electron is starting. */ }
    await pause(100);
  }
  assert.ok(target, 'Packaged app did not open a local workbench page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const result = JSON.parse(event.data);
    if (!pending.has(result.id)) return;
    const { resolve, reject } = pending.get(result.id);
    pending.delete(result.id);
    result.error ? reject(new Error(result.error.message)) : resolve(result.result);
  });
  const evaluate = expression => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  }).then(result => {
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  });
  const readyAt = Date.now() + 10000;
  while (Date.now() < readyAt && !(await evaluate('typeof state !== "undefined" && Boolean(document.querySelector("#mock") && state.boards)'))) await pause(100);
  assert.equal(await evaluate('state.workspace'), null);
  assert.equal(await evaluate('state.projectRoot'), null);
  assert.equal(await evaluate('typeof window.PNXDesktop.chooseFolder'), 'function');
  assert.equal(await evaluate('Boolean(document.querySelector("#mock"))'), true);
  const result = await evaluate('(async () => { await connect(true, false); return { connected: state.connected, variables: state.variables.length }; })()');
  assert.equal(result.connected, true);
  assert.ok(result.variables > 0, 'Bundled Rust backend did not expose mock variables');
  console.log(`Standalone Electron passed: empty workspace, folder picker, ${result.variables} mock variables`);
} finally {
  socket?.close();
  if (child.exitCode === null) child.kill();
  await Promise.race([once(child, 'exit'), pause(3000)]);
}
