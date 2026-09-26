const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
let logRoot = __dirname;
let dataRoot;
function trace(message) {
  try { fs.appendFileSync(path.join(logRoot, 'desktop.log'), `${new Date().toISOString()} ${message}\n`); } catch { /* Storage may be read-only. */ }
}
trace(`main loaded; app=${typeof app}; ipcMain=${typeof ipcMain}; nodeMode=${process.env.ELECTRON_RUN_AS_NODE || '<unset>'}; exec=${process.execPath}`);

const windowsCompatibility = process.platform === 'win32' && (os.release().split('.')[2] === '26200' || process.env.PNX_ELECTRON_DISABLE_GPU_SANDBOX === '1');
if (windowsCompatibility) {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
  trace('Windows GPU sandbox compatibility switch enabled');
}
function selectDataRoot() {
  trace('selecting user data');
  const preferred = process.env.PNX_DESKTOP_DATA_ROOT;
  const nativeData = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(), 'PnX Platform')
    : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'PnX Platform')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'pnx-platform');
  const portable = app.isPackaged ? path.resolve(process.resourcesPath, '..', '.data') : path.join(__dirname, '..', '.cache', 'electron-data');
  trace(`user data candidates: ${preferred || '<unset>'}, ${nativeData || '<unset>'}, ${portable}`);
  for (const candidate of [preferred, nativeData, portable].filter(Boolean)) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      const probe = path.join(candidate, `.write-probe-${process.pid}`);
      fs.writeFileSync(probe, 'ok', { flag: 'wx' });
      fs.unlinkSync(probe);
      app.setPath('userData', candidate);
      dataRoot = candidate;
      logRoot = candidate;
      trace(`user data: ${candidate}`);
      return;
    } catch (error) { trace(`user data unavailable: ${candidate}: ${error.message}`); }
  }
  throw new Error('No writable user data directory');
}
selectDataRoot();

let window;
let server;
let origin;
const settingsPath = () => path.join(dataRoot, 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); } catch { return {}; }
}
function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}
function isPnx(folder) {
  return !!folder && fs.existsSync(path.join(folder, 'CMakePresets.json')) && fs.existsSync(path.join(folder, 'configs', 'boards'));
}
function startServer() {
  return new Promise((resolve, reject) => {
    trace(`starting service from ${app.getAppPath()}`);
    const settings = loadSettings();
    const project = isPnx(settings.project) ? settings.project : null;
    const requested = process.env.PNX_WORKSPACE_ROOT;
    const workspace = requested && fs.existsSync(requested) ? requested
      : settings.workspace && fs.existsSync(settings.workspace) ? settings.workspace : project;
    const script = path.join(app.getAppPath(), 'src', 'server.mjs');
    server = spawn(process.execPath, [script], {
      cwd: app.getAppPath(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PNX_WORKSPACE_ROOT: workspace || '',
        PNX_CACHE_ROOT: path.join(dataRoot, 'cache') },
    });
    server.stdin.on('error', error => trace(`service stdin: ${error.message}`));
    let output = '';
    const timer = setTimeout(() => reject(new Error('Local workbench service did not start')), 12000);
    server.stdout.on('data', chunk => {
      output = (output + String(chunk)).slice(-8192);
      trace(`service stdout: ${String(chunk).trim()}`);
      const address = /PnX Platform: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output)?.[1];
      if (address) { clearTimeout(timer); resolve(address); }
    });
    server.stderr.on('data', chunk => { output = (output + String(chunk)).slice(-8192); trace(`service stderr: ${String(chunk).trim()}`); });
    server.on('error', error => { clearTimeout(timer); reject(error); });
    server.on('exit', code => {
      clearTimeout(timer);
      trace(`service exited: ${code}`);
      if (!origin) reject(new Error(`Workbench service exited: ${code}\n${output}`));
      else if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('pnx:service-exit');
    });
  });
}
async function createWindow() {
  origin = await startServer();
  trace(`service ready: ${origin}`);
  window = new BrowserWindow({
    width: 1500, height: 950, minWidth: 850, minHeight: 650, show: false, backgroundColor: '#18202d',
    title: 'PnX Platform',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'pnx-icon.ico' : 'pnx-icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: !windowsCompatibility },
  });
  window.on('closed', () => { window = null; trace('window closed'); });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(origin)) event.preventDefault(); });
  window.webContents.on('render-process-gone', (_event, details) => trace(`renderer gone: ${JSON.stringify(details)}`));
  window.webContents.on('did-fail-load', (_event, code, description, url) => trace(`load failed: ${code} ${description} ${url}`));
  window.webContents.on('console-message', (_event, level, message) => trace(`renderer console ${level}: ${message}`));
  await window.loadURL(origin);
  const folderBridge = await window.webContents.executeJavaScript('typeof window.PNXDesktop?.chooseFolder');
  if (folderBridge !== 'function') throw new Error('Native folder picker bridge did not load');
  trace('window loaded');
  window.show();
  if (process.env.PNX_ELECTRON_TEST_MODE === '1') {
    const closeAfter = Number(process.env.PNX_ELECTRON_AUTOCLOSE_MS);
    if (Number.isFinite(closeAfter) && closeAfter > 0 && closeAfter <= 30000) {
      const testWindow = window;
      setTimeout(() => { if (!testWindow.isDestroyed()) testWindow.close(); }, closeAfter);
    }
  }
}

ipcMain.handle('pnx:choose-folder', async () => {
  const settings = loadSettings();
  const result = await dialog.showOpenDialog(window, { title: '打开文件夹', defaultPath: settings.workspace,
    properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  const folder = result.filePaths[0];
  settings.workspace = folder;
  if (isPnx(folder)) settings.project = folder;
  saveSettings(settings);
  return folder;
});
const toolDownloadUrls = Object.freeze({
  stlink: 'https://www.st.com/en/development-tools/stsw-link009.html',
  cmake: 'https://cmake.org/download/',
  ninja: 'https://github.com/ninja-build/ninja/releases',
  arm: 'https://developer.arm.com/tools-and-software/gnu-toolchain#Downloads',
});
ipcMain.handle('pnx:tool-download', async (_event, tool) => {
  if (!Object.hasOwn(toolDownloadUrls, tool)) throw new Error('Unknown tool download');
  await shell.openExternal(toolDownloadUrls[tool]);
});
trace('ipc registered');
app.on('ready', () => trace('ready event'));
app.on('child-process-gone', (_event, details) => trace(`child gone: ${JSON.stringify(details)}`));

app.whenReady().then(createWindow).catch(error => {
  trace(`startup error: ${error.stack || error.message}`);
  if (process.env.PNX_ELECTRON_TEST_MODE !== '1') dialog.showErrorBox('PnX Platform 启动失败', error.message);
  app.quit();
});
trace('ready handler registered');
app.on('window-all-closed', () => app.quit());
let quitting = false;
app.on('before-quit', event => {
  if (quitting || !server || server.exitCode !== null || server.signalCode !== null) return;
  event.preventDefault(); quitting = true;
  const deadline = setTimeout(() => { if (server.exitCode === null && server.signalCode === null) server.kill(); app.quit(); }, 6000);
  server.once('exit', () => { clearTimeout(deadline); app.quit(); });
  try { server.stdin.end('shutdown\n'); }
  catch (error) { trace(`graceful shutdown failed: ${error.message}`); server.kill(); }
});
