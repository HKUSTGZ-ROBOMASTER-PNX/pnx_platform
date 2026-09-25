import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProbes } from '../src/dap.mjs';

test('probe list exposes DAPLink and ST-Link selectors for UI selection', () => {
  const probes = normalizeProbes([
    { selector: 'Horco CMSIS-DAP,SN:dap', identifier: 'Horco CMSIS-DAP', serialNumber: 'dap', probeType: '"CMSIS-DAP"' },
    { selector: 'STLink V2-1,SN:st', identifier: 'STLink V2-1', serialNumber: 'st', probeType: '"ST-LINK"' },
  ]);
  assert.deepEqual(probes.map(probe => probe.family), ['CMSIS-DAP / DAPLink', 'ST-Link']);
  assert.deepEqual(probes.map(probe => probe.selector), ['Horco CMSIS-DAP,SN:dap', 'STLink V2-1,SN:st']);
  assert.throws(() => normalizeProbes({ probes: [] }), /Invalid probe list/);
});
