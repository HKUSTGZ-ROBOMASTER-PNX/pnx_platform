import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { BACKEND, TEMPLATE } from '../src/paths.mjs';

const elf = path.resolve(process.argv[2] || path.join(TEMPLATE, 'build', 'h723-debug', 'pnx_embedded.elf'));
const inspected = spawnSync(BACKEND, ['--inspect-elf', elf], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, windowsHide: true });
if (inspected.status !== 0) throw new Error(inspected.stderr || inspected.error?.message || `ELF inspection exited ${inspected.status}`);
const ids = [];
function collect(items) {
  for (const item of items) {
    if (item?.id && item?.expression && !item.children?.length && (item.address !== undefined || item.pointerAddress !== undefined)) ids.push(item.id);
    if (Array.isArray(item.children)) collect(item.children);
  }
}
collect(JSON.parse(inspected.stdout));
const bodyBytes = Buffer.byteLength(JSON.stringify({ ids, rate: 1000 }));
console.log(JSON.stringify({ elf, channels: ids.length, longestId: Math.max(...ids.map(id => Buffer.byteLength(id))), subscribeBodyBytes: bodyBytes, serverLimitBytes: 2_000_000 }, null, 2));
