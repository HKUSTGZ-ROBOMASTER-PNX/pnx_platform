// Requires Playwright and a local Chrome install. Optional PNX_BULLET_VIDEO tests a real recording.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const { chromium } = await import(process.env.PNX_PLAYWRIGHT_PATH ? pathToFileURL(process.env.PNX_PLAYWRIGHT_PATH).href : 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, '.cache', 'bullet-ui-smoke'); mkdirSync(output, { recursive: true });
const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PNX_WORKSPACE_ROOT: '', PNX_CACHE_ROOT: output } });
let stdout = '', stderr = '', browser;
child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  const deadline = Date.now() + 10000;
  while (!stdout.includes('PnX Platform: ') && Date.now() < deadline) await pause(50);
  const origin = /PnX Platform: (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1]; assert.ok(origin, stdout + stderr);
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['camera'], acceptDownloads: true });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin); await page.locator('[data-view-target="bullet"]').click();
  await page.locator('#bulletDemo').click(); await page.waitForFunction(() => document.getElementById('bulletCount').textContent === '36');
  assert.equal(await page.locator('#codeArea').isVisible(), false);
  assert.equal(await page.locator('#bulletVerdict').textContent(), '合格');
  await page.locator('#bulletMask').check(); await page.locator('#bulletMask').uncheck();
  await page.screenshot({ path: path.join(output, 'dark.png'), fullPage: true });
  await page.locator('#themeToggle').click(); await page.screenshot({ path: path.join(output, 'light.png'), fullPage: true });
  await page.locator('#bulletRecord').click(); await page.waitForFunction(() => /1 \/ 10,000/.test(document.getElementById('bulletRecordStatus').textContent));
  await page.locator('#bulletRecord').click();
  const csvWait = page.waitForEvent('download'); await page.locator('#bulletCsv').click(); const csv = await csvWait;
  await csv.saveAs(path.join(output, 'frames.csv')); assert.match(readFileSync(path.join(output, 'frames.csv'), 'utf8'), /Frame_Targets/);
  assert.match(readFileSync(path.join(output, 'frames.csv'), 'utf8'), /36/);
  const reportWait = page.waitForEvent('download'); await page.locator('#bulletReport').click(); const report = await reportWait;
  await report.saveAs(path.join(output, 'result.json')); assert.equal(JSON.parse(readFileSync(path.join(output, 'result.json'))).count, 36);
  await page.locator('#bullet-minCount').fill('40'); await page.locator('#bulletParams button[type="submit"]').click();
  await page.waitForFunction(() => document.getElementById('bulletVerdict').textContent === '数量不足');
  await page.locator('#bulletConfigFile').setInputFiles({ name: 'config.txt', mimeType: 'text/plain', buffer: Buffer.from('分析参数\n35,10,10,90,255,255,1,2,20,5\n亮度阈值\n50,40,30') });
  await page.waitForFunction(() => document.getElementById('bulletVerdict').textContent === '合格');
  // Invalid import must preserve the applied configuration.
  await page.locator('#bulletConfigFile').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await page.waitForFunction(() => document.getElementById('bulletStatus').textContent.startsWith('配置未更改'));
  assert.equal(await page.locator('#bullet-minCount').inputValue(), '30');
  const png = await page.locator('#bulletCanvas').evaluate(canvas => canvas.toDataURL('image/png').split(',')[1]);
  await page.locator('#bulletFile').setInputFiles({ name: 'frame.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.waitForFunction(() => document.getElementById('bulletSource').textContent === 'frame.png' && document.getElementById('bulletCount').textContent !== '—');
  await page.locator('#bulletFile').setInputFiles({ name: 'broken.mp4', mimeType: 'video/mp4', buffer: Buffer.from('invalid video') });
  await page.waitForFunction(() => document.getElementById('bulletStatus').textContent.includes('无法解码'));
  assert.equal(await page.locator('#bulletReport').isDisabled(), true);
  // Exercise the real MediaStream/video pipeline with a canvas source; no camera hardware is used.
  await page.evaluate(() => {
    window.cameraRequests = []; window.rejectFormatOnce = true;
    navigator.mediaDevices.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: 'usb-phone', label: 'USB phone camera' }, { kind: 'videoinput', deviceId: 'capture-card', label: 'HDMI capture' }];
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.cameraRequests.push(constraints);
      if (window.rejectFormatOnce && constraints.video.width) { window.rejectFormatOnce = false; const error = new Error('format'); error.name = 'OverconstrainedError'; throw error; }
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d');
      const draw = () => { ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, 640, 480); ctx.fillStyle = '#00cc00'; ctx.fillRect(100, 100, 40, 40); };
      draw(); const stream = canvas.captureStream(10), interval = setInterval(draw, 100);
      const track = stream.getVideoTracks()[0], stop = track.stop.bind(track);
      track.stop = () => { clearInterval(interval); stop(); };
      return stream;
    };
  });
  await page.locator('#bulletCameraRefresh').click();
  await page.waitForFunction(() => document.querySelector('#bulletCameraDevice option[value="usb-phone"]'));
  await page.locator('#bulletCameraDevice').selectOption('usb-phone');
  await page.locator('#bulletCamera').click();
  await page.waitForFunction(() => document.getElementById('bulletCount').textContent !== '—' || document.getElementById('bulletStatus').dataset.error === 'true', null, { timeout: 20000 });
  assert.equal(await page.locator('#bulletStatus').getAttribute('data-error'), 'false', await page.locator('#bulletStatus').textContent());
  assert.deepEqual(await page.evaluate(() => window.cameraRequests.at(-1)), { audio: false, video: { deviceId: { exact: 'usb-phone' } } });
  await page.evaluate(() => { window.bulletTestTrack = document.getElementById('bulletVideo').srcObject.getVideoTracks()[0]; });
  await page.locator('[data-view-target="editor"]').first().click();
  await page.waitForFunction(() => window.bulletTestTrack.readyState === 'ended');
  await page.locator('[data-view-target="bullet"]').click();
  await page.evaluate(() => {
    const capture = navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => {
      window.finishCameraRequest = async () => {
        const stream = await capture(); window.delayedCameraTrack = stream.getVideoTracks()[0]; resolve(stream);
      };
    });
  });
  await page.locator('#bulletCamera').click();
  await page.locator('[data-view-target="editor"]').first().click();
  await page.evaluate(() => window.finishCameraRequest());
  await page.waitForFunction(() => window.delayedCameraTrack.readyState === 'ended');
  await page.locator('[data-view-target="bullet"]').click();
  // Browser-to-receiver API contract with a deterministic RGB frame (not a hardware test).
  let receiverStops = 0, receiverSequence = 0;
  const rgb = Buffer.alloc(16 + 96 * 48 * 3); rgb.writeUInt32LE(0x31464250); rgb.writeUInt32LE(96, 4); rgb.writeUInt32LE(48, 8); rgb.writeUInt32LE(96 * 48 * 3, 12);
  for (const left of [10, 65]) for (let y = 10; y < 24; y++) for (let x = left; x < left + 14; x++) rgb[16 + (y * 96 + x) * 3 + 1] = 200;
  await page.route('**/api/bullet/receiver/devices', route => route.fulfill({ json: { devices: [{ id: 'test-device', name: 'DJI test receiver' }] } }));
  await page.route('**/api/bullet/receiver/start', route => route.fulfill({ json: { session: 'ui-test' } }));
  await page.route('**/api/bullet/receiver/frame?*', route => route.fulfill({ contentType: 'application/octet-stream', body: rgb, headers: { 'X-Frame-Sequence': String(++receiverSequence), 'X-Frame-Timestamp': String(Date.now()) } }));
  await page.route('**/api/bullet/receiver/stop', route => { receiverStops++; return route.fulfill({ json: { ok: true } }); });
  await page.locator('#bulletReceiverScan').click(); await page.waitForFunction(() => !document.getElementById('bulletReceiverConnect').disabled);
  await page.locator('#bulletReceiverConnect').click(); await page.waitForFunction(() => document.getElementById('bulletCount').textContent === '2');
  assert.match(await page.locator('#bulletSource').textContent(), /DJI/);
  await page.locator('[data-view-target="editor"]').first().click();
  const stoppedBy = Date.now() + 3000; while (!receiverStops && Date.now() < stoppedBy) await pause(20);
  assert.equal(receiverStops, 1);
  await page.unroute('**/api/bullet/receiver/devices'); await page.unroute('**/api/bullet/receiver/start'); await page.unroute('**/api/bullet/receiver/frame?*'); await page.unroute('**/api/bullet/receiver/stop');
  await page.locator('[data-view-target="bullet"]').click();
  if (process.env.PNX_BULLET_VIDEO) {
    await page.locator('#bulletClear').click();
    await page.locator('#bulletFile').setInputFiles(process.env.PNX_BULLET_VIDEO);
    await page.waitForFunction(() => document.getElementById('bulletCount').textContent !== '—' || document.getElementById('bulletStatus').dataset.error === 'true', null, { timeout: 20000 });
    assert.equal(await page.locator('#bulletStatus').getAttribute('data-error'), 'false', await page.locator('#bulletStatus').textContent());
    await page.evaluate(() => { document.getElementById('bulletVideo').currentTime = 5; });
    await page.waitForFunction(() => document.getElementById('bulletDetails').textContent.includes('5.000 s'), null, { timeout: 20000 });
    await page.screenshot({ path: path.join(output, 'real-video.png'), fullPage: true });
    console.log('Real video:', await page.locator('#bulletDetails').textContent());
    await page.locator('#bulletRecord').click(); await page.locator('#bulletVideo').evaluate(video => video.play());
    await page.waitForFunction(() => /[2-9] \/ 10,000/.test(document.getElementById('bulletRecordStatus').textContent), null, { timeout: 20000 });
    await page.locator('[data-view-target="editor"]').first().click();
    assert.equal(await page.locator('#bulletVideo').evaluate(video => video.paused), true);
    assert.match(await page.locator('#bulletRecordStatus').textContent(), /已停止/);
  }
  assert.deepEqual(errors, []); console.log('Bullet UI smoke passed:', output);
} finally {
  await browser?.close();
  child.stdin.write('shutdown\n');
  await Promise.race([once(child, 'exit'), pause(4000)]);
  if (child.exitCode === null) child.kill();
}
