import test from 'node:test';
import assert from 'node:assert/strict';
import { DapSession, resolveProbeSelection } from '../src/dap.mjs';

test('a removed DAPLink selector moves to the sole ST-Link for read-only sampling', () => {
  const probes = [{ selector: 'STLink V2-1,SN:123' }];
  assert.deepEqual(resolveProbeSelection(probes, 'CMSIS-DAP,SN:old'), { selector: probes[0].selector, changed: true });
  assert.throws(() => resolveProbeSelection(probes, 'CMSIS-DAP,SN:old', true), /select the new probe/);
  assert.deepEqual(resolveProbeSelection(probes, probes[0].selector), { selector: probes[0].selector, changed: false });
  assert.throws(() => resolveProbeSelection([...probes, { selector: 'CMSIS-DAP,SN:new' }], 'CMSIS-DAP,SN:old'), /Multiple probes/);
});

test('old adapter process exits before a new probe session starts sampling', { timeout: 15000 }, async () => {
  const first = new DapSession(() => {}, () => {});
  const second = new DapSession(() => {}, () => {});
  try {
    await first.start({ mock: true, rate: 1000 });
    await first.subscribe(['mock.ramp'], 1000);
    await first.stop();
    assert.ok(first.child.exitCode !== null || first.child.signalCode !== null, 'old adapter process is still running');
    let sampled = false;
    second.onBatch = batch => { if (batch.sampleCount && batch.channelIds.includes('mock.ramp')) sampled = true; };
    await second.start({ mock: true, rate: 1000 });
    await second.subscribe(['mock.ramp'], 1000);
    const deadline = Date.now() + 3000;
    while (!sampled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(sampled, true);
  } finally { await first.stop(); await second.stop(); }
});
