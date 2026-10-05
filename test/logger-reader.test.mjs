import test from 'node:test';
import assert from 'node:assert/strict';
import { readLogger } from '../src/logger-reader.mjs';

function fixture() {
  const address = 0x20001000, capacity = 3;
  const fields = [['sequence', 0, 4], ['tick', 4, 4], ['value', 8, 4],
    ['message', 12, 16], ['status', 28, 1], ['severity', 29, 1], ['length', 30, 1], ['reserved', 31, 1]];
  const catalog = [{ expression: 'pnx_log_records', address, typeName: 'array[3]',
    children: [{ address, byteWidth: 32, children: fields.map(([name, offset, byteWidth]) =>
      ({ name, address: address + offset, byteWidth })) }] }];
  const ram = Buffer.alloc(108);
  ram.writeUInt32LE(0x504e5800 | capacity, 96);
  ram.writeUInt32LE(2, 100);
  ram.writeUInt32LE(8, 104);
  for (const [index, name] of ['pnx_log_magic', 'pnx_log_boot_count', 'pnx_log_next_sequence'].entries()) {
    catalog.push({ id: name, expression: name, address: address + 96 + index * 4,
      byteWidth: 4, scalarKind: 'unsigned', typeName: 'uint32_t', children: [] });
  }
  for (const sequence of [5, 6, 7]) {
    const at = ((sequence - 1) % capacity) * 32;
    ram.writeUInt32LE(sequence, at);
    ram.writeUInt32LE(sequence * 10, at + 4);
    ram.writeInt32LE(-17, at + 8);
    ram.write('fault', at + 12);
    ram[at + 28] = 6; ram[at + 29] = 1; ram[at + 30] = 5;
  }
  let reads = 0;
  const session = { async request(command, { memoryReference, count }) {
    assert.equal(command, 'readMemory');
    ++reads;
    const at = Number(memoryReference) - address;
    return { data: ram.subarray(at, at + count).toString('base64') };
  } };
  return { catalog, ram, session, get reads() { return reads; } };
}

test('logger reads wrapped records newest first, signed context and status', async () => {
  const f = fixture(), result = await readLogger(f.session, f.catalog);
  assert.equal(result.bootCount, 2);
  assert.equal(result.capacity, 3);
  assert.equal(result.writeCount, 7);
  assert.deepEqual(result.records.map(record => record.sequence), [7, 6, 5]);
  assert.deepEqual(result.records[0], { sequence: 7, tick: 70, value: -17,
    message: 'fault', status: 'timeout', severity: 'error' });
  assert.equal(f.reads, 8);
});

test('logger empty, uninitialized and incompatible layouts are distinguished', async () => {
  const f = fixture();
  f.ram.writeUInt32LE(1, 104);
  assert.deepEqual((await readLogger(f.session, f.catalog)).records, []);
  f.ram.writeUInt32LE(0, 96);
  await assert.rejects(readLogger(f.session, f.catalog), /尚未初始化/);
  f.catalog[0].children[0].byteWidth = 64;
  await assert.rejects(readLogger(f.session, f.catalog), /布局/);
  await assert.rejects(readLogger(f.session, []), /DWARF/);
});

test('logger rejects torn bytes, changed metadata and incomplete reads', async () => {
  for (const mutation of ['bytes', 'metadata', 'short']) {
    const f = fixture(), request = f.session.request;
    let call = 0;
    f.session.request = async (...args) => {
      ++call;
      if (call === 5 && mutation === 'bytes') f.ram[12] ^= 1;
      if (call === 6 && mutation === 'metadata') f.ram[100] ^= 1;
      const result = await request(...args);
      return mutation === 'short' ? { data: '' } : result;
    };
    await assert.rejects(readLogger(f.session, f.catalog), /变化|不完整/);
  }
});

test('logger rejects unpublished slots and invalid string lengths', async () => {
  for (const offset of [0, 30]) {
    const f = fixture(); f.ram[offset] = offset === 0 ? 0 : 16;
    await assert.rejects(readLogger(f.session, f.catalog), /记录不完整/);
  }
});
