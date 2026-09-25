import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const seconds = Math.max(1, Number(process.argv[2]) || 15);
const requestedChannels = Math.max(1, Math.min(20000, Math.floor(Number(process.argv[3]) || 57)));
const mock = process.env.PNX_STRESS_MOCK === '1';
const classProfile = [
  ...[0,1,2,3].map(i => `demo_debug_instance.imu_unit.quaternion[${i}]`),
  ...['yaw','pitch','roll','total_yaw','imu_temperature'].map(name => `demo_debug_instance.imu_unit.${name}`),
  ...[0,1,2,3].map(i => `demo_debug_instance.imu_unit.tactical_quaternion[${i}]`),
  ...['tactical_yaw','tactical_pitch','tactical_roll'].map(name => `demo_debug_instance.imu_unit.${name}`),
  ...[0,1,2,3].map(i => `ahrs::service::instance::inst.output_.storage_.payload.quaternion[${i}]`),
  ...['roll','pitch','yaw','total_yaw','gyro_r','gyro_p','gyro_y','accel_x','accel_y','accel_z'].map(name => `ahrs::service::instance::inst.output_.storage_.payload.${name}`),
  ...[0,1,2,3].map(i => `ahrs::service::instance::inst.solver_.q[${i}]`),
  ...[0,1,2].map(i => `ahrs::service::instance::inst.solver_.GyroBias[${i}]`),
  ...['yaw','pitch','roll','dt'].map(name => `ahrs::service::instance::inst.solver_.${name}`),
  ...[0,1,2,3].map(i => `ahrs::ahrs_debug_service_ptr->output_.storage_.payload.quaternion[${i}]`),
  ...['roll','pitch','yaw','total_yaw'].map(name => `ahrs::ahrs_debug_service_ptr->output_.storage_.payload.${name}`),
  ...['tx_thread_id','tx_thread_run_count','tx_thread_stack_size','tx_thread_time_slice','tx_thread_new_time_slice','tx_thread_priority','tx_thread_state','tx_thread_preempt_threshold'].map(name => `_tx_thread_created_ptr->${name}`),
];
const localPointerFallback = ['tx_byte_pool_id','tx_byte_pool_available','tx_byte_pool_fragments','tx_byte_pool_size','tx_byte_pool_suspended_count','tx_byte_pool_list','tx_byte_pool_search','tx_byte_pool_start'].map(name => `_tx_byte_pool_created_ptr->${name}`);
const localDirectFallback = ['tx_thread_id','tx_thread_run_count','tx_thread_stack_size','tx_thread_time_slice','tx_thread_new_time_slice','tx_thread_priority','tx_thread_state','tx_thread_delayed_suspend','tx_thread_suspending','tx_thread_preempt_threshold','tx_thread_entry_parameter','tx_thread_suspend_info','tx_thread_suspend_option','tx_thread_suspend_status','tx_thread_user_priority','tx_thread_owned_mutex_count'].map(name => `ahrs::service::instance::inst.imu_thread_.${name}`);
const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let stdout = '', stderr = '', origin, token, connected = false;
child.stdout.on('data', bytes => { stdout += String(bytes); origin ||= /PnX Platform: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1]; });
child.stderr.on('data', bytes => { stderr += String(bytes); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const deadline = Date.now() + 12000;
  while (!origin && Date.now() < deadline) await wait(25);
  if (!origin) throw new Error(`Server did not start: ${stdout} ${stderr}`);
  const page = await (await fetch(origin)).text();
  token = /window\.PNX_TOKEN = '([0-9a-f]+)'/.exec(page)?.[1];
  if (!token) throw new Error('Missing local session token');
  const post = async (route, body) => {
    const response = await fetch(`${origin}${route}`, { method: 'POST', headers: { 'X-PnX-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(`${route}: ${result.error}`); return result;
  };
  const attached = await post('/api/connect', { mock, allowFlash: false, allowDebug: false, preset: 'h723-debug', probe: process.env.PNX_STRESS_PROBE || 'auto', speedKHz: Number(process.env.PNX_STRESS_SPEED_KHZ) || 4000, rate: Number(process.env.PNX_STRESS_RATE) || 1000 });
  connected = true;
  const byName = new Map(attached.variables.map(variable => [variable.name, variable.id]));
  const chosenProfile = process.env.PNX_STRESS_PROFILE;
  const ramAddress = address => Number.isInteger(address) && [[0x20000000, 0x20100000], [0x24000000, 0x24100000], [0x30000000, 0x30100000], [0x38000000, 0x38100000]].some(([start, end]) => address >= start && address < end);
  let names = mock ? attached.variables.slice(0, requestedChannels).map(variable => variable.name) : chosenProfile === 'ram' ? attached.variables.filter(variable => ramAddress(variable.address)).slice(0, requestedChannels).map(variable => variable.name) : chosenProfile === 'first' ? attached.variables.slice(0, requestedChannels).map(variable => variable.name) : chosenProfile === 'direct' ? [...classProfile.slice(0, 41), ...localDirectFallback].slice(0, requestedChannels) : classProfile.slice(0, requestedChannels);
  let profile = mock ? 'mock' : chosenProfile === 'ram' ? 'catalog-ram' : chosenProfile === 'first' ? 'first-catalog' : chosenProfile === 'direct' ? 'pnx-direct-57' : 'class-pointer-57';
  const classMissing = names.filter(name => !byName.has(name));
  if (classMissing.length === 8 && classMissing.every(name => name.startsWith('ahrs::ahrs_debug_service_ptr->'))) {
    names = [...names.filter(name => byName.has(name)), ...localPointerFallback]; profile = 'pnx-pointer-57';
  }
  const missing = names.filter(name => !byName.has(name));
  if (missing.length) throw new Error(`Stress profile missing ${missing.length} ELF variables, first: ${missing[0]}; nearby: ${attached.variables.filter(variable => variable.name.includes('ahrs_debug_service_ptr')).slice(0, 12).map(variable => variable.name).join(', ')}`);
  const ids = names.map(name => byName.get(name));
  if (!ids.length) throw new Error('No numeric variables in ELF catalog');
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/events?token=${token}`, { signal: controller.signal });
  const reader = response.body.getReader();
  await post('/api/subscribe', { ids, rate: Number(process.env.PNX_STRESS_RATE) || 1000 });
  const start = performance.now(); let batches = 0, samples = 0, drops = 0, buffer = '', lastTimestamp = -Infinity, timestampRegressions = 0; const finiteIds = new Set(), receivedIds = new Set(), statuses = new Set();
  const timer = setTimeout(() => controller.abort(), seconds * 1000);
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += new TextDecoder().decode(value);
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const message = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (message.startsWith('event: status\n')) { try { statuses.add(JSON.parse(message.slice(message.indexOf('data: ') + 6))); } catch { /* Ignore malformed diagnostic text. */ } continue; }
        if (!message.startsWith('event: samples\n')) continue;
        const batch = JSON.parse(message.slice(message.indexOf('data: ') + 6));
        batches++; samples += batch.sampleCount; drops = Math.max(drops, batch.droppedFrames); batch.ids.forEach(id => receivedIds.add(id));
        for (const point of batch.points) { if (point[0] < lastTimestamp) timestampRegressions++; lastTimestamp = point[0]; }
        batch.latest.forEach((value, index) => { if (Number.isFinite(value)) finiteIds.add(batch.ids[index]); });
      }
    }
  } catch (error) { if (error.name !== 'AbortError') throw error; }
  finally { clearTimeout(timer); controller.abort(); }
  const elapsed = (performance.now() - start) / 1000;
  const nonfiniteNames = names.filter((_, index) => !finiteIds.has(ids[index]));
  console.log(JSON.stringify({ probe: process.env.PNX_STRESS_PROBE || 'auto', profile, requestedChannels, catalogChannels: attached.variables.length, subscribedChannels: ids.length, receivedChannels: receivedIds.size, finiteChannels: finiteIds.size, nonfiniteCount: nonfiniteNames.length, nonfiniteNames: nonfiniteNames.slice(0, 16), statuses: [...statuses].slice(-12), durationSeconds: Number(elapsed.toFixed(2)), batches, samples, samplesPerSecond: Number((samples / elapsed).toFixed(2)), timestampRegressions, droppedFrames: drops }, null, 2));
  if (!samples || receivedIds.size !== ids.length) process.exitCode = 1;
  await post('/api/disconnect', {}); connected = false;
} catch (error) { console.error(error.stack || error.message); if (stderr) console.error(stderr); process.exitCode = 1; }
finally {
  if (connected && origin && token) { try { await fetch(`${origin}/api/disconnect`, { method: 'POST', headers: { 'X-PnX-Token': token, 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* Best effort. */ } }
  if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
}
