import http from 'node:http';
import { ReceiverService } from './bullet/receiver.mjs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DapSession, listProbes, resolveProbeSelection } from './dap.mjs';
import { globalScalars, globalTree, checkedWriteValue } from './global-variables.mjs';
import { SubscriptionBanks } from './subscription-banks.mjs';
import { loadWatchConfig, saveWatchConfig } from './watch-config.mjs';
import { Workspace } from './workspace.mjs';
import { CsvRecorder } from './csv-recorder.mjs';
import { scanToolchain, validateToolchain, verifyToolchain, toolchainPathDirectories, useToolchain, loadToolchain, saveToolchain, addToWindowsUserPath } from './toolchain.mjs';
import { findDefinitions } from './symbols.mjs';
import { checkStlinkDriver } from './stlink-driver.mjs';
import { initializerEvidence, markInitializedGlobals, verifyInitializer } from './initialized-globals.mjs';
import { ROOT, BACKEND } from './paths.mjs';
import { BOARDS, boardPaths, presetBoard, detect as isPnxProject } from './plugins/pnx/project.mjs';
import { pluginCatalog } from './plugins/registry.mjs';
import { detectProjectTarget } from './target-detection.mjs';
import { ProjectSettings, resolveTarget } from './project-settings.mjs';
import { bindingKinds, bindingValue, boardDefaults, fields, get, motorFields, motorModes, parameterActive, setPath, testRequirements, validate } from './plugins/pnx/config-editor.mjs';

const token = randomBytes(24).toString('hex');
const bulletReceiver = new ReceiverService();
const clients = new Set();
let session;
let sessionTransition = Promise.resolve();
let catalog = [];
let selected = [];
let selectedSet = new Set();
let subscriptionSequence = 0;
let currentBoard = 'h723_mc02';
const workspace = new Workspace(process.env.PNX_WORKSPACE_ROOT || null);
let projectRoot = isPnxProject(workspace.root) ? workspace.root : null;
let busy = false;
let writeBusy = false;
let lastStatus = 'Ready';
let pendingSamples, sampleFlushTimer;
let recording, lastRecording;
const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const cacheDir = process.env.PNX_CACHE_ROOT ? path.resolve(process.env.PNX_CACHE_ROOT) : path.join(ROOT, '.cache');
const toolchainFile = path.join(cacheDir, 'toolchain.json');
let configuredToolchain = loadToolchain(toolchainFile);
let latestToolchainScan;
const editorContexts = new Map();
const configureResults = new Map();
const buildJobs = Math.max(1, Math.min(8, availableParallelism()));
mkdirSync(cacheDir, { recursive: true });
const projectSettings = new ProjectSettings(path.join(cacheDir, 'projects'));
function projectProfile() { return projectSettings.load(workspace.root); }
function refreshProjectPlugin() { projectRoot = projectProfile().plugins.pnx && isPnxProject(workspace.root) ? workspace.root : null; }
refreshProjectPlugin();

function sendEvent(kind, data) {
  const payload = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (res.writableLength > 1024 * 1024) { clients.delete(res); res.destroy(); continue; }
    res.write(payload);
  }
}
function status(message) { lastStatus = String(message); sendEvent('status', lastStatus); process.stdout.write(`${lastStatus}\n`); }
const bankSize = Math.max(1, Math.min(256, Number(process.env.PNX_TEST_BANK_SIZE) || 256));
const subscriptions = new SubscriptionBanks(status, bankSize);
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
function error(res, err) { json(res, 400, { error: err instanceof Error ? err.message : String(err) }); }
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 2_000_000) throw new Error('Request too large'); }
  return data ? JSON.parse(data) : {};
}
function workspaceBuildPresets() {
  const root = workspace.root;
  if (!root || !existsSync(path.join(root, 'CMakeLists.txt')) || !existsSync(path.join(root, 'CMakePresets.json'))) return { root, presets: [] };
  const data = JSON.parse(readFileSync(path.join(root, 'CMakePresets.json'), 'utf8'));
  const presets = (data.configurePresets || []).filter(item => item?.name && !item.hidden).map(item => item.name);
  return { root, presets };
}
function buildDirectory(preset) {
  const { root, presets } = workspaceBuildPresets();
  if (!root || !presets.includes(preset) || !/^[A-Za-z0-9_.-]+$/.test(preset)) throw new Error('Choose a CMake preset from the open folder first');
  return path.join(root, 'build', preset);
}
function configureArguments(preset, buildDir) {
  const args = ['--preset', preset, '-B', buildDir];
  const file = path.join(buildDir, 'CMakeCache.txt');
  if (existsSync(file)) {
    const cache = readFileSync(file, 'utf8');
    const normalize = value => { const result = path.resolve(value).replaceAll('\\', '/'); return process.platform === 'win32' ? result.toLowerCase() : result; };
    const home = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m.exec(cache)?.[1]?.trim();
    const directory = /^CMAKE_CACHEFILE_DIR:INTERNAL=(.+)$/m.exec(cache)?.[1]?.trim();
    if (!home || normalize(home) !== normalize(workspace.root) || (directory && normalize(directory) !== normalize(buildDir))) args.push('--fresh');
  }
  return args;
}
function runCommand(exe, args, cwd, channel = 'general') {
  status(`Running: ${path.basename(exe)} ${args.join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, windowsHide: true });
    child.stdout.on('data', data => sendEvent('log', { channel, text: String(data) }));
    child.stderr.on('data', data => sendEvent('log', { channel, text: String(data) }));
    child.on('error', reject);
    child.on('exit', code => { if (code === 0) { status('Command completed'); resolve(); } else reject(new Error(`${path.basename(exe)} exited with ${code}`)); });
  });
}
async function commandSequence(steps) {
  if (busy) throw new Error('Another command is running');
  busy = true;
  try { for (const [exe, args, cwd, channel] of steps) { if (!cwd) throw new Error('Open a project folder first'); await runCommand(exe, args, cwd, channel); } }
  finally { busy = false; }
}
function command(exe, args, cwd = projectRoot, channel = 'general') {
  return commandSequence([[exe, args, cwd, channel]]);
}
function readBoard(board) {
  if (!projectRoot) throw new Error('Open a PnX project folder first');
  const paths = boardPaths(board, projectRoot);
  const params = JSON.parse(readFileSync(paths.params, 'utf8'));
  const robot = JSON.parse(readFileSync(paths.robot, 'utf8'));
  return { board, paths, params, robot };
}
async function resources(board) {
  const data = readBoard(board);
  const descriptors = JSON.parse(readFileSync(path.join(ROOT, 'src', 'plugins', 'pnx', 'board-resources.json'), 'utf8'));
  const descriptor = descriptors[board];
  if (!descriptor) throw new Error(`No built-in hardware description for ${board}`);
  const boardFile = path.join(projectRoot, 'boards', board, 'board.json');
  const projectBoard = existsSync(boardFile) ? JSON.parse(readFileSync(boardFile, 'utf8')) : null;
  const context = { formatVersion: 1, board, files: { ...data.paths, board: projectBoard ? boardFile : null },
    mcuFamily: projectBoard?.mcu_family || descriptor.mcuFamily,
    hardware: structuredClone(descriptor.hardware) };
  if (projectBoard?.bindings) {
    context.hardware.gpio_input_role = Object.keys(projectBoard.bindings.gpio_inputs || {});
    context.hardware.gpio_output_role = Object.keys(projectBoard.bindings.gpio_outputs || {});
  }
  editorContexts.set(board, context);
  return { ...data, context, hardware: context.hardware, presets: BOARDS[board].presets };
}
async function configEditorState(board, role, preset, refresh = false) {
  if (!['params','robot','hardware'].includes(role)) throw new Error('Unknown configuration page');
  readBoard(board);
  if (preset && presetBoard(preset) !== board) throw new Error('Preset does not match the selected board');
  let context = editorContexts.get(board);
  if (!context || refresh) context = (await resources(board)).context;
  const hardware = Object.fromEntries(Object.entries(context.hardware || {}).map(([key, value]) => [key, Array.isArray(value) ? value : value]));
  const configs = currentConfig(board);
  const item = role === 'hardware' ? null : configs[role];
  const data = item?.value;
  const defaults = boardDefaults(board);
  const definitions = data ? fields(role, data, hardware).map(field => ({ ...field, default: get(defaults, field.path) ?? field.default })) : [];
  const errors = {};
  if (data) for (const field of definitions) {
    const value = get(data, field.path);
    if (role === 'params' && field.path[0] === 'test' && !preset?.endsWith('-diagnose')) continue;
    if (value === undefined || (role === 'params' && !parameterActive(field.path, data, configs.robot.value))) continue;
    try { validate(field, value, hardware); } catch (err) { errors[field.path.join('.')] = err.message; }
  }
  if (role === 'params' && preset?.endsWith('-diagnose')) Object.assign(errors, testRequirements(data, configs.robot.value));
  if (role === 'robot' && Array.isArray(data?.devices?.motors?.list)) data.devices.motors.list.forEach((motor, index) => {
    for (const field of motorFields) {
      const value = motor[field.path[0]];
      if (value === undefined && field.path[0] === 'control_mode') continue;
      try { validate(field, value, hardware); } catch (err) { errors[`devices.motors.list.${index}.${field.path[0]}`] = err.message; }
    }
  });
  const chosenPreset = preset || BOARDS[board].presets[0];
  const configureResult = configureResults.get(`${projectRoot}|${chosenPreset}`);
  return { type: role === 'hardware' ? 'hardware' : 'render', role, version: item?.hash, data, error: '', board, preset: chosenPreset, presets: BOARDS[board].presets,
    context: { ...context, hardware }, fresh: true, trusted: true, status: configureResult?.status || '资源已刷新', last: configureResult?.last || '尚未 Configure', reason: '使用平台内置板卡资源与当前项目配置',
    local: Object.keys(errors).length ? '本地检查有问题' : configureResult?.status?.includes('成功') ? 'CMake 已通过' : '已覆盖字段本地检查通过，CMake 仍需确认', errors, fields: definitions,
    defaults, bindingKinds, motorFields, modeMap: Object.fromEntries(motorFields[1].choices.map(model => [model, motorModes(model)])) };
}
async function configEditorAction(input) {
  const { board, role, version, action } = input;
  if (!['params','robot'].includes(role)) throw new Error('Open Application or Robot first');
  const { context: { hardware } } = await configEditorState(board, role, input.preset);
  const current = currentConfig(board)[role];
  if (current.hash !== version) throw new Error('Configuration changed on disk; reload before editing');
  const data = structuredClone(current.value);
  const defaults = boardDefaults(board);
  if (role === 'params' && action === 'binding') {
    const kind = input.kind;
    if (!Object.hasOwn(bindingKinds, kind)) throw new Error('Unknown binding group');
    const validName = name => typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !['__proto__','prototype','constructor'].includes(name);
    const parent = ['bindings',kind];
    if (!validName(input.name)) throw new Error('Binding name must be a C++ identifier');
    const currentValue = get(data, [...parent,input.name]);
    if (input.operation === 'rename') {
      if (!validName(input.old)) throw new Error('Invalid original binding name');
      const oldValue = get(data, [...parent,input.old]);
      if (oldValue === undefined || (input.old !== input.name && currentValue !== undefined)) throw new Error('Binding was removed or the new name exists');
      setPath(data, [...parent,input.old], undefined); setPath(data, [...parent,input.name], oldValue);
    } else if (input.operation === 'delete') {
      if (currentValue === undefined) throw new Error('Binding no longer exists');
      setPath(data, [...parent,input.name], undefined);
    } else if (['add','update'].includes(input.operation)) {
      if ((input.operation === 'add' && currentValue !== undefined) || (input.operation === 'update' && currentValue === undefined)) throw new Error('Binding changed on disk');
      let value = bindingValue(kind, input.resource, hardware);
      if (kind === 'can_buses' && currentValue && typeof currentValue === 'object') value = { ...currentValue, bus: value };
      setPath(data, [...parent,input.name], value);
    } else throw new Error('Unknown binding operation');
  } else if (role === 'params' && action === 'addField') {
    const parts = input.path;
    if (!Array.isArray(parts) || !parts.length || parts[0] === 'bindings' || parts.some(key => typeof key !== 'string' || !key || ['__proto__','prototype','constructor'].includes(key))) throw new Error('Invalid field path');
    if (get(data, parts) !== undefined) throw new Error('Field already exists');
    const field = fields(role, data, hardware).find(item => item.path.join('.') === parts.join('.'));
    if (field) validate(field, input.value, hardware);
    setPath(data, parts, input.value);
  } else if (role === 'params' && action === 'resetDefaults') {
    const parts = input.group ? [input.group] : [];
    const value = get(defaults, parts);
    if (!value || typeof value !== 'object') throw new Error('No defaults for this group');
    const visit = (entry, target) => {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)) for (const [key, child] of Object.entries(entry)) visit(child, [...target,key]);
      else setPath(data, target, entry);
    };
    visit(value, parts);
  } else if (action === 'set') {
    const field = fields(role, data, hardware).find(item => item.path.join('.') === input.path?.join('.'));
    if (!field) throw new Error('Unsupported field');
    const value = input.default ? get(defaults, field.path) ?? field.default : input.value;
    if (value === undefined) throw new Error('No confirmed default for this field');
    validate(field, value, hardware);
    setPath(data, field.path, value);
  } else if (role === 'robot' && ['addMotor','editMotor','deleteMotor'].includes(action)) {
    if (!data.devices || typeof data.devices !== 'object') data.devices = {};
    if (!data.devices.motors || typeof data.devices.motors !== 'object') data.devices.motors = {};
    const list = data.devices.motors.list ?? [];
    if (!Array.isArray(list)) throw new Error('motors.list must be an array');
    if (action !== 'addMotor' && (!Number.isInteger(input.index) || input.index < 0 || input.index >= list.length)) throw new Error('Motor index is stale');
    if (action === 'deleteMotor') list.splice(input.index, 1);
    else {
      const value = {};
      for (const field of motorFields) {
        const key = field.path[0], entry = input.value?.[key];
        if (entry === undefined && key === 'control_mode') continue;
        validate(field, entry, hardware); value[key] = entry;
      }
      if (!motorModes(value.model).includes(value.control_mode || 'relax')) throw new Error('Selected mode is not supported by this motor model');
      if (action === 'addMotor') list.push(value); else list[input.index] = { ...list[input.index], ...value };
    }
    data.devices.motors.list = list;
  } else throw new Error('Unsupported configuration action');
  saveConfig(board, role, data, version);
  return configEditorState(board, role, input.preset);
}
function saveConfig(board, kind, value, expectedHash) {
  if (!['params', 'robot'].includes(kind)) throw new Error('Only params and robot config are editable');
  const target = boardPaths(board, projectRoot)[kind];
  const old = readFileSync(target);
  const actualHash = createHash('sha256').update(old).digest('hex');
  if (actualHash !== expectedHash) throw new Error('Configuration changed on disk; reload before saving');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration must be a JSON object');
  const temp = `${target}.pnx-platform-tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try { renameSync(temp, target); } catch (err) { throw err; }
  for (const preset of BOARDS[board].presets) configureResults.delete(`${projectRoot}|${preset}`);
  return createHash('sha256').update(readFileSync(target)).digest('hex');
}
function currentConfig(board) {
  const paths = boardPaths(board, projectRoot);
  return Object.fromEntries(['params', 'robot'].map(kind => {
    const bytes = readFileSync(paths[kind]);
    return [kind, { value: JSON.parse(bytes.toString('utf8')), hash: createHash('sha256').update(bytes).digest('hex') }];
  }));
}
function hashFile(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function flatten(items, result = []) {
  return globalScalars(items, result);
}
function clearPendingSamples() {
  if (sampleFlushTimer) clearTimeout(sampleFlushTimer);
  sampleFlushTimer = undefined; pendingSamples = undefined;
}
function flushSamples() {
  sampleFlushTimer = undefined;
  if (!pendingSamples) return;
  if (pendingSamples.points.length > 256) {
    const step = Math.ceil(pendingSamples.points.length / 256);
    pendingSamples.points = pendingSamples.points.filter((_, index) => index % step === 0 || index === pendingSamples.points.length - 1);
  }
  sendEvent('samples', pendingSamples);
  pendingSamples = undefined;
}
function onBatch(batch) {
  if (!selected.length || !batch.sampleCount) return;
  if (recording?.active) { recording.appendBatch(batch); if (!recording.active) void stopRecording(); }
  if (!clients.size) return;
  const channels = new Map(batch.channelIds.map((id, index) => [id, index]));
  const ids = batch.channelIds.filter(id => selectedSet.has(id));
  if (!ids.length) return;
  const indices = ids.map(id => channels.get(id));
  if (pendingSamples && (pendingSamples.streamEpoch !== batch.streamEpoch || pendingSamples.ids.length !== ids.length || pendingSamples.ids.some((id, index) => id !== ids[index]))) flushSamples();
  if (!pendingSamples) pendingSamples = { ids, points: [], latest: [], sampleCount: 0, samplePeriodNs: batch.samplePeriodNs,
    droppedFrames: batch.droppedFrames, streamEpoch: batch.streamEpoch, batchSequence: batch.batchSequence };
  const step = Math.max(1, Math.ceil(batch.sampleCount / 64));
  for (let sample = 0; sample < batch.sampleCount; sample += step) {
    const row = indices.map(index => index < 0 ? null : batch.values[sample * batch.channelIds.length + index]);
    pendingSamples.points.push([batch.startTimestampNs + sample * batch.samplePeriodNs, ...row]);
  }
  pendingSamples.latest = indices.map(index => index < 0 ? null : batch.values[(batch.sampleCount - 1) * batch.channelIds.length + index]);
  pendingSamples.sampleCount += batch.sampleCount;
  pendingSamples.samplePeriodNs = batch.samplePeriodNs;
  pendingSamples.droppedFrames = batch.droppedFrames;
  pendingSamples.batchSequence = batch.batchSequence;
  if (!sampleFlushTimer) sampleFlushTimer = setTimeout(flushSamples, 33);
}
async function stopRecording() {
  if (!recording) return lastRecording || null;
  const current = recording;
  recording = undefined;
  try { lastRecording = await current.stop(); }
  catch (error) { lastRecording = current.status(); status(`CSV 记录失败：${error.message}`); }
  sendEvent('record', lastRecording);
  return lastRecording;
}
async function stopSession() {
  subscriptionSequence++;
  await stopRecording();
  subscriptions.stop();
  clearPendingSamples();
  const old = session;
  session = undefined; catalog = []; selected = []; selectedSet.clear();
  if (old) await old.stop();
  sendEvent('catalog', { variables: [], tree: [] });
  status('Disconnected');
}
function serializeSession(work) {
  const result = sessionTransition.then(work, work);
  sessionTransition = result.catch(() => {});
  return result;
}
async function connectSession(input) {
  await stopSession();
  const mock = input.mock === true;
  if (!mock && !workspace.root) throw new Error('Open a project folder first');
  const target = mock ? { chip: 'Cortex-M Mock', board: 'h723_mc02' } : resolveTarget(workspace.root, projectProfile(), input.preset, buildDirectory);
  const { board, elf, chip } = target;
  if (!mock && !existsSync(elf)) throw new Error(`ELF not found: ${elf}. Build the selected preset first.`);
  const probe = mock ? null : resolveProbeSelection(await listProbes(), input.probe, input.allowFlash === true || input.allowDebug === true);
  if (probe?.changed) status(`Selected probe was disconnected; using ${probe.selector}`);
  const requestedSpeed = Number(input.speedKHz) || 4000;
  const speeds = mock ? [requestedSpeed] : [...new Set([requestedSpeed, 1000, 400].filter(speed => speed <= requestedSpeed))];
  let next;
  for (let attempt = 0; attempt < speeds.length; attempt++) {
    const candidate = new DapSession(
      batch => { if (session === candidate) onBatch(batch); },
      message => { if (session === candidate) status(message); },
      (event, data) => { if (session === candidate && input.allowDebug === true && input.allowFlash !== true) sendEvent('debug', { event, ...data }); },
    );
    session = candidate;
    try {
      catalog = await candidate.start({ mock, chip, elf, probe: probe?.selector, speedKHz: speeds[attempt],
        rate: Number(input.rate) || 1000, allowFlash: input.allowFlash === true, allowDebug: input.allowDebug === true });
      next = candidate;
      if (attempt) status(`探针已使用 ${speeds[attempt]} kHz 连接（请求 ${requestedSpeed} kHz）`);
      break;
    } catch (error) {
      await stopSession();
      const message = String(error.message || error);
      if (/Disconnected|ConnectionAborted|no longer connected/i.test(message)) {
        throw new Error(`探针 USB 连接已断开。请重新插拔探针、检查 USB 线及供电，再扫描并连接。原始错误：${message}`);
      }
      if (!/NoAcknowledge/.test(message) || attempt === speeds.length - 1) {
        if (/NoAcknowledge/.test(message)) throw new Error(`目标芯片未响应 SWD（已尝试 ${speeds.slice(0, attempt + 1).join(' / ')} kHz）。请检查目标供电、共地、SWDIO/SWCLK 接线和芯片型号，并关闭其它调试软件。原始错误：${message}`);
        throw error;
      }
      status(`目标未应答；释放探针后以 ${speeds[attempt + 1]} kHz 重试`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  next.meta = { board, preset: input.preset, mock, allowFlash: input.allowFlash === true, allowDebug: input.allowDebug === true && input.allowFlash !== true,
    elfPath: elf,
    elfHash: elf ? hashFile(elf) : undefined,
    paramsHash: mock || !projectRoot || !board ? undefined : currentConfig(board).params.hash,
    robotHash: mock || !projectRoot || !board ? undefined : currentConfig(board).robot.hash };
  let evidence = new Map();
  if (!mock) {
    try { evidence = await initializerEvidence(workspace.root, elf); }
    catch (error) { status(`无法验证全局变量初始化，变量保持只读：${error.message}`); }
  }
  markInitializedGlobals(catalog, evidence);
  const variables = flatten(catalog);
  const tree = globalTree(catalog);
  sendEvent('catalog', { variables, tree });
  return { variables, tree, board, chip, elf, probe: probe?.selector };
}
async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const bulletFiles = { '/bullet.js': 'text/javascript', '/bullet-core.mjs': 'text/javascript', '/bullet-worker.mjs': 'text/javascript', '/bullet-input.mjs': 'text/javascript', '/bullet.css': 'text/css' };
  if (Object.hasOwn(bulletFiles, url.pathname) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': `${bulletFiles[url.pathname]}; charset=utf-8`, 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(webDir, 'bullet', url.pathname.slice(1)))); return;
  }
  if (url.pathname === '/' && req.method === 'GET') {
    const page = readFileSync(path.join(webDir, 'index.html'), 'utf8').replace('__PNX_TOKEN__', token);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page); return;
  }
  if (['/app.js', '/markdown.js', '/editor-editing.js'].includes(url.pathname) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(webDir, url.pathname.slice(1)))); return;
  }
  if (url.pathname === '/style.css' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(webDir, 'style.css'))); return;
  }
  if (url.pathname === '/pnx-diagnostics.js' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(webDir, 'plugins', 'pnx', 'diagnostics.js'))); return;
  }
  if (url.pathname === '/config-editor' && req.method === 'GET') {
    const page = readFileSync(path.join(webDir, 'plugins', 'pnx', 'config-host.html'), 'utf8').replace('__PNX_TOKEN__', token);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(page); return;
  }
  if (['/config-editor.js','/config-host.js'].includes(url.pathname) && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(webDir, 'plugins', 'pnx', path.basename(url.pathname)))); return;
  }
  if (url.pathname === '/config-editor.css' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(readFileSync(path.join(webDir, 'plugins', 'pnx', 'config-editor.css'))); return;
  }
  if (req.headers['x-pnx-token'] !== token && url.searchParams.get('token') !== token) { json(res, 403, { error: 'Invalid local session token' }); return; }
  if (url.pathname === '/api/bullet/receiver/info' && req.method === 'GET') { json(res, 200, bulletReceiver.info()); return; }
  if (url.pathname === '/api/bullet/receiver/devices' && req.method === 'POST') { json(res, 200, await bulletReceiver.devices(await body(req))); return; }
  if (url.pathname === '/api/bullet/receiver/start' && req.method === 'POST') { json(res, 200, await bulletReceiver.start(await body(req))); return; }
  if (url.pathname === '/api/bullet/receiver/stop' && req.method === 'POST') {
    const input = await body(req);
    if (typeof input.session !== 'string') throw new Error('Missing receiver session');
    await bulletReceiver.stop(input.session); json(res, 200, { ok: true }); return;
  }
  if (url.pathname === '/api/bullet/receiver/frame' && req.method === 'GET') {
    const value = bulletReceiver.frame(url.searchParams.get('session'), Number(url.searchParams.get('after')) || 0);
    if (!value) { res.writeHead(204, { 'Cache-Control': 'no-store' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Frame-Sequence': String(value.sequence), 'X-Frame-Timestamp': String(value.timestamp) });
    res.end(value.frame); return;
  }
  if (url.pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    clients.add(res); res.write(`event: status\ndata: ${JSON.stringify(lastStatus)}\n\n`);
    req.on('close', () => clients.delete(res)); return;
  }
  if (url.pathname === '/api/workspace' && req.method === 'GET') { json(res, 200, { root: workspace.root, projectRoot }); return; }
  if (url.pathname === '/api/toolchain/status' && req.method === 'GET') { json(res, 200, { configured: configuredToolchain }); return; }
  if (url.pathname === '/api/toolchain/scan' && req.method === 'GET') {
    const folder = url.searchParams.get('folder');
    if (folder && !path.isAbsolute(folder)) throw new Error('Tool search folder must be absolute');
    if (folder && !existsSync(folder)) throw new Error('Tool search folder does not exist');
    latestToolchainScan = { result: scanToolchain({ roots: folder ? [folder] : undefined, preferRoots: !!folder }), time: Date.now() };
    json(res, 200, latestToolchainScan.result); return;
  }
  if (url.pathname === '/api/probes' && req.method === 'GET') { json(res, 200, { probes: await listProbes() }); return; }
  if (url.pathname === '/api/probes/stlink-driver' && req.method === 'GET') { json(res, 200, await checkStlinkDriver()); return; }
  if (url.pathname === '/api/project-detection' && req.method === 'GET') { json(res,200,detectProjectTarget(workspace.root,true)); return; }
  if (url.pathname === '/api/project-settings' && req.method === 'GET') { json(res, 200, { ...projectProfile(), availablePlugins: pluginCatalog(workspace.root, projectProfile().plugins), root: workspace.root, pnxDetected: isPnxProject(workspace.root), projectRoot }); return; }
  if (url.pathname === '/api/workspace/build-presets' && req.method === 'GET') { json(res, 200, { ...workspaceBuildPresets(), isPnx: !!projectRoot }); return; }
  if (url.pathname === '/api/record/status' && req.method === 'GET') { json(res, 200, recording?.status() || lastRecording || { active: false, file: null, rows: 0, bytes: 0 }); return; }
  if (url.pathname === '/api/record/csv' && req.method === 'GET') {
    if (!lastRecording?.file || !existsSync(lastRecording.file)) throw new Error('No completed CSV recording');
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${path.basename(lastRecording.file)}"`, 'Cache-Control': 'no-store' });
    createReadStream(lastRecording.file).pipe(res); return;
  }
  if (url.pathname === '/api/config-editor/state' && req.method === 'GET') {
    json(res, 200, await configEditorState(url.searchParams.get('board'), url.searchParams.get('role') || 'params', url.searchParams.get('preset'), url.searchParams.get('refresh') === '1')); return;
  }
  if (url.pathname === '/api/catalog' && req.method === 'GET') { json(res, 200, { connected: !!session && !session.closed, variables: flatten(catalog), tree: globalTree(catalog), selected }); return; }
  if (url.pathname === '/api/workspace/list' && req.method === 'GET') { json(res, 200, { entries: workspace.list(url.searchParams.get('path') || '') }); return; }
  if (url.pathname === '/api/workspace/file' && req.method === 'GET') { json(res, 200, workspace.read(url.searchParams.get('path') || '')); return; }
  if (url.pathname === '/api/boards' && req.method === 'GET') { json(res, 200, { boards: BOARDS, backend: existsSync(BACKEND), projectRoot }); return; }
  if (url.pathname === '/api/board' && req.method === 'GET') {
    const board = url.searchParams.get('board') || currentBoard;
    currentBoard = board;
    const info = await resources(board);
    json(res, 200, { board, hardware: info.hardware, presets: info.presets, config: currentConfig(board) }); return;
  }
  if (url.pathname === '/api/watch-config' && req.method === 'GET') { json(res,200,{config:loadWatchConfig(workspace)}); return; }
  const input = await body(req);
  if (url.pathname === '/api/watch-config' && req.method === 'POST') { json(res,200,saveWatchConfig(workspace,input)); return; }
  if (url.pathname === '/api/project-settings' && req.method === 'POST') {
    const result = await serializeSession(async () => {
      if (busy) throw new Error('Wait for the current build before changing project settings');
      const settings = projectSettings.validate(input);
      await stopSession(); projectSettings.save(workspace.root, settings); refreshProjectPlugin(); editorContexts.clear();
      return { ...settings, root: workspace.root, projectRoot, pnxDetected: isPnxProject(workspace.root) };
    });
    json(res, 200, result); return;
  }
  if (url.pathname === '/api/workspace/open' && req.method === 'POST') {
    const result = await serializeSession(async () => {
      if (busy) throw new Error('Wait for the current command to finish before switching folders');
      const previousRoot = workspace.root;
      const opened = workspace.open(input.folder);
      const nextProject = projectSettings.load(opened.root).plugins.pnx && isPnxProject(opened.root) ? opened.root : null;
      if (opened.root !== previousRoot || nextProject !== projectRoot) { await stopSession(); projectRoot = nextProject; editorContexts.clear(); }
      return { ...opened, isPnx: !!projectRoot, projectRoot };
    });
    json(res, 200, result); return;
  }
  if (url.pathname === '/api/workspace/file' && req.method === 'POST') { json(res, 200, workspace.save(input.path, input.text, input.expectedHash)); return; }
  if (url.pathname === '/api/workspace/definitions' && req.method === 'POST') {
    const overrides = input.overrides && typeof input.overrides === 'object' && !Array.isArray(input.overrides) ? input.overrides : {};
    json(res, 200, { matches: await findDefinitions(workspace, input.name, overrides) }); return;
  }
  if (url.pathname === '/api/config' && req.method === 'POST') {
    const hash = saveConfig(input.board, input.kind, input.value, input.expectedHash);
    json(res, 200, { hash }); return;
  }
  if (url.pathname === '/api/toolchain/configure' && req.method === 'POST') {
    if (!latestToolchainScan || Date.now() - latestToolchainScan.time > 120000 || !latestToolchainScan.result.complete) throw new Error('Scan for a complete toolchain first');
    const tools = validateToolchain(latestToolchainScan.result.tools);
    const versions = await verifyToolchain(tools);
    const additions = toolchainPathDirectories(tools);
    saveToolchain(toolchainFile, tools);
    useToolchain(tools);
    configuredToolchain = tools;
    latestToolchainScan = undefined;
    let userPathError = null;
    try { await addToWindowsUserPath(additions); } catch (failure) { userPathError = failure.message; }
    json(res, 200, { configured: tools, versions, added: additions, scope: process.platform === 'win32' && !userPathError ? 'user' : 'app', userPathError }); return;
  }
  if (url.pathname === '/api/config-editor/action' && req.method === 'POST') { json(res, 200, await configEditorAction(input)); return; }
  if (url.pathname === '/api/record/start' && req.method === 'POST') {
    if (!session || !selected.length) throw new Error('Subscribe to variables before recording');
    if (recording?.active) throw new Error('CSV recording is already active');
    if (recording) await stopRecording();
    const variables = new Map(flatten(catalog).map(variable => [variable.id, variable]));
    recording = await CsvRecorder.start(process.env.PNX_CAPTURE_ROOT || workspace.root, selected.map(id => variables.get(id)).filter(Boolean));
    lastRecording = undefined;
    sendEvent('record', recording.status());
    json(res, 200, recording.status()); return;
  }
  if (url.pathname === '/api/record/stop' && req.method === 'POST') {
    if (!recording) throw new Error('No active CSV recording');
    json(res, 200, await stopRecording()); return;
  }
  if (url.pathname === '/api/configure' && req.method === 'POST') {
    const buildDir = buildDirectory(input.preset);
    try {
      await command('cmake', configureArguments(input.preset, buildDir), workspace.root, 'build');
      configureResults.set(`${workspace.root}|${input.preset}`, { status: 'Configure 成功', last: `${input.preset}: 成功` });
    } catch (err) { configureResults.set(`${workspace.root}|${input.preset}`, { status: 'Configure 失败', last: `${input.preset}: ${err.message}` }); throw err; }
    json(res, 200, { ok: true, buildDir }); return;
  }
  if (url.pathname === '/api/build' && req.method === 'POST') {
    const task = projectProfile().build;
    if (task.executable) { await command(task.executable, task.args, workspace.root, 'build'); detectProjectTarget(workspace.root, true); json(res, 200, { ok: true, elf: projectProfile().target.elf }); return; }
    const buildDir = buildDirectory(input.preset);
    try {
      await commandSequence([
        ['cmake', configureArguments(input.preset, buildDir), workspace.root, 'build'],
        ['cmake', ['--build', buildDir, '--parallel', String(buildJobs)], workspace.root, 'build'],
      ]);
      configureResults.set(`${workspace.root}|${input.preset}`, { status: '编译成功', last: `${input.preset}: Configure + Build 成功` });
    } catch (err) { configureResults.set(`${workspace.root}|${input.preset}`, { status: '编译失败', last: `${input.preset}: ${err.message}` }); throw err; }
    const detected = detectProjectTarget(workspace.root, true, buildDir);
    json(res, 200, { ok: true, buildDir, elf: projectRoot ? resolveTarget(workspace.root, projectProfile(), input.preset, buildDirectory).elf : detected.elf || undefined }); return;
  }
  if (url.pathname === '/api/connect' && req.method === 'POST') {
    json(res, 200, await serializeSession(() => connectSession(input))); return;
  }
  if (url.pathname === '/api/subscribe' && req.method === 'POST') {
    if (!session) throw new Error('Connect first');
    if (session.meta?.allowFlash) throw new Error('Sampling is disabled in a programming session');
    await stopRecording();
    const valid = new Set(flatten(catalog).map(value => value.id));
    const requested = [...new Set(input.ids || [])].filter(id => valid.has(id));
    const requestSequence = ++subscriptionSequence;
    clearPendingSamples(); selected = requested; selectedSet = new Set(selected);
    let rotation;
    try { rotation = await subscriptions.set(session, requested, Number(input.rate) || 1000); }
    catch (error) {
      if (requestSequence === subscriptionSequence) { selected = []; selectedSet.clear(); }
      throw error;
    }
    if (requestSequence !== subscriptionSequence) throw new Error('Subscription superseded by another request');
    json(res, 200, { ids: requested, ...rotation }); return;
  }
  if (url.pathname === '/api/write-variable' && req.method === 'POST') {
    if (!session || session.closed || session.meta?.mock || !session.meta?.allowDebug) throw new Error('Connect a real target with write access first');
    if (writeBusy) throw new Error('Another variable write is in progress');
    if (typeof input.id !== 'string') throw new Error('Choose a global variable');
    const variable = flatten(catalog).find(item => item.id === input.id);
    const value = checkedWriteValue(variable, input.value);
    if (!session.meta.elfPath || !existsSync(session.meta.elfPath) || hashFile(session.meta.elfPath) !== session.meta.elfHash)
      throw new Error('ELF changed after connection; reconnect before writing');
    writeBusy = true;
    try {
      const writer = session;
      await verifyInitializer(variable);
      if (session !== writer || writer.closed) throw new Error('Target connection changed before writing');
      const result = await session.writeValue(input.id, value);
      if (result.verified !== true) throw new Error('Target readback did not verify the written value');
      json(res, 200, { id: input.id, value: result.value, verified: true });
    } finally { writeBusy = false; }
    return;
  }
  if (url.pathname === '/api/debug' && req.method === 'POST') {
    if (!session || session.meta?.mock || !session.meta?.allowDebug) throw new Error('Connect a real board in debug mode first');
    if (!['pause', 'continue', 'next', 'stepIn', 'stepOut'].includes(input.command)) throw new Error('Unsupported debug command');
    await session.debug(input.command);
    json(res, 200, { ok: true, command: input.command }); return;
  }
  if (url.pathname === '/api/debug/snapshot' && req.method === 'POST') {
    if (!session || session.closed) throw new Error('Connect a target first');
    if (session.meta?.allowFlash) throw new Error('Inspection is disabled in a programming session');
    const ids = input.ids ?? [];
    if (!Array.isArray(ids) || ids.length > 40 || ids.some(id => typeof id !== 'string')) throw new Error('Invalid diagnostic variables');
    const allowed = new Set(globalScalars(catalog).map(item => item.id));
    if (ids.some(id => !allowed.has(id))) throw new Error('Diagnostic variable is not a direct global scalar');
    const includeStack = input.includeStack === true;
    if (includeStack && (session.meta?.mock || !session.meta?.allowDebug)) throw new Error('Connect a real board in debug mode to inspect the stopped location');
    json(res, 200, await session.debugSnapshot([...new Set(ids)], includeStack)); return;
  }
  if (url.pathname === '/api/debug/breakpoints' && req.method === 'POST') {
    if (!session || session.closed || session.meta?.mock || !session.meta?.allowDebug) throw new Error('Connect a real board in debug mode first');
    if (!session.meta.elfPath || !existsSync(session.meta.elfPath) || hashFile(session.meta.elfPath) !== session.meta.elfHash)
      throw new Error('ELF changed after connection; reconnect before setting breakpoints');
    if (typeof input.path !== 'string' || !/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(input.path)) throw new Error('Choose a C/C++ source file');
    const source = workspace.resolve(input.path);
    const lines = input.lines;
    if (!Array.isArray(lines) || lines.length > 64 || lines.some(line => !Number.isSafeInteger(line) || line < 1)) throw new Error('Invalid breakpoint lines');
    const result = await session.setBreakpoints(source, lines);
    json(res, 200, result); return;
  }
  if (url.pathname === '/api/flash' && req.method === 'POST') {
    await serializeSession(async () => {
    if (!session || session.meta?.mock || !session.meta?.allowFlash) throw new Error('Connect to a real board with flash access first');
    if (input.preset !== session.meta.preset) throw new Error('Selected preset differs from active probe session; reconnect first');
    const board = session.meta.board;
    const cfg = projectRoot && board ? currentConfig(board).params.value : {};
    if (input.preset?.endsWith('-diagnose') && cfg.test?.auto_run_on_boot && cfg.test?.motor_demo && input.ackMotorMotion !== true) throw new Error('Motor demo is enabled; acknowledge movement before flashing');
    const elf = session.meta.elfPath;
    if (!existsSync(elf)) throw new Error('Build the selected preset first');
    if (hashFile(elf) !== session.meta.elfHash || (projectRoot && board && (currentConfig(board).params.hash !== session.meta.paramsHash || currentConfig(board).robot.hash !== session.meta.robotHash)))
      throw new Error('ELF or configuration changed after connection; reconnect to use the new artifact');
    await session.flashAndRun(elf);
    await stopSession();
    });
    json(res, 200, { ok: true, running: true, disconnected: true }); return;
  }
  if (url.pathname === '/api/disconnect' && req.method === 'POST') { await serializeSession(stopSession); json(res, 200, { ok: true }); return; }
  if (url.pathname === '/api/serial-test' && req.method === 'POST') {
    if (!/^COM\d{1,3}$/i.test(input.port || '')) throw new Error('Enter a COM port such as COM7');
    const baud = Number(input.baud);
    if (!Number.isInteger(baud) || baud < 1200 || baud > 3000000) throw new Error('Invalid baud rate');
    const protocol = input.protocol || 'usart';
    if (!['usart', 'usb'].includes(protocol)) throw new Error('Invalid diagnostic protocol');
    await command(BACKEND, ['--serial-test', '--port', input.port.toUpperCase(), '--baud', String(baud), '--protocol', protocol], ROOT, 'diagnostics');
    json(res, 200, { ok: true }); return;
  }
  json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  if (!['127.0.0.1', 'localhost'].some(host => req.headers.host?.startsWith(`${host}:`))) { json(res, 403, { error: 'Local access only' }); return; }
  route(req, res).catch(err => error(res, err));
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`PnX Platform: http://127.0.0.1:${address.port}/\n`);
});
process.on('SIGINT', async () => { await Promise.allSettled([stopSession(), bulletReceiver.stop()]); server.close(); });
process.stdin.setEncoding('utf8');
let stdinCommands = '';
process.stdin.on('data', chunk => {
  stdinCommands += chunk;
  if (stdinCommands.length > 128) stdinCommands = stdinCommands.slice(-128);
  if (!stdinCommands.includes('shutdown\n')) return;
  process.stdin.pause();
  void Promise.allSettled([stopSession(), bulletReceiver.stop()]).finally(() => process.exit(0));
});
