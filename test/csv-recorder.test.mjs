import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CsvRecorder } from '../src/csv-recorder.mjs';

test('CSV recording preserves every sample and leaves empty cells for rotated banks', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pnx-csv-'));
  const recorder = await CsvRecorder.start(root, [
    { id: 'a', name: 'robot.speed' }, { id: 'b', name: 'robot,torque' },
  ]);
  recorder.appendBatch({ channelIds: ['a'], sampleCount: 2, startTimestampNsExact: '9007199254740993',
    samplePeriodNsExact: '100', values: [1.25, 2.5] });
  recorder.appendBatch({ channelIds: ['b'], sampleCount: 1, startTimestampNsExact: '9007199254741193',
    samplePeriodNsExact: '100', values: [-3] });
  const result = await recorder.stop();
  assert.equal(result.rows, 3);
  assert.equal(readFileSync(result.file, 'utf8'), [
    '"timestamp_ns","robot.speed","robot,torque"',
    '9007199254740993,1.25,',
    '9007199254741093,2.5,',
    '9007199254741193,,-3',
    '',
  ].join('\n'));
});
