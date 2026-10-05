import path from 'node:path';
import { createWriteStream, mkdirSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';

const MAX_PENDING_BYTES = 16 * 1024 * 1024;
const csvCell = value => `"${String(value).replaceAll('"', '""')}"`;

export class CsvRecorder {
  static async start(root, variables, options = {}) {
    const timeColumn = options.timeColumn ?? 'sample_index';
    if (!['sample_index', 'elapsed_s', 'timestamp_ns'].includes(timeColumn)) throw new Error('Invalid CSV time column');
    if (!root || !variables.length) throw new Error('Open a project and subscribe to variables first');
    const directory = path.join(root, 'captures');
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `pnx-${stamp}-${randomBytes(3).toString('hex')}.csv`);
    const stream = createWriteStream(file, { flags: 'wx', encoding: 'utf8' });
    await new Promise((resolve, reject) => { stream.once('open', resolve); stream.once('error', reject); });
    return new CsvRecorder(file, variables, stream, timeColumn);
  }

  constructor(file, variables, stream, timeColumn) {
    this.timeColumn = timeColumn;
    this.firstTimestamp = null;
    this.file = file;
    this.variables = variables.map(variable => ({ id: variable.id, name: variable.name }));
    this.stream = stream;
    this.rows = 0;
    this.bytes = 0;
    this.active = true;
    this.error = null;
    this.finished = finished(stream).catch(error => { this.error = error.message; this.active = false; });
    this.write([timeColumn, ...this.variables.map(variable => variable.name)].map(csvCell).join(',') + '\n');
  }

  write(chunk) {
    if (!this.active) return;
    this.bytes += Buffer.byteLength(chunk);
    this.stream.write(chunk);
    if (this.stream.writableLength > MAX_PENDING_BYTES) {
      this.error = 'CSV 写入速度跟不上采集，已停止记录';
      this.active = false;
      this.stream.end();
    }
  }

  appendBatch(batch) {
    if (!this.active || !batch.sampleCount) return;
    const channelIndex = new Map(batch.channelIds.map((id, index) => [id, index]));
    const indices = this.variables.map(variable => channelIndex.get(variable.id));
    if (indices.every(index => index === undefined)) return;
    const start = BigInt(batch.startTimestampNsExact ?? Math.round(batch.startTimestampNs));
    const period = BigInt(batch.samplePeriodNsExact ?? Math.round(batch.samplePeriodNs));
    let chunk = '';
    for (let sample = 0; sample < batch.sampleCount && this.active; sample++) {
      const timestamp = start + BigInt(sample) * period;
      this.firstTimestamp ??= timestamp;
      const left = this.timeColumn === 'timestamp_ns' ? timestamp
        : this.timeColumn === 'elapsed_s' ? Number(timestamp - this.firstTimestamp) / 1e9 : this.rows + 1;
      const values = indices.map(index => {
        if (index === undefined) return '';
        const value = batch.values[sample * batch.channelIds.length + index];
        return Number.isFinite(value) ? String(value) : '';
      });
      chunk += `${left},${values.join(',')}\n`;
      this.rows++;
      if (chunk.length > 64 * 1024) { this.write(chunk); chunk = ''; }
    }
    if (chunk) this.write(chunk);
  }

  async stop() {
    if (this.active) { this.active = false; this.stream.end(); }
    await this.finished;
    if (this.error) throw new Error(this.error);
    return this.status();
  }

  status() { return { active: this.active, file: this.file, rows: this.rows, bytes: this.bytes, error: this.error }; }
}
