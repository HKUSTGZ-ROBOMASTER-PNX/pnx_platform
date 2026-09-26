import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {detectProjectTarget} from '../src/target-detection.mjs';
const fixture=()=>{const root=mkdtempSync(path.join(tmpdir(),'pnx-detect-'));mkdirSync(path.join(root,'.vscode'));writeFileSync(path.join(root,'CMakeLists.txt'),'set(CMAKE_PROJECT_NAME firmware)\nadd_executable(${CMAKE_PROJECT_NAME})\ntarget_link_options(firmware PRIVATE -T${CMAKE_SOURCE_DIR}/STM32H723XG_FLASH.ld)');writeFileSync(path.join(root,'STM32H723XG_FLASH.ld'),'/* STM32H723VGTx series */\nMEMORY {}');return root;};
const elf=(root,name)=>writeFileSync(path.join(root,name),Buffer.from([127,69,76,70,0]));
test('CMake target and referenced linker script identify target; launch is ignored',()=>{
 const root=fixture();elf(root,'firmware.elf');elf(root,'other.elf');
 writeFileSync(path.join(root,'.vscode','launch.json'),'{"configurations":[{"chip":"WRONG","programBinary":"other.elf"}]}');
 const result=detectProjectTarget(root);assert.equal(result.chip,'STM32H723VG');assert.equal(result.elf,path.join(root,'firmware.elf'));assert.equal(result.candidates.length,1);
});
test('multiple build artifacts require selection; ambiguous script name is not a chip',()=>{
 const root=fixture();elf(root,'firmware.elf');mkdirSync(path.join(root,'build'));elf(path.join(root,'build'),'firmware.elf');
 const result=detectProjectTarget(root);assert.equal(result.elf,'');assert.equal(result.ambiguous,true);
 writeFileSync(path.join(root,'STM32H723XG_FLASH.ld'),'MEMORY {}');assert.equal(detectProjectTarget(root,true).chip,'');
});
test('successful build refreshes missing ELF cache and selects that build directory',()=>{
 const root=fixture();assert.equal(detectProjectTarget(root).elf,'');
 mkdirSync(path.join(root,'Debug'));elf(path.join(root,'Debug'),'firmware.elf');
 mkdirSync(path.join(root,'Release'));elf(path.join(root,'Release'),'firmware.elf');
 const built=detectProjectTarget(root,true,path.join(root,'Debug'));
 assert.equal(built.elf,path.join(root,'Debug','firmware.elf'));assert.equal(built.ambiguous,false);
 assert.equal(detectProjectTarget(root).elf,built.elf);
});
