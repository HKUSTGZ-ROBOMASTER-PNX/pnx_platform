import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.mjs';
import { loadWatchConfig, saveWatchConfig, validateWatchConfig } from '../src/watch-config.mjs';

const config = () => ({format:'pnx-watch',version:1,groups:[{id:'imu',name:'IMU'}],plots:[{id:'plot-1',name:'角度',groupId:'imu',seconds:5}],variables:[{expression:'robot.yaw',plotId:'plot-1'},{expression:'gain',plotId:'watch-only'}],activeGroup:'imu',columns:2,seconds:10,rate:1000});
test('capture configuration survives saving and rejects invalid options', () => {
  const input = {...config(),capture:{excluded:['gain'],sampleExcluded:['robot.yaw'],timeColumn:'sample_index'}};
  assert.deepEqual(validateWatchConfig(input),input);
  assert.throws(() => validateWatchConfig({...input,capture:{excluded:[12],timeColumn:'sample_index'}}));
  assert.throws(() => validateWatchConfig({...input,capture:{excluded:[],timeColumn:'invalid'}}));
  assert.throws(() => validateWatchConfig({...input,capture:{excluded:[],sampleExcluded:[null],timeColumn:'sample_index'}}));
});
test('watch files round-trip per workspace without addresses and preserve watch-only assignments', () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'pnx-watch-'));
  try {
    const workspace=new Workspace(root);
    assert.equal(loadWatchConfig(workspace),null);
    const input=config(); input.variables[0].address=0x20000000;
    const result=saveWatchConfig(workspace,input);
    assert.equal(result.path,path.join(workspace.root,'pnx-watch.json'));
    assert.deepEqual(loadWatchConfig(workspace),config());
    assert.equal(readFileSync(result.path,'utf8').includes('address'),false);
    input.variables=[]; saveWatchConfig(workspace,input);
    assert.deepEqual(loadWatchConfig(workspace).variables,[]);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
test('watch files reject unsupported versions, missing plot references and duplicate names', () => {
  assert.throws(()=>validateWatchConfig({...config(),version:2}));
  assert.throws(()=>validateWatchConfig({...config(),variables:[{expression:'yaw',plotId:'missing'}]}));
  assert.throws(()=>validateWatchConfig({...config(),variables:[config().variables[0],config().variables[0]]}));
  assert.throws(()=>validateWatchConfig({...config(),plots:[]}));
  assert.throws(()=>validateWatchConfig({...config(),rate:Infinity}));
  assert.throws(()=>validateWatchConfig({...config(),variables:[{expression:'yaw',plotId:'plot-1',color:'red'}]}));
});
test('watch files preserve normalized custom curve colors', () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'pnx-watch-color-'));
  try {
    const input=config(); input.variables[0].color='#A1B2C3';
    const expected={color:'#a1b2c3',expression:'robot.yaw',plotId:'plot-1'};
    assert.deepEqual(validateWatchConfig(input).variables[0],expected);
    saveWatchConfig(new Workspace(root),input);
    assert.deepEqual(loadWatchConfig(new Workspace(root)).variables[0],expected);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
