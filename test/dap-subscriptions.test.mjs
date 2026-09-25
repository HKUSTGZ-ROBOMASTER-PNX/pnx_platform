import test from 'node:test';
import assert from 'node:assert/strict';
import { DapSession } from '../src/dap.mjs';
import { fileURLToPath } from 'node:url';

test('DAP subscription keeps every requested channel up to the wire limit', async () => {
  const session = new DapSession(() => {}, () => {});
  let request;
  session.request = async (command, body) => { request = { command, body }; return {}; };
  const ids = Array.from({ length: 256 }, (_, index) => `channel-${index}`);
  await session.subscribe(ids, 5000);
  assert.equal(request.command, 'pnx/setSubscriptions');
  assert.deepEqual(request.body.ids, ids);
  assert.equal(request.body.requestedSamplesPerSecond, 5000);
  await assert.rejects(session.subscribe([...ids, 'channel-256'], 5000), /at most 256/);
  assert.deepEqual(request.body.ids, ids);
});

test('debug toolbar commands use the DAP control requests', async () => {
  const session = new DapSession(() => {}, () => {});
  let request;
  session.request = async (command, body) => { request = { command, body }; return {}; };
  for (const command of ['pause', 'continue', 'next', 'stepIn', 'stepOut']) {
    await session.debug(command);
    assert.deepEqual(request, { command, body: { threadId: 1 } });
  }
  await assert.rejects(session.debug('flash'), /Unsupported debug command/);
});

test('source breakpoints use DAP setBreakpoints and validate line limits', async () => {
  const session = new DapSession(() => {}, () => {});
  let request;
  session.request = async (command, body) => { request = { command, body }; return { breakpoints: [{ verified: true, line: 12 }] }; };
  const result = await session.setBreakpoints('D:/project/main.cpp', [12, 12, 5]);
  assert.deepEqual(request, { command: 'setBreakpoints', body: { source: { path: 'D:/project/main.cpp' }, breakpoints: [{ line: 5 }, { line: 12 }] } });
  assert.equal(result.breakpoints[0].verified, true);
  await assert.rejects(session.setBreakpoints('D:/project/main.cpp', [0]), /Invalid breakpoint lines/);
  await assert.rejects(session.setBreakpoints('D:/project/main.cpp', Array.from({ length: 65 }, (_, i) => i + 1)), /Invalid breakpoint lines/);
});

test('flash request verifies the selected artifact and resets after programming', async () => {
  const session = new DapSession(() => {}, () => {});
  let request;
  session.request = async (command, body) => { request = { command, body }; return {}; };
  const artifact = fileURLToPath(new URL('../package.json', import.meta.url));
  await session.flash(artifact);
  assert.deepEqual(request, { command: 'pnx/flash', body: { path: artifact, verify: true, resetAfter: true } });
});

test('mock DAP adapter verifies a typed scalar write without touching hardware', { timeout: 15000 }, async () => {
  const session = new DapSession(() => {}, () => {});
  try {
    const catalog = await session.start({ mock: true, rate: 1000, allowDebug: true });
    assert.ok(catalog.some(item => item.id === 'mock.ramp'));
    const result = await session.writeValue('mock.ramp', '1.25');
    assert.equal(result.verified, true);
    assert.equal(result.autoPaused, false);
  } finally { await session.stop(); }
});
