import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializedDeclarations, initializerEvidence, markInitializedGlobals, verifyInitializer } from '../src/initialized-globals.mjs';
import { checkedWriteValue } from '../src/global-variables.mjs';

test('initializer scan accepts explicit globals and excludes implicit, const, local, conditional and pointer declarations', () => {
  const rows = initializedDeclarations(`float gain = 1.0f;
int zero{};
int count(3);
int implicit;
const int fixed = 2;
extern int remote;
int *ptr = nullptr;
void task() { static int local = 4; }
struct State { int member = 4; };
namespace pnx { volatile uint32_t rate = 2; }
#if ENABLED
float conditional = 3;
#endif
// float commented = 5;
float final_value = 7;`);
  assert.deepEqual(rows.filter(row => row.initialized).map(row => row.name), ['gain','zero','count','pnx::rate','final_value']);
});
test('missing initializer metadata denies writes even to valid RAM scalar', () => {
  const scalar = { address: 0x20000000, byteWidth: 4, scalarKind: 'float32', typeName: 'float', writable: true };
  assert.throws(() => checkedWriteValue(scalar, '1'), /Only typed/);
  assert.equal(checkedWriteValue({ ...scalar, explicitInitializer: true }, '1'), '1');
  assert.throws(() => checkedWriteValue({ ...scalar, typeName: 'const float', explicitInitializer: true }, '1'));
});
test('initializer proof requires unique declarations, older source and unchanged content at write', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pnx-init-'));
  try {
    const file = path.join(root,'main.cpp'), elf = path.join(root,'firmware.elf');
    await writeFile(file,'float gain = 1;\nfloat implicit;'); await writeFile(elf,'fixture');
    await utimes(file, new Date(1000), new Date(1000));
    const catalog = [{ expression:'gain' }, { expression:'implicit' }, { expression:'state.member' }];
    markInitializedGlobals(catalog,await initializerEvidence(root,elf));
    assert.deepEqual(catalog.map(item=>item.explicitInitializer),[true,false,false]);
    await verifyInitializer(catalog[0]);
    await writeFile(file,'float gain;');
    await assert.rejects(verifyInitializer(catalog[0]), /已改变/);
    await writeFile(file,'float gain = 1;'); await utimes(file,new Date(1000),new Date(1000));
    await writeFile(path.join(root,'declaration.h'),'extern float gain;');
    assert.equal((await initializerEvidence(root,elf)).get('gain').initialized,true);
    await writeFile(path.join(root,'duplicate.cpp'),'float gain = 2;');
    assert.equal((await initializerEvidence(root,elf)).get('gain'),null);
  } finally { await rm(root,{recursive:true,force:true}); }
});
