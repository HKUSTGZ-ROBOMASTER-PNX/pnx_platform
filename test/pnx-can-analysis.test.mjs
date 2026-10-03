import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

test('CAN host rates use elapsed time and reset after a target restart', () => {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web/plugins/pnx/diagnostics.js');
  const context = vm.createContext({});
  vm.runInContext(`${readFileSync(file, 'utf8')}\nthis.canRates = canRates;`, context);
  const rows = (count, rx, tx, cel) => [
    { name: 'can_diag_sample_count', value: count },
    { name: 'can_diag_bus[0].rx_frames_total', value: rx },
    { name: 'can_diag_bus[0].tx_attempts_total', value: tx },
    { name: 'can_diag_bus[0].cel_total', value: cel },
  ];
  assert.equal(context.canRates(rows(1, 10, 5, 0), 'can0', 1000), null);
  const first = context.canRates(rows(2, 30, 9, 2), 'can0', 3000);
  assert.equal(first.rx, 10);
  assert.equal(first.tx, 2);
  assert.equal(first.cel, 1);
  assert.equal(context.canRates(rows(1, 0, 0, 0), 'can0', 4000), null);
  assert.equal(context.canRates(rows(2, 3, 1, 0), 'can0', 5000).rx, 3);
});
