import { spawn } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { BACKEND, ROOT } from './paths.mjs';

export function normalizeProbes(value) {
  if (!Array.isArray(value)) throw new Error('Invalid probe list');
  return value.filter(item => item && typeof item.selector === 'string' && item.selector.length > 0).map(item => {
    const type = String(item.probeType || '').replaceAll('"', '');
    const family = /cmsis.dap/i.test(type) || /cmsis.dap|daplink/i.test(String(item.identifier || '')) ? 'CMSIS-DAP / DAPLink'
      : /st.link/i.test(type) || /st.link/i.test(String(item.identifier || '')) ? 'ST-Link' : type || 'Other';
    return { selector: item.selector, identifier: String(item.identifier || item.selector), serialNumber: item.serialNumber || null, family };
  });
}

export function resolveProbeSelection(probes, requested, allowTargetChanges = false) {
  if (!probes.length) throw new Error('No ST-Link or CMSIS-DAP probe found');
  const selector = String(requested || 'auto').trim() || 'auto';
  if (selector !== 'auto' && probes.some(probe => probe.selector === selector)) return { selector, changed: false };
  if (probes.length > 1) throw new Error('Multiple probes are connected; scan and select the probe to use');
  if (selector !== 'auto' && allowTargetChanges) throw new Error('Selected probe is no longer connected; scan and select the new probe before debug or flash');
  return { selector: probes[0].selector, changed: selector !== 'auto' };
}

export function listProbes() {
  return new Promise((resolve, reject) => {
    const child = spawn(BACKEND, ['--list-probes'], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', error = '', settled = false;
    const finish = (failure, value) => { if (settled) return; settled = true; clearTimeout(timer); failure ? reject(failure) : resolve(value); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Probe scan timed out')); }, 10000);
    child.stdout.on('data', data => { output += String(data); if (output.length > 1024 * 1024) { child.kill(); finish(new Error('Probe list too large')); } });
    child.stderr.on('data', data => { error += String(data); if (error.length > 8192) error = error.slice(-8192); });
    child.on('error', failure => finish(failure));
    child.on('exit', code => {
      if (settled) return;
      if (code !== 0) { finish(new Error(error.trim() || `Probe scan failed (${code})`)); return; }
      try { finish(null, normalizeProbes(JSON.parse(output))); } catch (failure) { finish(failure); }
    });
  });
}

export class DapSession {
  constructor(onBatch, onStatus, onDebugEvent = () => {}, adapter = {}) {
    this.onBatch = onBatch;
    this.onStatus = onStatus;
    this.onDebugEvent = onDebugEvent;
    this.backend = adapter.backend || BACKEND;
    this.prefix = adapter.prefix || 'pnx';
    this.adapterId = adapter.adapterId || 'pnx';
    this.pending = new Map();
    this.waiters = [];
    this.events = [];
    this.seq = 1;
    this.input = Buffer.alloc(0);
    this.sampleInput = Buffer.alloc(0);
    this.ids = [];
    this.closed = false;
  }

  async start(options) {
    this.child = spawn(this.backend, options.mock ? ['--mock'] : [], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise(resolve => this.child.once('close', resolve));
    this.child.stdout.on('data', data => this.acceptDap(data));
    this.child.stderr.on('data', data => this.onStatus(String(data).trim()));
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Adapter exited: ${signal ?? code}`)));
    await this.request('initialize', { adapterID: this.adapterId });
    await this.request('attach', {
      chip: options.mock ? 'Cortex-M Mock' : options.chip,
      mockProbe: !!options.mock,
      programBinary: options.elf,
      stopOnEntry: false,
      plotOnly: !(options.allowFlash || options.allowDebug),
      probe: { selector: options.probe || 'auto', protocol: 'swd', speedKHz: options.speedKHz || 4000, connectUnderReset: false },
      flashing: { enabled: false, verify: false, resetAfter: false },
      acquisition: { requestedSamplesPerSecond: options.rate, historySeconds: 30 },
    }, 30000);
    const ready = await this.event(`${this.prefix}.dataChannelReady`);
    const catalog = await this.request(`${this.prefix}/getCatalog`);
    await this.openSamples(ready.body);
    await this.request('configurationDone');
    this.onStatus('Attached; sample stream connected');
    return catalog.variables ?? [];
  }

  request(command, args = {}, timeoutMs = 10000) {
    if (this.closed) return Promise.reject(new Error('Session closed'));
    const seq = this.seq++;
    const data = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }));
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`), data]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(seq); reject(new Error(`${command} timed out`)); }, timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      this.child.stdin.write(frame, error => { if (error) { clearTimeout(timer); this.pending.delete(seq); reject(error); } });
    });
  }

  event(name, timeoutMs = 10000) {
    const index = this.events.findIndex(value => value.event === name);
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(value => value.resolve !== resolve); reject(new Error(`${name} timed out`)); }, timeoutMs);
      this.waiters.push({ name, resolve, reject, timer });
    });
  }

  acceptDap(data) {
    this.input = Buffer.concat([this.input, data]);
    while (true) {
      const end = this.input.indexOf('\r\n\r\n');
      if (end < 0) return;
      const header = this.input.subarray(0, end).toString();
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > 16 * 1024 * 1024) { this.fail(new Error('Invalid DAP frame length')); return; }
      if (this.input.length < end + 4 + length) return;
      const message = JSON.parse(this.input.subarray(end + 4, end + 4 + length).toString());
      this.input = this.input.subarray(end + 4 + length);
      if (message.type === 'response') {
        const call = this.pending.get(message.request_seq);
        if (!call) continue;
        this.pending.delete(message.request_seq); clearTimeout(call.timer);
        if (message.success) call.resolve(message.body ?? {});
        else call.reject(new Error(message.message || 'DAP request failed'));
      } else if (message.type === 'event') {
        const index = this.waiters.findIndex(value => value.name === message.event);
        if (index >= 0) { const [waiter] = this.waiters.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(message); }
        else { this.events.push(message); if (this.events.length > 100) this.events.shift(); }
        if (message.event === 'output' && message.body?.output) this.onStatus(message.body.output.trim());
        if (message.event === 'stopped' || message.event === 'continued') this.onDebugEvent(message.event, message.body || {});
      }
    }
  }

  async openSamples(info) {
    if (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || typeof info.token !== 'string') throw new Error('Invalid sample channel');
    this.socket = net.createConnection({ host: '127.0.0.1', port: info.port });
    await new Promise((resolve, reject) => { this.socket.once('connect', resolve); this.socket.once('error', reject); });
    this.socket.write(`${info.token}\n`);
    this.socket.on('data', data => this.acceptSamples(data));
    this.socket.on('error', error => this.onStatus(`Sample channel: ${error.message}`));
    this.socket.on('close', () => { if (!this.closed) this.onStatus('Sample channel closed'); });
  }

  acceptSamples(data) {
    this.sampleInput = Buffer.concat([this.sampleInput, data]);
    while (this.sampleInput.length >= 4) {
      const length = this.sampleInput.readUInt32LE(0);
      if (!length || length > 32 * 1024 * 1024) { this.fail(new Error('Invalid sample frame length')); return; }
      if (this.sampleInput.length < length + 4) return;
      const payload = this.sampleInput.subarray(4, length + 4);
      this.sampleInput = this.sampleInput.subarray(length + 4);
      try { this.onBatch(decodeBatch(payload)); } catch (error) { this.onStatus(`Sample decoding: ${error.message}`); }
    }
  }

  async subscribe(ids, rate) {
    this.ids = [...new Set(ids)];
    if (this.ids.length > 256) throw new Error('The probe backend supports at most 256 simultaneous numeric channels');
    return this.request(`${this.prefix}/setSubscriptions`, { ids: this.ids, requestedSamplesPerSecond: Math.max(1, Math.min(100000, Math.floor(rate))) });
  }

  async debug(command) {
    if (!['pause', 'continue', 'next', 'stepIn', 'stepOut'].includes(command)) throw new Error('Unsupported debug command');
    return this.request(command, { threadId: 1 }, 15000);
  }

  async setBreakpoints(source, lines) {
    if (typeof source !== 'string' || !source) throw new Error('Choose a source file');
    if (!Array.isArray(lines) || lines.length > 64 || lines.some(line => !Number.isSafeInteger(line) || line < 1))
      throw new Error('Invalid breakpoint lines');
    const unique = [...new Set(lines)].sort((a, b) => a - b);
    return this.request('setBreakpoints', { source: { path: source }, breakpoints: unique.map(line => ({ line })) }, 15000);
  }

  async writeValue(id, value) {
    return this.request(`${this.prefix}/writeValue`, { id, value }, 15000);
  }

  async flash(elf) {
    if (!existsSync(elf)) throw new Error(`ELF not found: ${elf}`);
    return this.request(`${this.prefix}/flash`, { path: elf, verify: true, resetAfter: true }, 120000);
  }

  async stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (!this.closed) {
        try { await this.request('disconnect', {}, 3000); } catch { /* Adapter may already be gone. */ }
      }
      this.socket?.destroy();
      if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
        let timer;
        try {
          await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
        } finally { clearTimeout(timer); }
        if (this.child.exitCode === null && this.child.signalCode === null) {
          this.child.kill();
          await this.exited;
        }
      }
      this.fail(new Error('Session stopped'));
    })();
    return this.stopping;
  }

  fail(error) {
    if (this.closed && !this.pending.size && !this.waiters.length) return;
    this.closed = true;
    this.socket?.destroy();
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters = [];
    this.onStatus(error.message);
  }
}

export function decodeBatch(payload) {
  let offset = 0;
  const take = count => { if (offset + count > payload.length) throw new Error('Truncated batch'); const p = offset; offset += count; return p; };
  const string = () => { const n = payload.readUInt16LE(take(2)); return payload.subarray(take(n), offset).toString('utf8'); };
  if (payload.subarray(take(4), offset).toString() !== 'CKIT') throw new Error('Wrong sample magic');
  if (payload.readUInt16LE(take(2)) !== 1) throw new Error('Unsupported sample version');
  const sessionId = string();
  const programGeneration = Number(payload.readBigUInt64LE(take(8)));
  const streamEpoch = Number(payload.readBigUInt64LE(take(8)));
  const batchSequence = Number(payload.readBigUInt64LE(take(8)));
  const sampleCount = payload.readUInt32LE(take(4));
  const startTimestamp = payload.readBigUInt64LE(take(8));
  const samplePeriod = payload.readBigUInt64LE(take(8));
  const startTimestampNs = Number(startTimestamp);
  const samplePeriodNs = Number(samplePeriod);
  const droppedFrames = Number(payload.readBigUInt64LE(take(8)));
  const channelCount = payload.readUInt16LE(take(2));
  if (sampleCount > 100000 || channelCount > 256 || sampleCount * channelCount > 1000000) throw new Error('Batch too large');
  const channelIds = Array.from({ length: channelCount }, string);
  const values = [];
  for (let i = 0; i < sampleCount * channelCount; i++) values.push(payload.readDoubleLE(take(8)));
  if (offset !== payload.length) throw new Error('Trailing sample bytes');
  return { sessionId, programGeneration, streamEpoch, batchSequence, sampleCount, startTimestampNs, samplePeriodNs,
    startTimestampNsExact: String(startTimestamp), samplePeriodNsExact: String(samplePeriod), droppedFrames, channelIds, values };
}
