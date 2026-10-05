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
    '"sample_index","robot.speed","robot,torque"',
    '1,1.25,',
    '2,2.5,',
    '3,,-3',
    '',
  ].join('\n'));
});

test('CSV records only configured channels and keeps exact relative time across batches', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pnx-csv-time-'));
  for (const timeColumn of ['elapsed_s', 'timestamp_ns']) {
    const recorder = await CsvRecorder.start(root, [{id:'b',name:'selected'}], {timeColumn});
    recorder.appendBatch({channelIds:['a'],sampleCount:1,startTimestampNsExact:'1',samplePeriodNsExact:'1',values:[99]});
    recorder.appendBatch({channelIds:['a','b'],sampleCount:2,startTimestampNsExact:'9007199254740993',samplePeriodNsExact:'1000000',values:[99,3,99,4]});
    recorder.appendBatch({channelIds:['b'],sampleCount:1,startTimestampNsExact:'9007199256740993',samplePeriodNsExact:'1000000',values:[5]});
    const result = await recorder.stop();
    assert.equal(result.rows, 3);
    assert.equal(readFileSync(result.file,'utf8'), [`"${timeColumn}","selected"`, ...(timeColumn === 'elapsed_s' ? ['0,3','0.001,4','0.002,5'] : ['9007199254740993,3','9007199255740993,4','9007199256740993,5']), ''].join('\n'));
  }
  await assert.rejects(CsvRecorder.start(root,[{id:'a',name:'a'}],{timeColumn:'invalid'}), /Invalid CSV/);
});
