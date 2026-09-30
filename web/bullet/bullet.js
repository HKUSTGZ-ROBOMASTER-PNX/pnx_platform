import { defaults, fields, validateConfig, parseConfig } from './bullet-core.mjs';
import { cameraConstraints, cameraError, receiverPixels } from './bullet-input.mjs';

const area = document.getElementById('bulletArea');
area.innerHTML = `
  <div class="bullet-heading"><div><h1>弹丸荧光检测 <small>预览版</small></h1><p>本地分析 · HSV 分割 · 左右区域亮度</p></div>
    <div class="bullet-actions"><button id="bulletOpen" class="primary">打开图片 / 视频</button><button id="bulletDemo">示例图片</button><button id="bulletCamera">USB 摄像头</button><button id="bulletStop" disabled>关闭输入</button></div></div>
  <input id="bulletFile" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,video/mp4,video/webm,video/x-matroska,.mkv" hidden>
  <input id="bulletConfigFile" type="file" accept=".txt,.json" hidden>
  <details class="bullet-connections bullet-card" open><summary>摄像头与图传连接</summary><div class="bullet-input-grid">
    <div><h2>USB / 手机摄像头 / HDMI 采集卡</h2><div class="bullet-actions"><select id="bulletCameraDevice" aria-label="摄像头设备"><option value="">系统默认摄像头</option></select><button id="bulletCameraRefresh">刷新设备</button></div>
      <div class="bullet-actions"><label>请求分辨率 <select id="bulletCameraResolution"><option>640x480</option><option selected>1280x720</option><option>1920x1080</option></select></label><label>帧率 <select id="bulletCameraFps"><option>15</option><option selected>30</option><option>60</option></select></label></div>
      <p class="bullet-note">选择设备后点击顶部“USB 摄像头”。支持系统已识别的 UVC 和手机虚拟摄像头。手机仅接 USB 数据线不一定会提供视频，需在手机上开启“网络摄像头”模式，或先运行配套手机摄像头软件。图传 HDMI 输出可经 USB 采集卡接入。</p>
    </div><div><h2>DJI 专用 USB 图传（实验）</h2>
      <label class="bullet-path">BulletFluor 文件夹<input id="bulletSdkDirectory" placeholder="包含 RC150.dll 的文件夹绝对路径" spellcheck="false"></label>
      <label class="bullet-path">64 位 libusb0.dll（可选）<input id="bulletUsbLibrary" placeholder="留空使用系统版本；错误 193 时指定厂商 x64 DLL" spellcheck="false"></label>
      <div class="bullet-actions"><button id="bulletReceiverScan">扫描图传</button><select id="bulletReceiverDevice" aria-label="图传接收端"><option value="">请先扫描设备</option></select><button id="bulletReceiverConnect" disabled>连接图传</button></div>
      <p class="bullet-note">支持 DJI 2CA3:1020，限 Windows x64。使用本地 RC150 解码库及已安装的驱动，并通过协议串口请求视频关键帧。一次只连接一个接收端；连接前关闭 BulletFluor / ReceiveEnd。不会更改曝光或安装驱动。</p>
    </div></div><p id="bulletInputStatus" role="status" class="bullet-note">摄像头由系统媒体接口访问；专用图传通过本机接收桥接。</p></details>
  <div class="bullet-layout"><div><div class="bullet-card">
    <div class="bullet-actions"><label class="bullet-toggle"><input id="bulletMask" type="checkbox">分割掩膜</label><button id="bulletAnalyze" disabled>重新检测当前帧</button><span id="bulletSource" class="bullet-note">未选择输入</span></div>
    <p id="bulletStatus" role="status" aria-live="polite">打开一张图片或一段视频，或用示例图片试用。</p>
    <div class="bullet-preview"><canvas id="bulletCanvas" width="960" height="540" aria-label="弹丸检测结果"></canvas><div id="bulletEmpty" class="bullet-empty">检测结果将在这里显示<br>无需打开工程或连接探针</div></div>
    <video id="bulletVideo" controls muted playsinline hidden></video>
    <div id="bulletDetails"></div>
  </div><div class="bullet-metrics">
    <div class="bullet-metric"><small>当前帧目标数</small><strong id="bulletCount">—</strong></div>
    <div class="bullet-metric"><small>左区：数量 / 平均亮度</small><strong id="bulletLeft">—</strong></div>
    <div class="bullet-metric"><small>右区：数量 / 平均亮度</small><strong id="bulletRight">—</strong></div>
    <div class="bullet-metric"><small>单帧参考判定</small><strong id="bulletVerdict">—</strong></div>
  </div><div class="bullet-card"><div class="bullet-actions"><button id="bulletRecord" disabled>开始记录</button><button id="bulletCsv" disabled>导出 CSV</button><button id="bulletReport" disabled>保存当前结果</button><button id="bulletClear" disabled>清空记录</button><span id="bulletRecordStatus" class="bullet-note">尚未记录</span></div>
    <p class="bullet-note">视频播放时尽力每秒检测 5 帧，最多保留 10,000 条记录。暂停、跳转或调整参数会停止记录；跳过的帧不补算。这里统计单帧连通区域，不是累计弹丸数，也不是原软件的去重计数。</p></div></div>
  <div class="bullet-side"><div class="bullet-card"><h2>检测参数</h2><form id="bulletParams" class="bullet-params"></form><div class="bullet-actions" style="margin-top:12px"><button id="bulletReset">恢复默认</button><button id="bulletImport">导入配置</button><button id="bulletExport">导出配置</button></div></div>
  <div class="bullet-card"><h2>检测口径</h2><p class="bullet-note">先高斯模糊，再 HSV 分割、3×3 腐蚀与膨胀，最后按 8 邻域提取连通区域。H 为 0–179，S / V 为 0–255；H 下限大于上限时跨越红色边界。</p>
  <p class="bullet-note">区域亮度为原图掩膜内的灰度均值（0–255），左右按区域质心划分，两区均值对目标等权平均。无目标显示“—”。连接或重叠目标可能被合并。</p>
  <p class="bullet-note">保留原 config.txt 参数，但最小面积使用区域像素数，最少数量用于当前帧；不保证与原软件算法等价。低于最少数量时不作合格判定。</p>
  <p class="bullet-note">图像按比例缩至不超过 1920×1080，面积与核大小按处理分辨率计算。采集帧率不等于检测帧率。专用图传仅接收视频，曝光控制和外部指示灯暂未接入。</p></div></div></div>`;

const $ = id => document.getElementById(id);
const video = $('bulletVideo'), canvas = $('bulletCanvas'), ctx = canvas.getContext('2d');
const capture = document.createElement('canvas'), captureCtx = capture.getContext('2d', { willReadFrequently: true });
let config = { ...defaults }, source = null, sourceName = '', sourceKind = '', objectUrl = null, stream = null;
let epoch = 0, inputGeneration = 0, serial = 0, pending = null, latest = null, timer = null, recording = false, rows = [], recordConfig = null, recordSource = null;
let worker = null, workerTimer = null;
let receiverSession = null, receiverTimer = null, receiverAbort = null, receiverClosing = Promise.resolve();
let receiverSequence = 0, receiverTimestamp = null, receiverStarted = 0, cameraRefreshGeneration = 0;
const receiverCanvas = document.createElement('canvas'), receiverCtx = receiverCanvas.getContext('2d');
const status = (message, error = false) => { $('bulletStatus').textContent = message; $('bulletStatus').dataset.error = String(error); };
const inputStatus = message => { $('bulletInputStatus').textContent = message; };
async function receiverApi(action, data, options = {}) {
  const response = await fetch(`/api/bullet/receiver/${action}`, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-PnX-Token': window.PNX_TOKEN, 'Content-Type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...options });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '图传请求失败'); return result;
}
function releaseReceiver(session) {
  receiverClosing = receiverClosing.then(() => receiverApi('stop', { session }, { keepalive: true })).catch(error => inputStatus(`图传释放请求失败，将由服务端超时回收：${error.message}`));
  return receiverClosing;
}
function showConfig() {
  for (const [key] of fields) $(`bullet-${key}`).value = config[key];
}
for (const [key, label, min, max] of fields) {
  const wrapper = document.createElement('label'); wrapper.textContent = label;
  const input = document.createElement('input'); input.id = `bullet-${key}`; input.type = 'number'; input.required = true; input.min = min; input.max = max; input.step = key === 'gaussian' ? 2 : 1; input.value = config[key];
  wrapper.append(input); $('bulletParams').append(wrapper);
}
const apply = document.createElement('button'); apply.type = 'submit'; apply.textContent = '应用参数并重新检测'; apply.className = 'primary'; $('bulletParams').append(apply);
function updateRecording() {
  $('bulletRecord').textContent = recording ? '停止记录' : '开始记录';
  $('bulletRecordStatus').textContent = `${recording ? '记录中' : '已停止'} · ${rows.length.toLocaleString()} / 10,000 帧`;
  $('bulletCsv').disabled = $('bulletClear').disabled = rows.length === 0;
}
function stopRecording() { recording = false; if (pending) pending.recording = false; updateRecording(); }
function clearResults() {
  latest = null;
  for (const id of ['bulletCount', 'bulletLeft', 'bulletRight', 'bulletVerdict']) $(id).textContent = '—';
  $('bulletVerdict').removeAttribute('data-verdict'); $('bulletReport').disabled = true; $('bulletRecord').disabled = true;
  $('bulletDetails').textContent = ''; ctx.clearRect(0, 0, canvas.width, canvas.height); $('bulletEmpty').hidden = false;
}
function cancelJob() {
  clearTimeout(workerTimer); workerTimer = null;
  if (pending) { worker?.terminate(); worker = null; pending = null; }
}
function resetInput() {
  epoch++; inputGeneration++; clearTimeout(timer); cancelJob(); stopRecording();
  clearTimeout(receiverTimer); receiverAbort?.abort(); receiverAbort = null;
  if (receiverSession) { const previous = receiverSession; receiverSession = null; void releaseReceiver(previous); }
  receiverTimestamp = null; receiverSequence = 0;
  source = null; video.pause(); video.onloadeddata = video.onerror = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  video.srcObject = null; video.removeAttribute('src'); video.load(); video.hidden = true;
  if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null;
  sourceKind = ''; sourceName = ''; clearResults(); $('bulletSource').textContent = '未选择输入'; $('bulletAnalyze').disabled = $('bulletStop').disabled = true;
}
function sourceReady(value, name, kind) {
  source = value; sourceName = name; sourceKind = kind;
  $('bulletSource').textContent = name; $('bulletAnalyze').disabled = $('bulletStop').disabled = false;
  status('输入已就绪，正在检测…'); analyze();
}
function schedule() {
  clearTimeout(timer);
  if (source === video && !video.paused && !video.ended && document.body.dataset.view === 'bullet' && !document.hidden) timer = setTimeout(analyze, 200);
}
function ensureWorker() {
  if (worker) return;
  worker = new Worker('/bullet-worker.mjs', { type: 'module' });
  worker.onerror = () => { cancelJob(); worker?.terminate(); worker = null; stopRecording(); status('检测进程异常，点击重新检测重试。', true); };
  worker.onmessage = ({ data }) => {
    if (!pending || data.id !== pending.id) return;
    clearTimeout(workerTimer); workerTimer = null;
    const job = pending; pending = null;
    if (job.epoch !== epoch) { schedule(); return; }
    if (data.error) { stopRecording(); status(data.error, true); return; }
    latest = { ...data.result, image: job.image, seconds: job.seconds, config: job.config, source: job.source, kind: job.kind, timestamp: job.timestamp, originalWidth: job.originalWidth, originalHeight: job.originalHeight, elapsed: data.elapsed };
    render(); $('bulletRecord').disabled = false; $('bulletReport').disabled = false;
    status(`检测完成 · ${data.elapsed.toFixed(0)} ms${data.result.boxesTruncated ? ' · 仅绘制前 2,000 个区域' : ''}`);
    if (recording && job.recording) {
      rows.push({ timestamp: job.timestamp, seconds: job.seconds, width: latest.width, height: latest.height, count: latest.count, leftCount: latest.leftCount, rightCount: latest.rightCount, leftMean: latest.leftMean, rightMean: latest.rightMean, mean: latest.mean, verdict: latest.verdict });
      if (rows.length >= 10000) { recording = false; status('已达到 10,000 条记录上限，记录已停止。'); }
      updateRecording();
    }
    schedule();
  };
}
function analyze() {
  if (!source || pending || document.body.dataset.view !== 'bullet' || document.hidden) return;
  if (source === video && (video.readyState < 2 || video.seeking)) { schedule(); return; }
  try {
    const width = source.videoWidth || source.naturalWidth || source.width, height = source.videoHeight || source.naturalHeight || source.height;
    if (!width || !height) return;
    const scale = Math.min(1, 1920 / width, 1080 / height);
    capture.width = Math.max(1, Math.round(width * scale)); capture.height = Math.max(1, Math.round(height * scale));
    captureCtx.clearRect(0, 0, capture.width, capture.height); captureCtx.drawImage(source, 0, 0, capture.width, capture.height);
    const image = captureCtx.getImageData(0, 0, capture.width, capture.height), buffer = image.data.slice().buffer;
    ensureWorker();
    pending = { id: ++serial, epoch, image, config: { ...config }, source: sourceName, kind: sourceKind, originalWidth: width, originalHeight: height, seconds: source === video ? video.currentTime : sourceKind === 'receiver' ? (receiverTimestamp - receiverStarted) / 1000 : 0, timestamp: new Date(receiverTimestamp || Date.now()).toISOString(), recording };
    worker.postMessage({ id: pending.id, width: capture.width, height: capture.height, buffer, config }, [buffer]);
    workerTimer = setTimeout(() => { cancelJob(); stopRecording(); status('检测超时，请降低分辨率或形态学次数后重试。', true); }, 15000);
  } catch (error) { cancelJob(); stopRecording(); status(`无法检测：${error.message}`, true); }
}
function render() {
  if (!latest) return;
  const result = latest;
  canvas.width = result.width; canvas.height = result.height;
  if ($('bulletMask').checked) {
    const image = ctx.createImageData(result.width, result.height);
    for (let i = 0; i < result.mask.length; i++) { const at = i * 4; image.data[at] = image.data[at + 1] = image.data[at + 2] = result.mask[i] * 255; image.data[at + 3] = 255; }
    ctx.putImageData(image, 0, 0);
  } else ctx.putImageData(result.image, 0, 0);
  ctx.strokeStyle = '#87b9ff'; ctx.lineWidth = Math.max(1, result.width / 640); ctx.setLineDash([8, 8]); ctx.beginPath(); ctx.moveTo(result.width / 2, 0); ctx.lineTo(result.width / 2, result.height); ctx.stroke(); ctx.setLineDash([]);
  ctx.font = `${Math.max(12, result.width / 90)}px sans-serif`;
  for (const object of result.objects) {
    ctx.strokeStyle = ctx.fillStyle = object.mean >= result.config.green ? '#3eeaa1' : object.mean < result.config.red ? '#ff6e79' : '#ffce63';
    ctx.strokeRect(object.x, object.y, object.width, object.height);
    ctx.fillText(object.mean.toFixed(1), object.x, Math.max(15, object.y - 5));
  }
  $('bulletEmpty').hidden = true; $('bulletCount').textContent = result.count;
  $('bulletLeft').textContent = `${result.leftCount} / ${result.leftCount ? result.leftMean.toFixed(1) : '—'}`;
  $('bulletRight').textContent = `${result.rightCount} / ${result.rightCount ? result.rightMean.toFixed(1) : '—'}`;
  $('bulletVerdict').textContent = result.verdict; $('bulletVerdict').dataset.verdict = result.verdict;
  $('bulletDetails').textContent = `原图 ${result.originalWidth}×${result.originalHeight} → 处理 ${result.width}×${result.height} · 媒体时间 ${result.seconds.toFixed(3)} s · 目标平均亮度 ${result.count ? result.mean.toFixed(2) : '—'}`;
}
function setConfig(value) {
  config = validateConfig(value); epoch++; cancelJob(); stopRecording(); clearResults(); showConfig(); status('参数已应用。'); analyze();
}
function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('bulletParams').onsubmit = event => {
  event.preventDefault();
  try { setConfig(Object.fromEntries(fields.map(([key]) => [key, $(`bullet-${key}`).value === '' ? NaN : Number($(`bullet-${key}`).value)]))); }
  catch (error) { status(error.message, true); }
};
$('bulletReset').onclick = () => setConfig({ ...defaults });
$('bulletImport').onclick = () => $('bulletConfigFile').click();
$('bulletConfigFile').onchange = async () => {
  const file = $('bulletConfigFile').files[0]; $('bulletConfigFile').value = ''; if (!file) return;
  try { if (file.size > 65536) throw new Error('配置文件不能超过 64 KB'); setConfig(parseConfig(await file.text())); }
  catch (error) { status(`配置未更改：${error.message}`, true); }
};
$('bulletExport').onclick = () => download('pnx-bullet-config.json', JSON.stringify({ format: 'pnx-bullet', version: 1, parameters: config }, null, 2), 'application/json');
$('bulletOpen').onclick = () => $('bulletFile').click();
$('bulletFile').onchange = () => {
  const file = $('bulletFile').files[0]; $('bulletFile').value = ''; if (!file) return;
  resetInput(); const current = inputGeneration;
  objectUrl = URL.createObjectURL(file); status('正在加载输入…');
  if (/\.(png|jpe?g|webp|bmp)$/i.test(file.name) || file.type.startsWith('image/')) {
    const image = new Image(); image.onload = () => { if (inputGeneration === current) sourceReady(image, file.name, 'image'); };
    image.onerror = () => { if (inputGeneration === current) { resetInput(); status('无法读取图片，请使用 PNG、JPEG、WebP 或 BMP。', true); } }; image.src = objectUrl;
  } else {
    video.hidden = false;
    video.onloadeddata = () => { if (inputGeneration === current && !source) sourceReady(video, file.name, 'video'); };
    video.onerror = () => { if (inputGeneration === current) { resetInput(); status('此视频无法解码。请转为 H.264 MP4 或 VP8/VP9 WebM 后重试。', true); } };
    video.src = objectUrl; video.load();
  }
};
$('bulletDemo').onclick = () => {
  resetInput(); const sample = document.createElement('canvas'); sample.width = 960; sample.height = 540;
  const context = sample.getContext('2d'); context.fillStyle = '#080d12'; context.fillRect(0, 0, 960, 540);
  for (let i = 0; i < 36; i++) { const col = i % 9, row = Math.floor(i / 9); context.fillStyle = col < 4 ? '#65d97b' : '#164725'; context.beginPath(); context.arc(75 + col * 100, 80 + row * 125, 14, 0, Math.PI * 2); context.fill(); }
  sourceReady(sample, '示例：36 个独立荧光区域（合成数据）', 'demo');
};
$('bulletCamera').onclick = async () => {
  resetInput(); const current = inputGeneration; status('等待摄像头授权…');
  sourceKind = 'camera-pending'; $('bulletStop').disabled = false;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境不支持摄像头');
    const device = $('bulletCameraDevice').value, resolution = $('bulletCameraResolution').value, fps = Number($('bulletCameraFps').value);
    let media;
    try { media = await navigator.mediaDevices.getUserMedia(cameraConstraints(device, resolution, fps)); }
    catch (error) {
      if (error.name !== 'OverconstrainedError' || inputGeneration !== current) throw error;
      media = await navigator.mediaDevices.getUserMedia(cameraConstraints(device, resolution, fps, true));
    }
    if (inputGeneration !== current) { media.getTracks().forEach(track => track.stop()); return; }
    stream = media;
    const track = media.getVideoTracks()[0];
    if (!track) throw new Error('设备没有返回视频轨道');
    const settings = track.getSettings(), name = track.label || $('bulletCameraDevice').selectedOptions[0]?.textContent || '摄像头';
    video.onloadeddata = () => { if (inputGeneration === current && !source) sourceReady(video, name, 'camera'); };
    video.srcObject = media; video.hidden = false;
    inputStatus(`已连接 ${name} · 实际 ${settings.width || '?'}×${settings.height || '?'} / ${settings.frameRate?.toFixed(1) || '?'} FPS`);
    for (const track of media.getTracks()) track.onended = () => { if (inputGeneration === current) { resetInput(); status('摄像头已断开。', true); } };
    await video.play();
    void refreshCameras(false);
  } catch (error) { if (inputGeneration === current) { resetInput(); status(cameraError(error), true); inputStatus(cameraError(error)); } }
};
async function refreshCameras(authorize = false) {
  const generation = ++cameraRefreshGeneration, input = inputGeneration;
  try {
    if (!navigator.mediaDevices?.enumerateDevices) throw new Error('当前环境不能列出摄像头，请使用桌面应用或 Chrome / Edge 的本地页面。');
    if (authorize && !stream) {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      probe.getTracks().forEach(track => track.stop());
      if (generation !== cameraRefreshGeneration || input !== inputGeneration || document.body.dataset.view !== 'bullet') return;
    }
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput' && device.deviceId);
    if (generation !== cameraRefreshGeneration) return;
    const select = $('bulletCameraDevice'), previous = select.value;
    select.replaceChildren(new Option('系统默认摄像头', ''));
    devices.forEach((device, index) => select.add(new Option(device.label || `摄像头 ${index + 1}（授权后显示名称）`, device.deviceId)));
    if (previous && !devices.some(device => device.deviceId === previous)) select.add(new Option('原选择设备已离线，请重新选择', previous));
    select.value = previous;
    if (authorize) inputStatus(devices.length ? `找到 ${devices.length} 个视频输入，请选择设备后连接。` : '未发现系统视频输入，请检查手机摄像头模式或采集卡驱动。');
  } catch (error) { if (authorize) inputStatus(cameraError(error)); }
}
$('bulletCameraRefresh').onclick = () => refreshCameras(true);
navigator.mediaDevices?.addEventListener('devicechange', () => refreshCameras(false));
void refreshCameras(false);
function receiverOptions() { return { sdkDirectory: $('bulletSdkDirectory').value.trim(), usbLibrary: $('bulletUsbLibrary').value.trim() }; }
function rememberReceiver() { try { localStorage.setItem('pnx-bullet-receiver', JSON.stringify(receiverOptions())); } catch {} }
async function scanReceiver() {
  $('bulletReceiverScan').disabled = true; $('bulletReceiverConnect').disabled = true;
  $('bulletReceiverDevice').replaceChildren(new Option('扫描中…', '')); inputStatus('正在扫描 DJI USB 视频接口…');
  try {
    const result = await receiverApi('devices', receiverOptions());
    $('bulletReceiverDevice').replaceChildren(...result.devices.map(device => new Option(device.name, device.id)));
    if (!result.devices.length) $('bulletReceiverDevice').add(new Option('未发现匹配的视频接口', ''));
    $('bulletReceiverConnect').disabled = !result.devices.length; rememberReceiver();
    inputStatus(result.devices.length ? `找到 ${result.devices.length} 个 DJI 视频接口。连接前关闭原 BulletFluor / ReceiveEnd。` : '未发现 2CA3:1020 视频接口。检查 USB 数据线、接收端供电和厂商 libusb-win32 驱动。');
  } catch (error) { $('bulletReceiverDevice').replaceChildren(new Option('扫描失败', '')); inputStatus(error.message); }
  finally { $('bulletReceiverScan').disabled = false; }
}
$('bulletReceiverScan').onclick = scanReceiver;
for (const id of ['bulletSdkDirectory', 'bulletUsbLibrary']) $(id).addEventListener('input', () => { $('bulletReceiverConnect').disabled = true; });
async function pollReceiver(current, session) {
  if (inputGeneration !== current || receiverSession !== session) return;
  try {
    receiverAbort = new AbortController();
    const response = await fetch(`/api/bullet/receiver/frame?session=${encodeURIComponent(session)}&after=${receiverSequence}`, { headers: { 'X-PnX-Token': window.PNX_TOKEN }, signal: receiverAbort.signal });
    if (inputGeneration !== current) return;
    if (response.status === 204) {
      if (Date.now() - (receiverTimestamp || receiverStarted) > 16000) throw new Error('接收端已打开但未收到新画面，请检查发射端、配对和无线链路。');
    } else {
      if (!response.ok) throw new Error((await response.json()).error || '图传读取失败');
      const buffer = await response.arrayBuffer(); if (inputGeneration !== current) return;
      const frame = receiverPixels(buffer);
      receiverSequence = Number(response.headers.get('X-Frame-Sequence')); receiverTimestamp = Number(response.headers.get('X-Frame-Timestamp')) || Date.now();
      receiverCanvas.width = frame.width; receiverCanvas.height = frame.height;
      receiverCtx.putImageData(new ImageData(frame.rgba, frame.width, frame.height), 0, 0);
      if (!source) sourceReady(receiverCanvas, 'DJI USB 图传 · RC150', 'receiver'); else analyze();
      inputStatus(`DJI USB 已接收 · ${frame.width}×${frame.height} · 预览帧 ${receiverSequence}`);
    }
    receiverTimer = setTimeout(() => pollReceiver(current, session), 200);
  } catch (error) {
    if (inputGeneration !== current) return;
    resetInput(); status(error.message, true); inputStatus(error.message);
  }
}
$('bulletReceiverConnect').onclick = async () => {
  const options = { ...receiverOptions(), device: $('bulletReceiverDevice').value };
  resetInput(); const current = inputGeneration; sourceKind = 'receiver-pending'; $('bulletStop').disabled = false;
  status('正在打开图传接收端…'); inputStatus('正在加载接收桥接与 RC150 解码器…');
  try {
    await receiverClosing;
    if (inputGeneration !== current) return;
    const result = await receiverApi('start', options);
    if (inputGeneration !== current) { await releaseReceiver(result.session); return; }
    receiverSession = result.session; receiverStarted = Date.now(); rememberReceiver();
    status('USB 接收端已打开，等待图像…'); void pollReceiver(current, receiverSession);
  } catch (error) { if (inputGeneration === current) { resetInput(); status(error.message, true); inputStatus(error.message); } }
};
void receiverApi('info').then(info => {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('pnx-bullet-receiver') || '{}'); } catch {}
  if (!$('bulletSdkDirectory').value) $('bulletSdkDirectory').value = saved.sdkDirectory || info.defaultSdkDirectory || '';
  if (!$('bulletUsbLibrary').value) $('bulletUsbLibrary').value = saved.usbLibrary || info.defaultUsbLibrary || '';
  if (!info.supported) { $('bulletReceiverScan').disabled = true; inputStatus('此平台支持系统摄像头；专用 DJI USB 图传桥接目前仅支持 Windows x64。'); }
}).catch(error => inputStatus(`图传服务未就绪：${error.message}`));
$('bulletStop').onclick = () => { resetInput(); status('输入已关闭。'); };
$('bulletAnalyze').onclick = analyze;
$('bulletMask').onchange = render;
$('bulletRecord').onclick = () => {
  if (recording) { stopRecording(); return; }
  // Existing records must be explicitly exported/cleared before starting a new run.
  if (rows.length) { status('请先导出或清空已有记录，再开始新一轮记录。', true); return; }
  recordConfig = { ...config }; recordSource = sourceName; recording = true; updateRecording(); analyze();
};
$('bulletClear').onclick = () => { stopRecording(); rows = []; recordConfig = null; recordSource = null; updateRecording(); };
$('bulletCsv').onclick = () => {
  const quote = value => `"${String(value).replaceAll('"', '""')}"`;
  const header = ['Timestamp_UTC','Media_Time_s','Width','Height','Left_Mean','Right_Mean','Left_Count','Right_Count','Frame_Targets','Mean','Verdict','Source','Parameters_JSON'];
  const csv = [header, ...rows.map(row => [row.timestamp, row.seconds, row.width, row.height, row.leftCount ? row.leftMean : '', row.rightCount ? row.rightMean : '', row.leftCount, row.rightCount, row.count, row.count ? row.mean : '', row.verdict, recordSource, JSON.stringify(recordConfig)])].map(row => row.map(quote).join(',')).join('\r\n');
  download('pnx-bullet-frames.csv', '\uFEFF' + csv, 'text/csv;charset=utf-8');
};
$('bulletReport').onclick = () => {
  if (!latest) return;
  const { mask, image, ...report } = latest;
  download('pnx-bullet-result.json', JSON.stringify({ format: 'pnx-bullet-result', version: 1, counting: 'per-frame-connected-components', ...report }, null, 2), 'application/json');
};
video.addEventListener('play', schedule);
video.addEventListener('pause', () => { clearTimeout(timer); stopRecording(); });
video.addEventListener('seeking', () => { epoch++; cancelJob(); stopRecording(); clearResults(); });
video.addEventListener('seeked', analyze);
video.addEventListener('ended', () => { clearTimeout(timer); stopRecording(); });
function visibility() {
  if (document.hidden || document.body.dataset.view !== 'bullet') {
    clearTimeout(timer); epoch++; cancelJob(); stopRecording(); video.pause();
    if (stream || ['camera-pending', 'receiver', 'receiver-pending'].includes(sourceKind)) { resetInput(); status('离开检测页，设备已释放或取消连接。'); }
  } else if (source) analyze();
}
new MutationObserver(visibility).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
document.addEventListener('visibilitychange', visibility);
window.addEventListener('pagehide', () => { resetInput(); worker?.terminate(); });
