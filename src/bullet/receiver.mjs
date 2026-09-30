import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, statSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MAX_FRAME_BYTES = 3840 * 2160 * 3;
export class FrameParser {
  constructor(onFrame) { this.onFrame = onFrame; this.header = Buffer.alloc(16); this.used = 0; this.frame = null; this.offset = 0; }
  push(chunk) {
    let at = 0;
    while (at < chunk.length) {
      if (!this.frame) {
        const count = Math.min(16 - this.used, chunk.length - at);
        chunk.copy(this.header, this.used, at, at + count); this.used += count; at += count;
        if (this.used < 16) return;
        const magic = this.header.readUInt32LE(0), width = this.header.readUInt32LE(4), height = this.header.readUInt32LE(8), length = this.header.readUInt32LE(12);
        if (magic !== 0x31464250 || !width || !height || width > 3840 || height > 2160 || length !== width * height * 3 || length > MAX_FRAME_BYTES) throw new Error('图传解码帧格式无效');
        this.frame = Buffer.allocUnsafe(length + 16); this.header.copy(this.frame); this.offset = 16;
      }
      const count = Math.min(this.frame.length - this.offset, chunk.length - at);
      chunk.copy(this.frame, this.offset, at, at + count); this.offset += count; at += count;
      if (this.offset === this.frame.length) { const frame = this.frame; this.frame = null; this.used = 0; this.onFrame(frame); }
    }
  }
}
export function validateReceiverPaths({ sdkDirectory = '', usbLibrary = '' }, requireSdk = true) {
  if (typeof sdkDirectory !== 'string' || typeof usbLibrary !== 'string') throw new Error('图传目录和 DLL 路径须为字符串');
  if (usbLibrary && (!path.isAbsolute(usbLibrary) || path.basename(usbLibrary).toLowerCase() !== 'libusb0.dll' || !existsSync(usbLibrary) || !statSync(usbLibrary).isFile())) throw new Error('请选择存在的绝对路径 libusb0.dll');
  if (requireSdk) {
    if (!path.isAbsolute(sdkDirectory)) throw new Error('请填写 BulletFluor 所在文件夹的绝对路径');
    for (const name of ['RC150.dll', 'avcodec-61.dll', 'avformat-61.dll', 'avutil-59.dll', 'swscale-8.dll']) {
      if (!existsSync(path.join(sdkDirectory, name)) || !statSync(path.join(sdkDirectory, name)).isFile()) throw new Error(`图传目录缺少 ${name}`);
    }
  }
  return { sdkDirectory, usbLibrary };
}
const helper = fileURLToPath(new URL('./receiver.ps1', import.meta.url));
const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const baseArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class ReceiverService {
  constructor({ launch = spawn } = {}) { this.launch = launch; this.active = null; this.pending = false; }
  info() { return { supported: process.platform === 'win32' && process.arch === 'x64', defaultSdkDirectory: process.env.PNX_BULLET_SDK_DIR || '', defaultUsbLibrary: process.env.PNX_BULLET_USB_DLL || '', active: !!this.active }; }
  async devices(options) {
    if (!this.info().supported) throw new Error('专用 DJI USB 图传目前仅支持 Windows x64');
    const { usbLibrary } = validateReceiverPaths(options, false);
    return new Promise((resolve, reject) => {
      const child = this.launch(powershell(), [...baseArgs, '-Probe', ...(usbLibrary ? ['-UsbLibrary', usbLibrary] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', error = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('图传设备枚举超时')); }, 15000);
      child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); });
      child.stderr.on('data', chunk => { error = (error + chunk).slice(-2000); });
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.once('close', code => {
        clearTimeout(timer);
        try {
          if (code !== 0) throw new Error(error.trim() || '图传设备枚举失败');
          const line = output.split(/\r?\n/).find(line => line.startsWith('PNX_DEVICES '));
          const devices = JSON.parse(line?.slice(12) || 'null');
          if (!Array.isArray(devices) || devices.some(device => typeof device !== 'string')) throw new Error('图传枚举结果无效');
          resolve({ devices: devices.map(id => ({ id, name: `DJI USB 图传 · ${id}` })) });
        } catch (err) { reject(err); }
      });
    });
  }
  async start(options) {
    if (!this.info().supported) throw new Error('专用 DJI USB 图传目前仅支持 Windows x64');
    if (this.active || this.pending) throw new Error('已有图传连接，请先关闭输入');
    const { sdkDirectory, usbLibrary } = validateReceiverPaths(options);
    if (typeof options.device !== 'string' || options.device.length > 512 || !options.device.startsWith('\\\\.\\libusb0-')) throw new Error('请先扫描并选择图传设备');
    this.pending = true;
    const id = randomBytes(24).toString('hex'), pipeName = `pnx-bullet-${id}`;
    const session = { id, frame: null, sequence: 0, frameAt: 0, touched: Date.now(), error: null, stopping: false };
    this.active = session;
    try {
      const parser = new FrameParser(frame => { session.frame = frame; session.frameAt = Date.now(); session.sequence++; });
      session.server = net.createServer(socket => {
        if (session.socket || session.stopping) { socket.destroy(); return; }
        session.socket = socket;
        socket.on('data', chunk => { try { parser.push(chunk); } catch (error) { session.error = error.message; void this.stop(id); } });
        socket.on('error', error => { session.error = error.message; });
      });
      await new Promise((resolve, reject) => { session.server.once('error', reject); session.server.listen(`\\\\.\\pipe\\${pipeName}`, resolve); });
      const scratch = path.resolve(process.env.PNX_CACHE_ROOT || fileURLToPath(new URL('../../.cache', import.meta.url)), 'bullet-receiver');
      mkdirSync(scratch, { recursive: true });
      session.child = this.launch(powershell(), [...baseArgs, '-SdkDirectory', sdkDirectory, ...(usbLibrary ? ['-UsbLibrary', usbLibrary] : []), '-Device', options.device, '-PipeName', pipeName], { cwd: scratch, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
      session.child.stdin.on('error', () => {});
      session.child.stderr.on('data', chunk => { session.errorLog = ((session.errorLog || '') + chunk).slice(-4000); });
      session.child.once('error', error => { session.error = error.message; });
      session.child.once('exit', code => { if (!session.stopping) session.error = session.errorLog?.match(/PNX_ERROR (.*)/)?.[1] || `图传进程已退出 (${code})`; });
      const deadline = Date.now() + 18000;
      while (!session.socket && !session.error && Date.now() < deadline) await pause(50);
      if (session.error || !session.socket) throw new Error(session.error || '图传连接超时');
      session.lease = setInterval(() => { if (Date.now() - session.touched > 10000) void this.stop(id); }, 1000); session.lease.unref();
      return { session: id };
    } catch (error) { await this.stop(id); throw error; }
    finally { this.pending = false; }
  }
  frame(id, after = 0) {
    const session = this.active;
    if (!session || session.id !== id || session.stopping) throw new Error('图传连接已关闭，请重新连接');
    session.touched = Date.now();
    if (session.error) { void this.stop(id); throw new Error(session.error); }
    if (!session.frame || session.sequence <= after) return null;
    if (Date.now() - session.frameAt > 3000) throw new Error('图传画面超时，请检查无线链路并重新连接');
    return { frame: session.frame, sequence: session.sequence, timestamp: session.frameAt };
  }
  async stop(id = this.active?.id) {
    const session = this.active;
    if (!session || session.id !== id) return;
    if (session.stopping) return session.stopped;
    session.stopping = true; clearInterval(session.lease);
    session.stopped = (async () => {
      session.socket?.destroy(); session.server?.close();
      if (session.child && session.child.exitCode === null && session.child.signalCode === null) {
        session.child.stdin.end('stop\n');
        const deadline = Date.now() + 2500;
        while (session.child.exitCode === null && session.child.signalCode === null && Date.now() < deadline) await pause(30);
        if (session.child.exitCode === null && session.child.signalCode === null) {
          session.child.kill();
          const killedAt = Date.now() + 1000;
          while (session.child.exitCode === null && session.child.signalCode === null && Date.now() < killedAt) await pause(20);
        }
      }
      session.frame = null;
      if (this.active === session) this.active = null;
    })();
    return session.stopped;
  }
}
