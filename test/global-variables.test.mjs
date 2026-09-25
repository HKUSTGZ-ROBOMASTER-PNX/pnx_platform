import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedWriteValue, globalScalars, globalTree, writableGlobal } from '../src/global-variables.mjs';

const scalar = (id, changes = {}) => ({ id, name: id, expression: id, typeName: 'uint32_t', address: 0x20000020,
  byteWidth: 4, scalarKind: 'unsigned', writable: true, children: [], ...changes });

test('global catalog excludes pointer-derived fields and only offers typed direct RAM scalars for writing', () => {
  const global = scalar('counter');
  const member = scalar('state.speed', { address: 0x20000024 });
  const pointerChild = scalar('target->speed', { address: undefined, pointerAddress: 0x20000028 });
  const catalog = globalScalars([global, { ...scalar('state'), children: [member] },
    { ...scalar('target', { typeName: 'State *' }), children: [pointerChild] },
    scalar('untyped', { typeName: 'data[4]', address: 0x2000002c })]);
  assert.deepEqual(catalog.map(item => item.id), ['counter', 'state.speed', 'untyped']);
  assert.equal(catalog.find(item => item.id === 'untyped').writable, false);
  assert.equal(writableGlobal(global), true);
  assert.equal(writableGlobal(scalar('flash', { address: 0x08010000 })), false);
  assert.equal(writableGlobal(scalar('pointer', { typeName: 'int *' })), false);
});

test('variable write input enforces scalar width, type and finite values', () => {
  assert.equal(checkedWriteValue(scalar('counter'), '0xFFFFFFFF'), '0xFFFFFFFF');
  assert.throws(() => checkedWriteValue(scalar('counter'), '-1'), /range/);
  assert.throws(() => checkedWriteValue(scalar('counter'), '4294967296'), /range/);
  assert.equal(checkedWriteValue(scalar('signed', { typeName: 'int16_t', scalarKind: 'signed', byteWidth: 2 }), '-0x1'), '-1');
  assert.equal(checkedWriteValue(scalar('temperature', { typeName: 'float', scalarKind: 'float32' }), '1.25'), '1.25');
  assert.throws(() => checkedWriteValue(scalar('temperature', { typeName: 'float', scalarKind: 'float32' }), '1e100'), /finite/);
  assert.throws(() => checkedWriteValue(scalar('unknown', { typeName: 'data[4]' }), '1'), /Only typed/);
});

test('global tree preserves nested structure and ends at addressable leaves', () => {
  const tree = globalTree([{
    ...scalar('robot', { typeName: 'Robot' }), name: 'robot', children: [
      { ...scalar('robot.axis', { typeName: 'Axis' }), name: 'axis', children: [
        scalar('robot.axis.speed', { name: 'speed', address: 0x20000024 }),
        scalar('robot.axis.target', { name: 'target', address: undefined, pointerAddress: 0x20000028 }),
      ] },
      scalar('robot.enabled', { name: 'enabled', address: 0x2000002c }),
    ],
  }]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'robot');
  assert.equal(tree[0].children[0].name, 'axis');
  assert.deepEqual(tree[0].children[0].children.map(node => node.id), ['robot.axis.speed']);
  assert.equal(tree[0].children[1].id, 'robot.enabled');
});
