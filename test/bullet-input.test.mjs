import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameParser, validateReceiverPaths, ReceiverService } from '../src/bullet/receiver.mjs';
import { cameraConstraints, cameraError, receiverPixels } from '../web/bullet/bullet-input.mjs';

function packet() {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt32LE(0x31464250, 0); buffer.writeUInt32LE(2, 4); buffer.writeUInt32LE(1, 8); buffer.writeUInt32LE(6, 12);
  buffer.set([255, 0, 0, 0, 128, 255], 16); return buffer;
}

test('native DJI handshake matches verified request/cancel wire packets without opening devices', { skip: process.platform !== 'win32' }, () => {
  const helper = fileURLToPath(new URL('../src/bullet/receiver.cs', import.meta.url));
  const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `Add-Type -Path '${helper.replaceAll("'", "''")}'; [BitConverter]::ToString([PnxBulletReceiver]::KeyframePacket($true)); [BitConverter]::ToString([PnxBulletReceiver]::KeyframePacket($false))`;
  const result = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), [
    '55-17-04-38-AA-0E-00-00-40-01-01-00-00-00-00-00-24-00-00-00-24-8F-06',
    '55-17-04-38-AA-0E-00-00-40-01-01-00-00-00-00-00-04-00-00-00-04-1C-47',
  ]);
});
test('camera selection is exact; format fallback never switches to a different camera', () => {
  const constraints = cameraConstraints('phone-id', '1920x1080', 60);
  assert.deepEqual(constraints.video.deviceId, { exact: 'phone-id' }); assert.equal(constraints.audio, false);
  assert.deepEqual(cameraConstraints('phone-id', '1920x1080', 60, true), { audio: false, video: { deviceId: { exact: 'phone-id' } } });
  assert.throws(() => cameraConstraints('', 'bad', 30)); assert.throws(() => cameraConstraints('', '640x480', 300));
  assert.match(cameraError({ name: 'NotFoundError' }), /手机/);
});
test('receiver parser handles split headers, bytewise payloads, and consecutive frames', () => {
  const results = [], parser = new FrameParser(frame => results.push(frame)), bytes = packet();
  for (const byte of bytes) parser.push(Buffer.from([byte]));
  parser.push(Buffer.concat([bytes, bytes]));
  assert.equal(results.length, 3); results.forEach(frame => assert.deepEqual(frame, bytes));
  const pixels = receiverPixels(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(pixels.width, 2); assert.deepEqual([...pixels.rgba], [255, 0, 0, 255, 0, 128, 255, 255]);
});
test('receiver rejects oversized, malformed, and truncated frame metadata', () => {
  for (const offset of [0, 4, 8, 12]) {
    const bad = packet(); bad.writeUInt32LE(0xffffffff, offset);
    assert.throws(() => new FrameParser(() => {}).push(bad));
    assert.throws(() => receiverPixels(bad.buffer.slice(bad.byteOffset, bad.byteOffset + bad.byteLength)));
  }
  assert.throws(() => receiverPixels(new ArrayBuffer(8)));
  const bytes = packet().subarray(0, 20); assert.throws(() => receiverPixels(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
});
test('receiver dependency paths are explicit; unrelated stop cannot close a session', async () => {
  assert.throws(() => validateReceiverPaths({ sdkDirectory: '../elsewhere' }));
  assert.throws(() => validateReceiverPaths({ usbLibrary: 'libusb0.dll' }, false));
  assert.throws(() => validateReceiverPaths({ usbLibrary: 4 }, false));
  const service = new ReceiverService(); service.active = { id: 'real', touched: 0, stopping: false };
  await service.stop('other'); assert.equal(service.active.id, 'real');
  assert.throws(() => service.frame('other'), /已关闭/);
  assert.equal(service.frame('real'), null); assert.ok(service.active.touched > 0);
  await service.stop('real'); assert.equal(service.active, null);
});

test('receiver native-process contract: frames, ownership, stop, and idle lease recovery', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
  const cache = fileURLToPath(new URL('../.cache/', import.meta.url)); mkdirSync(cache, { recursive: true });
  const sdk = mkdtempSync(path.join(cache, 'bullet-contract-'));
  for (const name of ['RC150.dll', 'avcodec-61.dll', 'avformat-61.dll', 'avutil-59.dll', 'swscale-8.dll']) writeFileSync(path.join(sdk, name), 'fixture');
  const children = [];
  const service = new ReceiverService({ launch(_exe, args, options) {
    const pipeName = args[args.indexOf('-PipeName') + 1];
    const code = `const net=require('node:net');const socket=net.connect(${JSON.stringify('\\\\.\\pipe\\' + pipeName)},()=>socket.write(Buffer.from(${JSON.stringify([...packet()])})));socket.on('error',()=>process.exit(0));socket.on('close',()=>process.exit(0));process.stdin.on('data',()=>socket.end());`;
    const child = spawn(process.execPath, ['-e', code], options); children.push(child); return child;
  } });
  try {
    const options = { sdkDirectory: sdk, device: '\\\\.\\libusb0-test' };
    const first = await service.start(options);
    await assert.rejects(service.start(options), /已有图传/);
    const deadline = Date.now() + 3000; let result;
    while (!result && Date.now() < deadline) { result = service.frame(first.session); await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.deepEqual(result.frame, packet()); assert.equal(result.sequence, 1); assert.equal(service.frame(first.session, 1), null);
    await service.stop('wrong'); assert.ok(service.active);
    await service.stop(first.session); assert.equal(service.active, null); assert.throws(() => service.frame(first.session));
    const second = await service.start(options); assert.notEqual(second.session, first.session);
    service.active.touched = Date.now() - 11000;
    const expiry = Date.now() + 5000; while (service.active && Date.now() < expiry) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(service.active, null); assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
  } finally { await service.stop(); children.forEach(child => { if (child.exitCode === null) child.kill(); }); }
});
