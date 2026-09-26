import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProjectSettings,resolveTarget} from '../src/project-settings.mjs';

test('generic targets resolve arbitrary ELF names without PnX presets',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'pnx-generic-')),store=new ProjectSettings(path.join(root,'cache'));
 const profile=store.load(root);assert.equal(profile.plugins.pnx,false);
 profile.target={chip:'STM32F407VG',elf:'out/custom.elf',buildBeforeDebug:false};
 store.save(root,profile);
 const target=resolveTarget(root,store.load(root),'',()=>{throw Error('Must not require CMake');});
 assert.equal(target.chip,'STM32F407VG');assert.equal(target.elf,path.join(root,'out/custom.elf'));
 assert.throws(()=>resolveTarget(root,store.load(null),'',()=>{}),/芯片型号/);
});
test('PnX can be disabled per workspace without editing firmware sources',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'pnx-plugin-')),store=new ProjectSettings(path.join(root,'cache'));
 mkdirSync(path.join(root,'configs','boards'),{recursive:true});writeFileSync(path.join(root,'CMakePresets.json'),'{}');
 let profile=store.load(root);assert.equal(profile.plugins.pnx,true);
 assert.equal(resolveTarget(root,profile,'h723-debug',()=>'/build').chip,'STM32H723VG');
 profile.plugins.pnx=false;store.save(root,profile);assert.equal(store.load(root).plugins.pnx,false);
 assert.equal(readFileSync(path.join(root,'CMakePresets.json'),'utf8'),'{}');
 assert.throws(()=>resolveTarget(root,store.load(root),'h723-debug',()=>'/build'),/芯片型号/);
 assert.throws(()=>store.validate({build:{args:'shell text'}}),/array/);
});
