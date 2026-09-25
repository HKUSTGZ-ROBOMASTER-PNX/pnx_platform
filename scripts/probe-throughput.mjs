import path from 'node:path';
import { existsSync } from 'node:fs';
import { DapSession } from '../src/dap.mjs';
import { globalScalars } from '../src/global-variables.mjs';

const elf = process.argv[2] && path.resolve(process.argv[2]);
const channels = Math.max(1, Math.min(256, Number(process.argv[3]) || 57));
const seconds = Math.max(1, Number(process.argv[4]) || 10);
if (!elf || !existsSync(elf)) throw new Error('Pass an existing ELF path');
const statuses = [];
let samples = 0, droppedFrames = 0;
const observed = new Set();
const session = new DapSession(batch => {
  samples += batch.sampleCount;
  droppedFrames = Math.max(droppedFrames, batch.droppedFrames);
  batch.channelIds.forEach(id => observed.add(id));
}, message => { if (message) statuses.push(message); }, () => {}, {
  backend: process.env.PNX_BENCH_BACKEND,
  prefix: process.env.PNX_BENCH_PREFIX,
  adapterId: process.env.PNX_BENCH_ADAPTER,
});
const ram = address => Number.isInteger(address) &&
  [[0x20000000, 0x20100000], [0x24000000, 0x24100000], [0x30000000, 0x30100000], [0x38000000, 0x38100000]]
    .some(([start, end]) => address >= start && address < end);
try {
  const catalog = await session.start({ chip: 'STM32H723VG', elf, probe: process.env.PNX_PROBE || 'auto',
    speedKHz: 4000, rate: 1000, allowFlash: false, allowDebug: false });
  const selected = globalScalars(catalog).filter(item => ram(item.address)).slice(0, channels);
  if (selected.length !== channels) throw new Error(`Only ${selected.length} direct RAM scalars found`);
  await session.subscribe(selected.map(item => item.id), 1000);
  const start = performance.now();
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const duration = (performance.now() - start) / 1000;
  const result = { channels, observedChannels: observed.size, seconds: Number(duration.toFixed(2)), samples,
    samplesPerSecond: Number((samples / duration).toFixed(1)), droppedFrames, statuses: statuses.slice(-8) };
  console.log(JSON.stringify(result, null, 2));
  if (!samples || observed.size !== channels || droppedFrames) process.exitCode = 1;
} finally { await session.stop(); }
