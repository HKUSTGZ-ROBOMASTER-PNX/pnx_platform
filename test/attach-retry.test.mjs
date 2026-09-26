import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../src/server.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('  const requestedSpeed ='),source.indexOf('  next.meta ='));
async function run(errors) {
 const speeds=[], stops=[];
 const context={input:{},mock:false,probe:{selector:'fixed'},chip:'chip',elf:'test.elf',session:null,catalog:[],onBatch(){},status(){},sendEvent(){},setTimeout:fn=>fn(),
 DapSession:class {async start(options){speeds.push(options.speedKHz); const error=errors.shift();if(error)throw Error(error);return []; }},async stopSession(){stops.push(true);}};
 try {await vm.runInNewContext(`(async()=>{${body}})()`,context);return {speeds,stops};}catch(error){return {speeds,stops,error};}
}
test('NoAcknowledge retries with fresh sessions at lower SWD speeds',async()=>{
 const result=await run(['Arm(Dap(NoAcknowledge))','Arm(Dap(NoAcknowledge))']);
 assert.deepEqual(result.speeds,[4000,1000,400]);assert.equal(result.stops.length,2);assert.equal(result.error,undefined);
});
test('USB disconnection stops retries immediately',async()=>{
 const result=await run(['ConnectionAborted Disconnected']);assert.deepEqual(result.speeds,[4000]);assert.match(result.error.message,/USB/);
});
test('Other attach errors are not retried',async()=>{
 const result=await run(['ELF invalid']);assert.deepEqual(result.speeds,[4000]);assert.match(result.error.message,/ELF invalid/);
});
