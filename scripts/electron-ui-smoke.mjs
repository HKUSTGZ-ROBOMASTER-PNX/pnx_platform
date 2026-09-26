import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = fileURLToPath(new URL('..', import.meta.url));
const realProbe = process.env.PNX_UI_STLINK === '1';
const mockBanked = process.env.PNX_UI_MOCK_BANKED === '1';
if (realProbe && mockBanked) throw new Error('Choose either ST-Link or banked mock mode');
const fixture = path.join(root, '.cache', `ui-smoke-files-${process.pid}`);
mkdirSync(fixture, { recursive: true });
writeFileSync(path.join(fixture, 'first.cpp'), 'int first = helper();\n');
writeFileSync(path.join(fixture, 'second.h'), 'inline int helper() { return 2; }\n');
writeFileSync(path.join(fixture, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.21)\nproject(smoke NONE)\n');
writeFileSync(path.join(fixture, 'CMakePresets.json'), JSON.stringify({ version: 3, configurePresets: [{ name: 'Debug', generator: 'Ninja' }] }));
const pnxFixture = path.join(fixture, 'pnx-project');
mkdirSync(path.join(pnxFixture, 'app'), { recursive: true });
writeFileSync(path.join(pnxFixture, 'app', 'app.cpp'), 'int main() { return 0; }\n');
writeFileSync(path.join(pnxFixture, 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.21)\nproject(pnx_smoke NONE)\n');
writeFileSync(path.join(pnxFixture, 'CMakePresets.json'), JSON.stringify({ version: 3, configurePresets: [{ name: 'h723-debug', generator: 'Ninja' }] }));
const boardDir = path.join(pnxFixture, 'configs', 'boards', 'h723_mc02');
mkdirSync(boardDir, { recursive: true });
writeFileSync(path.join(boardDir, 'params.json'), JSON.stringify({ build: { usbx: false }, bindings: {} }));
writeFileSync(path.join(boardDir, 'robot.json'), JSON.stringify({ devices: { motors: { list: [{ model: 'dji_m3508', name: 'smoke' }] } } }));
const executable = process.argv[2];
if (!executable) throw new Error('Pass the packaged PnX-Platform.exe path');
const portServer = net.createServer();
portServer.listen(0, '127.0.0.1');
await once(portServer, 'listening');
const port = portServer.address().port;
await new Promise(resolve => portServer.close(resolve));

const child = spawn(path.resolve(executable), [`--remote-debugging-port=${port}`], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, PNX_ELECTRON_TEST_MODE: '1', PNX_ELECTRON_AUTOCLOSE_MS: '30000',
    PNX_WORKSPACE_ROOT: realProbe ? process.env.PNX_UI_PROJECT_ROOT : pnxFixture,
    ...(mockBanked ? { PNX_TEST_BANK_SIZE: '2' } : {}),
    PNX_DESKTOP_DATA_ROOT: path.join(root, '.cache', `ui-smoke-${process.pid}`),
    PNX_CAPTURE_ROOT: path.join(root, '.cache', `ui-captures-${process.pid}`) },
});
let ws, evaluate, closedByTest = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let target;
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    try {
      const entries = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = entries.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
      if (target) break;
    } catch { /* Electron may still be starting. */ }
    await pause(100);
  }
  assert.ok(target, 'Packaged Electron page did not appear in DevTools');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  const readyAt = Date.now() + 10000;
  while (Date.now() < readyAt && !(await evaluate('Boolean(document.querySelector("#board option"))'))) await pause(100);
  assert.equal(await evaluate('Boolean(document.querySelector("#board option"))'), true, 'Board resources did not load');
  while (Date.now() < readyAt && !(await evaluate('Boolean(state.config.params)'))) await pause(100);
  assert.equal(await evaluate('Boolean(state.config.params)'), true, 'Initial board configuration did not load');
  const originalProject = await evaluate('state.projectRoot');

  await evaluate("setView('config')");
  const configReadyAt = Date.now() + 10000;
  while (Date.now() < configReadyAt && !(await evaluate("document.querySelector('#configFrame').contentDocument?.querySelectorAll('.field').length > 0"))) await pause(100);
  const configPage = await evaluate(`({ fields: document.querySelector('#configFrame').contentDocument.querySelectorAll('.field').length,
    bindings: document.querySelector('#configFrame').contentDocument.body.textContent.includes('Bindings'),
    terminalHidden: getComputedStyle(document.querySelector('#terminalPanel')).display === 'none',
    editorFont: getComputedStyle(document.querySelector('#codeEditor')).fontFamily,
    settingsEntry: [...document.querySelectorAll('.view-switch')].find(button => button.dataset.viewTarget === 'config')?.textContent,
    settingsIcon: [...document.querySelectorAll('.activity-button')].find(button => button.dataset.viewTarget === 'config')?.querySelector('svg')?.getAttribute('viewBox'),
    activityIcons: [...document.querySelectorAll('.activity-button')].filter(button => button.querySelector('svg.activity-icon') && button.getAttribute('aria-label')).length })`);
  assert.ok(configPage.fields > 10);
  assert.equal(configPage.bindings && configPage.terminalHidden, true);
  assert.match(configPage.editorFont, /Consolas/);
  assert.equal(configPage.settingsEntry, '设置与构建');
  assert.equal(configPage.settingsIcon, '0 0 24 24');
  assert.equal(configPage.activityIcons, 3);
  const configNavigation = await evaluate(`(async () => {
    const frame = document.querySelector('#configFrame').contentWindow;
    [...frame.document.querySelectorAll('#actions button')].find(button => button.textContent.includes('Robot')).click();
    for (let index = 0; index < 50 && !frame.document.querySelector('#content h2')?.textContent.includes('电机'); index++) await new Promise(resolve => setTimeout(resolve, 20));
    const robot = frame.document.querySelector('#content').textContent.includes('电机');
    [...frame.document.querySelectorAll('#actions button')].find(button => button.textContent.includes('硬件概览')).click();
    for (let index = 0; index < 50 && !frame.document.querySelector('#content h2')?.textContent.includes('Hardware'); index++) await new Promise(resolve => setTimeout(resolve, 20));
    const hardware = frame.document.querySelector('#content h2')?.textContent.includes('Hardware');
    frame.document.querySelector('#configBack').click();
    for (let index = 0; index < 50 && !frame.document.querySelector('#content').textContent.includes('Bindings'); index++) await new Promise(resolve => setTimeout(resolve, 20));
    return { robot, hardware, back: frame.document.querySelector('#content').textContent.includes('Bindings') };
  })()`);
  assert.deepEqual(configNavigation, { robot: true, hardware: true, back: true });
  const configScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(root, '.cache', 'electron-ui-config.png'), Buffer.from(configScreenshot.data, 'base64'));
  const deviceTools = await evaluate(`(async () => {
    const configDocument = document.getElementById('configFrame').contentDocument;
    document.getElementById('openDeviceTools').click();
    const opened = state.view === 'tools' && !document.getElementById('tools').classList.contains('hidden');
    document.getElementById('backToConfig').click();
    await new Promise(resolve => setTimeout(resolve, 150));
    return { opened, returned: state.view === 'config', preserved: document.getElementById('configFrame').contentDocument === configDocument };
  })()`);
  assert.deepEqual(deviceTools, { opened: true, returned: true, preserved: true });
  const toolchainSetup = await evaluate(`(async () => {
    const originalFetch = window.fetch;
    const tools = { cmake: { directory: 'C:/Tools/CMake/bin', source: 'PATH' }, ninja: { directory: 'C:/Tools/Ninja', source: 'folder' }, arm: { directory: 'C:/Tools/Arm/bin', source: 'folder' } };
    window.fetch = (url, options) => String(url).startsWith('/api/toolchain/scan')
      ? Promise.resolve(new Response(JSON.stringify({ tools, missing: [], complete: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : String(url) === '/api/toolchain/configure'
        ? Promise.resolve(new Response(JSON.stringify({ configured: tools, added: [tools.ninja.directory, tools.arm.directory], scope: 'user', userPathError: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
        : originalFetch(url, options);
    try {
      await setupToolchain();
      return { complete: document.getElementById('toolchainStatus').textContent.includes('配置完成'),
        arm: document.getElementById('toolchainStatus').textContent.includes('Arm GNU Toolchain') };
    } finally { window.fetch = originalFetch; }
  })()`);
  assert.deepEqual(toolchainSetup, { complete: true, arm: true });
  await evaluate("setView('tools')");
  const toolchainScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(root, '.cache', 'electron-ui-toolchain.png'), Buffer.from(toolchainScreenshot.data, 'base64'));
  const missingToolPrompt = await evaluate(`(async () => {
    const originalFetch = window.fetch;
    window.fetch = (url, options) => String(url).startsWith('/api/toolchain/scan')
      ? Promise.resolve(new Response(JSON.stringify({ tools: {}, missing: ['arm'], complete: false }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : originalFetch(url, options);
    try {
      await setupToolchain();
      const shown = document.getElementById('toolchainMissing').open;
      const named = document.getElementById('toolchainMissingText').textContent.includes('Arm GNU Toolchain');
      document.getElementById('toolchainMissingClose').click();
      return { shown, named, closed: !document.getElementById('toolchainMissing').open };
    } finally { window.fetch = originalFetch; }
  })()`);
  assert.deepEqual(missingToolPrompt, { shown: true, named: true, closed: true });
  const probePicker = await evaluate(`(async () => {
    const originalFetch = window.fetch;
    window.fetch = (url, options) => String(url) === '/api/probes'
      ? Promise.resolve(new Response(JSON.stringify({ probes: [
          { selector: 'Horco CMSIS-DAP,SN:test', identifier: 'Horco CMSIS-DAP', serialNumber: 'test', family: 'CMSIS-DAP / DAPLink' },
          { selector: 'STLink V2-1,SN:test', identifier: 'STLink V2-1', serialNumber: 'test', family: 'ST-Link' }
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      : originalFetch(url, options);
    try {
      await scanProbes();
      const list = document.getElementById('probeList');
      list.value = 'Horco CMSIS-DAP,SN:test';
      list.dispatchEvent(new Event('change'));
      return { count: list.options.length, selector: document.getElementById('probe').value,
        label: list.selectedOptions[0]?.textContent };
    } finally { window.fetch = originalFetch; document.getElementById('probe').value = 'auto'; }
  })()`);
  assert.equal(probePicker.count, 3);
  assert.equal(probePicker.selector, 'Horco CMSIS-DAP,SN:test');
  assert.match(probePicker.label, /DAPLink/);
  await evaluate("setView('editor')");

  const editor = await evaluate(`(async () => {
    await openFile('CMakeLists.txt', document.createElement('button'));
    await openFile('app/app.cpp', document.createElement('button'));
    return { tabs: document.querySelectorAll('#fileTabs .file-tab').length,
      highlighted: document.querySelectorAll('#codeHighlight [class^="tok-"]').length,
      active: document.querySelector('#fileTabs .file-tab.active')?.textContent,
      buttons: ['quickBuild','quickDebug','quickFlash'].every(id => Boolean(document.getElementById(id)?.onclick)) };
  })()`);
  assert.equal(editor.tabs, 2);
  assert.ok(editor.highlighted > 0);
  assert.match(editor.active, /app\.cpp/);
  assert.equal(editor.buttons, true);
  const editorScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(root, '.cache', 'electron-ui-editor.png'), Buffer.from(editorScreenshot.data, 'base64'));

  const save = await evaluate(`(async () => {
    const generic = await api('/api/workspace/open', { folder: ${JSON.stringify(fixture)} });
    state.workspace = generic.root; state.projectRoot = generic.projectRoot; state.config = {}; await loadBuildPresets();
    state.files.clear(); state.file = null;
    await openFile('first.cpp', document.createElement('button'));
    await openFile('second.h', document.createElement('button'));
    for (const file of state.files.values()) file.value += '// edited\\n';
    const originalFetch = window.fetch;
    window.__smokeRealFetch = originalFetch;
    window.fetch = (input, init) => {
      if (input === '/api/build') {
        window.__smokeBuildSawClean = [...state.files.values()].every(file => file.value === file.text);
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200,
          headers: { 'Content-Type': 'application/json' } }));
      }
      return originalFetch(input, init);
    };
    document.getElementById('quickBuild').click();
    return { dirtyBefore: [...state.files.values()].filter(fileDirty).length };
  })()`);
  assert.equal(save.dirtyBefore, 2);
  const savedAt = Date.now() + 5000;
  while (Date.now() < savedAt && !(await evaluate('window.__smokeBuildSawClean === true'))) await pause(100);
  assert.equal(await evaluate('window.__smokeBuildSawClean'), true, 'Build started before dirty tabs were saved');
  const genericState = await evaluate("({ preset: state.preset, pnx: state.projectRoot, debugDisabled: document.getElementById('quickDebug').disabled })");
  assert.deepEqual(genericState, { preset: 'Debug', pnx: null, debugDisabled: true });
  const genericTarget = await evaluate(`(async () => {
    await document.getElementById('projectSettings').onclick();
    document.getElementById('targetChip').value = 'STM32F407VG';
    document.getElementById('targetElf').value = 'build/custom-name.elf';
    document.getElementById('pnxPluginEnabled').checked = false;
    document.getElementById('taskExecutable').value = 'make';
    document.getElementById('taskArguments').value = '["-j4"]';
    await document.getElementById('projectSettingsForm').onsubmit({preventDefault(){}});
    const saved = await api('/api/project-settings');
    const result = {chip:saved.target.chip,elf:saved.target.elf,pnx:saved.plugins.pnx,debugEnabled:!document.getElementById('quickDebug').disabled,flashEnabled:!document.getElementById('quickFlash').disabled,buildFirst:buildBeforeConnect()};
    if (document.getElementById('scopeAttach').disabled) throw new Error('Generic scope connect is disabled');
    await connect(true, false);
    changeVariableSelection(state.variables.slice(0,2).map(variable => variable.id), true);
    const id = state.selected[0]; state.plotAssignments.set(id, state.plots[0].id);
    await document.getElementById('subscribe').onclick();
    await new Promise(resolve => setTimeout(resolve, 450));
    renderPlots();
    if (!state.sampleCount || !state.series.get(id)?.length || ![...document.getElementById('plotGrid').children].some(card => card.plotIds.includes(id))) throw new Error('Generic project did not acquire and plot samples');
    if (plotVariableIds().length !== 1) throw new Error('Watch-only variable incorrectly plotted');
    await api('/api/record/start', {}); await new Promise(resolve => setTimeout(resolve, 150));
    const capture = await api('/api/record/stop', {}); if (!capture.rows) throw new Error('Generic project CSV is empty');
    await disconnect();
    await api('/api/project-settings',{plugins:{pnx:false},target:{},build:{}});
    await loadProjectProfile(); await loadBuildPresets();
    return result;
  })()`);
  assert.deepEqual(genericTarget,{chip:'STM32F407VG',elf:'build/custom-name.elf',pnx:false,debugEnabled:true,flashEnabled:true,buildFirst:false});

  assert.match(readFileSync(path.join(fixture, 'first.cpp'), 'utf8'), /edited/);
  assert.match(readFileSync(path.join(fixture, 'second.h'), 'utf8'), /edited/);

  const navigation = await evaluate(`(async () => {
    activateFile('first.cpp');
    const source = document.getElementById('codeEditor').value;
    const cursor = source.indexOf('helper') + 2;
    document.getElementById('codeEditor').focus();
    document.getElementById('codeEditor').setSelectionRange(cursor, cursor);
    document.getElementById('codeEditor').dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true }));
    for (let i = 0; i < 100 && state.file.path !== 'second.h'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const target = { path: state.file.path, selection: document.getElementById('codeEditor').value.slice(document.getElementById('codeEditor').selectionStart, document.getElementById('codeEditor').selectionEnd), backEnabled: !document.getElementById('goBack').disabled };
    document.getElementById('goBack').click();
    for (let i = 0; i < 40 && (state.file.path !== 'first.cpp' || !document.getElementById('goBack').disabled); i++) await new Promise(resolve => setTimeout(resolve, 20));
    return { target, returned: state.file.path, backDisabled: document.getElementById('goBack').disabled };
  })()`);
  assert.deepEqual(navigation, { target: { path: 'second.h', selection: 'helper', backEnabled: true }, returned: 'first.cpp', backDisabled: true });
  const ctrlNavigation = await evaluate(`(async () => {
    document.getElementById('codeEditor').setSelectionRange(0, 0);
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Control', ctrlKey:true, bubbles:true}));
    const overlay=document.getElementById('definitionOverlay');
    const link=[...overlay.querySelectorAll('span')].find(node=>node.textContent==='helper');
    const visible=overlay.classList.contains('active');
    link.dispatchEvent(new MouseEvent('click', {ctrlKey:true,bubbles:true}));
    for(let i=0;i<100 && state.file.path!=='second.h';i++) await new Promise(resolve=>setTimeout(resolve,20));
    const target=state.file.path;
    document.getElementById('goBack').click();
    for(let i=0;i<100 && state.file.path!=='first.cpp';i++) await new Promise(resolve=>setTimeout(resolve,20));
    return {visible,target,returned:state.file.path,hidden:!overlay.classList.contains('active')};
  })()`);
  assert.deepEqual(ctrlNavigation,{visible:true,target:'second.h',returned:'first.cpp',hidden:true});

  const breakpoints = await evaluate(`(async () => {
    const originalFetch = window.fetch, calls = [];
    await toggleBreakpoint('first.cpp', 1);
    const visible = Boolean(document.querySelector('#breakpointGutter .has-breakpoint'));
    const saved = JSON.parse(localStorage.getItem(breakpointStorageKey()))['first.cpp'];
    window.fetch = (input, init) => {
      if (input === '/api/debug/breakpoints') {
        calls.push(JSON.parse(init.body));
        return Promise.resolve(new Response(JSON.stringify({ breakpoints: [{ verified: true, line: 1 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return originalFetch(input, init);
    };
    try {
      state.debugAccess = true; await syncBreakpoints('first.cpp');
      const verified = state.breakpointResults.get('first.cpp').get(1).verified;
      state.debugPaused = true; state.stoppedAt = {path:'first.cpp',line:2};
      state.breakpointResults.get('first.cpp').set(1,{verified:true,line:2});
      renderBreakpointGutter();
      const pausedButton = [...document.querySelectorAll('.breakpoint-line')].find(button=>button.textContent==='2');
      await pausedButton.onclick();
      if(!state.debugPaused || !pausedButton.classList.contains('has-breakpoint')) throw new Error('Paused breakpoint fixture failed');
      state.debugAccess = false; state.debugPaused = false; state.stoppedAt = null;
      return { visible, saved, calls, verified, removed: !state.breakpoints.get('first.cpp').has(1) };
    } finally { state.debugAccess = false; window.fetch = originalFetch; }
  })()`);
  assert.deepEqual(breakpoints, { visible: true, saved: [1], calls: [{ path: 'first.cpp', lines: [1] }, { path: 'first.cpp', lines: [] }], verified: true, removed: true });
  const gutterPoint = await evaluate(`(() => {
    setView('editor'); window.gutterOriginalText=document.getElementById('codeEditor').value;
    document.getElementById('codeEditor').value=Array.from({length:300},(_,i)=>'int line_'+i+';').join('\\n');
    document.getElementById('codeEditor').scrollTop=269*21;
    state.debugPaused=true; state.stoppedAt={path:'first.cpp',line:274}; showDefinitionOverlay();
    renderBreakpointGutter();
    const row=[...document.querySelectorAll('.breakpoint-line')].find(button=>button.textContent==='274');
    const rect=row.getBoundingClientRect(); return {x:rect.x+26,y:rect.y+10};
  })()`);
  for (const refresh of [false, true]) for (const expected of [true, false]) {
    await evaluate('showDefinitionOverlay()');
    assert.equal(await evaluate(`document.elementFromPoint(${gutterPoint.x},${gutterPoint.y}).classList.contains('breakpoint-line')`),true,'Definition overlay intercepted the breakpoint gutter');
    await call('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',clickCount:1,...gutterPoint});
    if (refresh) await evaluate('renderBreakpointGutter()');
    await pause(80);
    await call('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',clickCount:1,...gutterPoint});
    await pause(120);
    assert.equal(await evaluate("state.breakpoints.get('first.cpp')?.has(274) || false"), expected, `Physical gutter click did not toggle breakpoint (refresh=${refresh})`);
    assert.deepEqual(await evaluate(`(() => { const row=[...document.querySelectorAll('.breakpoint-line')].find(button=>button.textContent==='274'); return {red:row.classList.contains('has-breakpoint'),arrow:row.classList.contains('current-execution')}; })()`),{red:expected,arrow:true});
  }
  await evaluate('hideDefinitionOverlay(); document.getElementById("codeEditor").value=window.gutterOriginalText; document.getElementById("codeEditor").scrollTop=0; state.debugPaused=false; state.stoppedAt=null; renderBreakpointGutter()');

  await evaluate(`(async () => {
    const selected = await api('/api/workspace/open', { folder: ${JSON.stringify(originalProject)} });
    state.workspace = selected.root; state.projectRoot = selected.projectRoot; await loadBoard();
  })()`);

  const workflows = await evaluate(`(async () => {
    const priorFetch = window.fetch, priorConfirm = confirmAction, calls = [];
    const response = value => Promise.resolve(new Response(JSON.stringify(value), { status: 200,
      headers: { 'Content-Type': 'application/json' } }));
    window.fetch = (input, init) => {
      if (input === '/api/build') { calls.push('build'); return priorFetch(input, init); }
      if (input === '/api/connect') {
        const request = JSON.parse(init.body);
        calls.push(request.allowFlash ? 'connect:flash' : request.allowDebug ? 'connect:debug' : 'connect:plot');
        return response({ variables: [], board: 'h723_mc02', elf: 'fixture.elf' });
      }
      if (input === '/api/flash') { calls.push('flash'); return response({ ok: true }); }
      return priorFetch(input, init);
    };
    confirmAction = async () => true;
    try {
      await document.getElementById('quickDebug').onclick();
      const debug = [...calls]; calls.length = 0;
      await document.getElementById('quickFlash').onclick();
      if(state.connected || state.debugAccess || !document.getElementById('quickStop').disabled) throw new Error('Flash left a debug session active');
      const flash = [...calls]; calls.length = 0;
      window.fetch = (input, init) => {
        if (input === '/api/build') { calls.push('build'); return Promise.resolve(new Response(JSON.stringify({ error: 'fixture build failed' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } })); }
        if (input === '/api/connect') calls.push('connect');
        if (input === '/api/flash') calls.push('flash');
        return priorFetch(input, init);
      };
      await document.getElementById('quickFlash').onclick();
      const failedBuild = [...calls];
      document.getElementById('log').textContent = '';
      return { debug, flash, failedBuild };
    } finally { window.fetch = window.__smokeRealFetch; confirmAction = priorConfirm; }
  })()`);
  assert.deepEqual(workflows.debug, ['build', 'connect:debug']);
  assert.deepEqual(workflows.flash, ['build', 'connect:flash', 'flash']);
  assert.deepEqual(workflows.failedBuild, ['build']);

  const terminal = await evaluate(`(() => {
    activateTerminal('build'); log('build output marker', 'build');
    document.getElementById('terminalAdd').click();
    const second = activeTerminal; log('second output marker', second);
    const secondText = document.getElementById('log').textContent;
    activateTerminal('build');
    const buildText = document.getElementById('log').textContent;
    const bottom = document.getElementById('terminalPanel').getBoundingClientRect();
    document.getElementById('terminalHide').click();
    const closed = document.body.classList.contains('terminal-closed');
    document.getElementById('terminalToggle').click();
    terminals.set('build', ''); terminals.set(second, ''); renderTerminals();
    return { tabs: document.querySelectorAll('.terminal-tab').length, secondText, buildText,
      bottom: bottom.height > 100 && bottom.bottom <= window.innerHeight, closed,
      reopened: !document.body.classList.contains('terminal-closed') };
  })()`);
  assert.ok(terminal.tabs >= 3);
  assert.match(terminal.secondText, /second output marker/);
  assert.doesNotMatch(terminal.secondText, /build output marker/);
  assert.match(terminal.buildText, /build output marker/);
  assert.equal(terminal.bottom && terminal.closed && terminal.reopened, true);

  const plots = await evaluate(`(() => {
    setView('scope'); document.body.classList.add('terminal-closed'); document.getElementById('addPlot').click(); document.getElementById('addPlot').click();
    state.activeIds = Array.from({ length: 130 }, (_, i) => 'sample-' + i);
    state.activeIndex = new Map(state.activeIds.map((id, i) => [id, i]));
    renderPlots();
    const first = document.querySelector('.plot-card');
    const before = { count: document.querySelectorAll('.plot-card').length,
      page: first.querySelector('.plot-count').textContent, drawn: first.plotIds.length };
    first.querySelector('button[title="下一页变量"]').click();
    const after = document.querySelector('.plot-card');
    return { before, page: after.querySelector('.plot-count').textContent,
      drawn: after.plotIds.length, firstId: after.plotIds[0],
      order: [...document.querySelectorAll('.plot-card')].map(card => card.dataset.plotId) };
  })()`);
  assert.equal(plots.before.count, 3);
  assert.equal(plots.before.drawn, 64);
  assert.match(plots.page, /2\/3/);
  assert.equal(plots.drawn, 64);
  assert.equal(plots.firstId, 'sample-64');
  const axis = await evaluate(`(() => {
    const labels = [], horizontal = [];
    const frame = plotFrame(600, 300, 1);
    let start;
    const context = { beginPath(){}, moveTo(x, y){ start = { x, y }; }, lineTo(x, y){
      if (start.x === frame.left && x === frame.left + frame.width) horizontal.push(start.y);
    }, stroke(){}, fillText(label){ labels.push(label); } };
    const fine = plotAxis(0.002, 0.008);
    drawPlotGrid(context, frame, 1, fine);
    return { step: fine.step, ticks: fine.ticks, lines: horizontal.length,
      equalSpacing: horizontal.slice(1).every((y, i) => Math.abs(y - horizontal[i] - (horizontal[1] - horizontal[0])) < 1e-8),
      labels, constantStep: plotAxis(0, 0).step };
  })()`);
  assert.equal(axis.step, 0.001);
  assert.equal(axis.ticks, 10);
  assert.equal(axis.lines, 11);
  assert.equal(axis.equalSpacing, true);
  assert.ok(axis.constantStep <= 0.01);
  assert.ok(axis.labels.some(label => Number(label) === 0.01));

  // Hosted desktops differ in size and scaling. The destination may be below
  // the scroll viewport; stale off-screen coordinates never hit a plot card.
  await call('Emulation.setDeviceMetricsOverride', {width:1000,height:700,deviceScaleFactor:1,mobile:false});
  const dragPoint = async id => {
    const point = await evaluate(`(async () => {
      const header = document.querySelector('[data-plot-id="' + ${JSON.stringify(id)} + '"] .plot-header');
      header.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const rect = header.getBoundingClientRect();
      // Use the header padding: title text can shrink under crowded controls.
      const x=rect.left+5, y=rect.top+rect.height/2;
      return {x,y,hit:document.elementFromPoint(x,y)?.closest('.plot-card')?.dataset.plotId,
        headerHit:!!document.elementFromPoint(x,y)?.closest('.plot-header')};
    })()`);
    assert.equal(point.hit,id,`Drag coordinate must hit ${id}: ${JSON.stringify(point)}`);
    assert.equal(point.headerHit,true);
    return {x:point.x,y:point.y};
  };
  try {
    const from=await dragPoint('plot-1');
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',...from});
    await call('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:from.x+10,y:from.y,button:'left',buttons:1});
    assert.equal(await evaluate("document.querySelector('[data-plot-id=plot-1]').classList.contains('dragging')"),true,'Pointer drag must start');
    const to=await dragPoint('plot-3');
    await call('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
    assert.equal(await evaluate("document.querySelector('[data-plot-id=plot-3]').classList.contains('drag-over')"),true,'Destination must receive drag hover');
    await call('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});
  } finally { await call('Emulation.clearDeviceMetricsOverride'); }
  const order = await evaluate('[...document.querySelectorAll(".plot-card")].map(card => card.dataset.plotId)');
  assert.deepEqual(order, ['plot-2', 'plot-3', 'plot-1']);

  const staleSignal = await evaluate(`(() => {
    const id = 'time-cache'; state.activeIds = [id]; state.variableById.set(id, { id, name: 'state.sys_time.ms' });
    state.observedValues.set(id, 0); state.valueSeenAt.set(id, performance.now()); state.valueChangedAt.set(id, performance.now() - 3000);
    updateScopeNotice(); return document.getElementById('scopeNotice').textContent;
  })()`);
  assert.match(staleSignal, /bsp::dwt::update/);

  await evaluate(`(async () => {
    await connect(${realProbe ? 'false' : 'true'}, false, false, false);
    const ramAddress = address => Number.isInteger(address) &&
      [[0x20000000,0x20100000],[0x24000000,0x24100000],[0x30000000,0x30100000],[0x38000000,0x38100000]]
        .some(([start,end]) => address >= start && address < end);
    state.selected = ${realProbe ? 'state.variables.filter(variable => ramAddress(variable.address)).slice(0, 300).map(variable => variable.id)' : 'state.variables.map(variable => variable.id)'};
    document.getElementById('subscribe').click();
  })()`);
  const expectedChannels = realProbe ? 300 : 4;
  const readiness = `state.activeIds.length === ${expectedChannels} && state.sampleCount > 100${realProbe ? ' && state.series.size === 300' : mockBanked ? ' && state.series.size === 4' : ''}`;
  const sampleDeadline = Date.now() + (realProbe ? 12000 : 5000);
  while (Date.now() < sampleDeadline && !(await evaluate(readiness))) await pause(100);
  assert.equal(await evaluate(readiness), true, 'Acquisition did not reach every selected channel');
  await call('Performance.enable');
  const performanceBefore = await call('Performance.getMetrics');
  await pause(2000);
  const performanceAfter = await call('Performance.getMetrics');
  const duration = metrics => metrics.metrics.find(item => item.name === 'TaskDuration')?.value || 0;
  const acquisition = await evaluate(`({ samples: state.sampleCount, dropped: state.droppedFrames,
    channels: state.activeIds.length, observedSeries: state.series.size, bankCount: state.banks,
    liveValues: [...document.querySelectorAll('#selectedVariables .selected-variable-value')].map(item => item.textContent),
    ageLabels: [...document.querySelectorAll('#selectedVariables .selected-variable-value')].filter(item => item.title.includes('s 前')).length,
    metrics: document.getElementById('metrics').textContent,
    errors: document.getElementById('log').textContent.split('\\n').filter(line => line.startsWith('ERROR:')) })`);
  assert.ok(acquisition.samples > (realProbe ? 100 : 1000));
  assert.equal(acquisition.dropped, 0);
  assert.equal(await evaluate("document.getElementById('scopeNotice').classList.contains('hidden')"), true);
  assert.equal(acquisition.liveValues.length, expectedChannels);
  assert.ok(acquisition.liveValues.some(value => value !== '—'));
  assert.deepEqual(acquisition.errors, []);
  if (mockBanked) { assert.equal(acquisition.bankCount, 2); assert.equal(acquisition.observedSeries, 4); assert.ok(acquisition.ageLabels > 0); }
  const selectedView = await evaluate(`(() => ({ count: document.querySelectorAll('#selectedVariables .selected-variable-row').length,
    sameRow: [...document.querySelectorAll('#selectedVariables .selected-variable-row')].every(row => row.querySelector('.selected-variable-name') && row.querySelector('.selected-variable-value')),
    pickerClosed: !document.getElementById('variablePicker').open,
    legendScrollable: document.querySelector('.plot-card .plot-legend')?.scrollWidth > document.querySelector('.plot-card .plot-legend')?.clientWidth }))()`);
  assert.equal(selectedView.count, expectedChannels);
  assert.equal(selectedView.sameRow && selectedView.pickerClosed, true);
  const plotInteraction = await evaluate(`(async () => {
    const card = [...document.querySelectorAll('.plot-card')].find(item => item.plotIds.length);
    const input = document.getElementById('plotTimeWindow'); input.value = '1'; input.dispatchEvent(new Event('change'));
    const windowSet = plotView(card.dataset.plotId).seconds;
    card.querySelector('.plot-pause').click();
    const frozenAt = plotRange(card).maxT;
    const snapshotLength = plotData(card.dataset.plotId).series.get(card.plotIds[0])?.length;
    await new Promise(resolve => setTimeout(resolve, 220));
    const liveAdvanced = state.lastTimestampNs > frozenAt;
    const stillFrozen = plotRange(card).maxT === frozenAt && plotData(card.dataset.plotId).series.get(card.plotIds[0])?.length === snapshotLength;
    card.querySelector('.plot-zoom-in').click(); const zoomed = plotView(card.dataset.plotId).seconds;
    card.querySelector('.plot-zoom-out').click(); const restored = plotView(card.dataset.plotId).seconds;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = () => {};
    let exported;
    try { exported = await exportPlot(card); } finally { HTMLAnchorElement.prototype.click = originalClick; }
    return { windowSet, liveAdvanced, stillFrozen, zoomed, restored,
      paused: plotView(card.dataset.plotId).paused, exported, plotId: card.dataset.plotId };
  })()`);
  assert.equal(plotInteraction.windowSet, 1);
  assert.equal(plotInteraction.liveAdvanced && plotInteraction.stillFrozen && plotInteraction.paused, true);
  assert.ok(plotInteraction.zoomed < 1);
  assert.ok(Math.abs(plotInteraction.restored - 1) < 0.01);
  assert.equal(plotInteraction.exported.type, 'image/png');
  assert.ok(plotInteraction.exported.bytes > 5000);
  const wheelZoom = await evaluate(`(() => {
    const card = document.querySelector('.plot-card[data-plot-id="${plotInteraction.plotId}"]');
    const canvas = card.querySelector('canvas'), rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
    return plotView(card.dataset.plotId).seconds;
  })()`);
  assert.ok(wheelZoom < 1);
  const panCoordinates = await evaluate(`(() => {
    const card = document.querySelector('.plot-card[data-plot-id="${plotInteraction.plotId}"]');
    const rect = card.querySelector('canvas').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
      before: plotView(card.dataset.plotId).anchorNs };
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: panCoordinates.x, y: panCoordinates.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panCoordinates.x + 110, y: panCoordinates.y, button: 'left', buttons: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panCoordinates.x + 110, y: panCoordinates.y, button: 'left', clickCount: 1 });
  const panned = await evaluate(`plotView('${plotInteraction.plotId}').anchorNs`);
  assert.ok(panned < panCoordinates.before, 'Dragging the plot should review earlier samples');
  const fsCoordinates = await evaluate(`(() => {
    const button = document.querySelector('.plot-card[data-plot-id="${plotInteraction.plotId}"] .plot-fullscreen');
    const rect = button.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: fsCoordinates.x, y: fsCoordinates.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: fsCoordinates.x, y: fsCoordinates.y, button: 'left', clickCount: 1 });
  await pause(120);
  const fullScreenPlot = await evaluate('document.fullscreenElement?.dataset.plotId');
  assert.equal(fullScreenPlot, plotInteraction.plotId);
  const fullScreenScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(root, '.cache', 'electron-ui-plot-fullscreen.png'), Buffer.from(fullScreenScreenshot.data, 'base64'));
  await evaluate('document.exitFullscreen()');
  const gridCoordinates = await evaluate(`(() => { const rect = document.getElementById('plotGridFullscreen').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
  await call('Input.dispatchMouseEvent', { type: 'mousePressed', x: gridCoordinates.x, y: gridCoordinates.y, button: 'left', clickCount: 1 });
  await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: gridCoordinates.x, y: gridCoordinates.y, button: 'left', clickCount: 1 });
  await pause(120);
  const fullScreenGrid = await evaluate("document.fullscreenElement?.id");
  assert.equal(fullScreenGrid, 'plotGrid');
  await evaluate('document.exitFullscreen()');
  await evaluate(`(() => { const card = document.querySelector('.plot-card[data-plot-id="${plotInteraction.plotId}"]'); card.querySelector('.plot-pause').click(); const input = document.getElementById('plotTimeWindow'); input.value = '10'; input.dispatchEvent(new Event('change')); })()`);
  const csv = realProbe ? null : await evaluate(`(async () => {
    document.getElementById('recordStart').click();
    for (let i = 0; i < 60 && !state.recording; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const started = state.recording;
    await new Promise(resolve => setTimeout(resolve, 450));
    document.getElementById('recordStop').click();
    for (let i = 0; i < 60 && state.recording; i++) await new Promise(resolve => setTimeout(resolve, 20));
    const response = await fetch('/api/record/csv?token=' + encodeURIComponent(window.PNX_TOKEN));
    const content = await response.text();
    return { started, stopped: !state.recording, exportEnabled: !document.getElementById('exportCsv').disabled,
      status: response.status, rows: content.trim().split('\\n').length - 1, header: content.split('\\n')[0], file: state.recordFile };
  })()`);
  if (csv) { assert.equal(csv.started && csv.stopped && csv.exportEnabled && csv.status === 200, true); assert.ok(csv.rows > 100); assert.match(csv.header, /timestamp_ns/); assert.match(csv.file, /ui-captures/); }
  const screenshotPath = path.join(root, '.cache', 'electron-ui-smoke.png');
  const screenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  const variableTree = realProbe ? null : await evaluate(`(() => {
    state.selected = []; document.getElementById('openVariablePicker').click(); displayVariables();
    const branch = document.querySelector('#variables .variable-branch');
    const collapsed = branch.querySelector('.variable-expander').getAttribute('aria-expanded') === 'false';
    branch.querySelector('input[type="checkbox"]').click();
    const selected = [...state.selected];
    document.querySelector('#variables .variable-branch .variable-expander').click();
    const expanded = document.querySelectorAll('#variables .variable-branch .variable-leaf').length;
    document.querySelectorAll('#variables .variable-branch .variable-leaf input[type="checkbox"]')[0].click();
    return { collapsed, selected, expanded,
      partial: document.querySelector('#variables .variable-branch-row input[type="checkbox"]').indeterminate };
  })()`);
  if (!realProbe) {
    assert.equal(variableTree.collapsed, true);
    assert.deepEqual(variableTree.selected, ['mock.sine', 'mock.cosine']);
    assert.equal(variableTree.expanded, 2);
    assert.equal(variableTree.partial, true);
  }
  const deepTree = await evaluate(`(() => {
    const leaves = ['speed', 'torque', 'enabled'].map((name, index) => ({ id: 'deep.' + name,
      name, expression: 'robot.axis.loop.' + name, type: 'float', address: 0x20001000 + 4 * index,
      scalarKind: 'float32', byteWidth: 4, writable: true, children: [] }));
    setVariableCatalog(leaves, [{ id: 'robot', name: 'robot', expression: 'robot', children: [
      { id: 'axis', name: 'axis', expression: 'robot.axis', children: [
        { id: 'loop', name: 'loop', expression: 'robot.axis.loop', children: leaves.slice(0, 2) },
      ] }, leaves[2],
    ] }]);
    state.expandedVariables.clear(); state.selected = [];
    const search = document.getElementById('search'); search.value = ''; displayVariables();
    const collapsed = document.querySelectorAll('#variables .variable-leaf').length === 0;
    document.querySelector('#variables .variable-expander').click();
    const firstLevel = document.querySelectorAll('#variables .variable-branch').length;
    document.querySelectorAll('#variables .variable-expander')[1].click();
    document.querySelectorAll('#variables .variable-expander')[2].click();
    const leafCount = document.querySelectorAll('#variables .variable-leaf').length;
    document.querySelector('#variables .variable-branch-row input[type="checkbox"]').click();
    const allSelected = state.selected.length === 3;
    state.selected = []; search.value = 'speed'; displayVariables();
    const searchPath = document.querySelectorAll('#variables .variable-branch').length;
    document.getElementById('selectMatches').click();
    return { collapsed, firstLevel, leafCount, allSelected, searchPath, searchSelected: [...state.selected] };
  })()`);
  assert.deepEqual(deepTree, { collapsed: true, firstLevel: 2, leafCount: 3, allSelected: true,
    searchPath: 3, searchSelected: ['deep.speed'] });
  await evaluate("void (window.__confirmationResult = confirmAction('测试确认后的搜索输入'))");
  await evaluate("document.querySelector('.confirmation-dialog .primary').click()");
  assert.equal(await evaluate("window.__confirmationResult"), true);
  await evaluate("document.getElementById('openVariablePicker').click()");
  const searchPoint = await evaluate(`(() => { const r = document.getElementById('search').getBoundingClientRect(); return {x:r.x+20,y:r.y+r.height/2}; })()`);
  await call('Input.dispatchMouseEvent', {type:'mousePressed', ...searchPoint, button:'left', clickCount:1});
  await call('Input.dispatchMouseEvent', {type:'mouseReleased', ...searchPoint, button:'left', clickCount:1});
  await call('Input.insertText', { text: 'speed' });
  await pause(180);
  assert.deepEqual(await evaluate(`({ value: document.getElementById('search').value,
    focused: document.activeElement.id, ids: state.matchingVariableIds })`),
    { value: 'speed', focused: 'search', ids: ['deep.speed'] });
  await evaluate("document.getElementById('closeVariablePicker').click(); document.getElementById('search').value = ''; displayVariables()");
  await evaluate("document.getElementById('openVariablePicker').click()");
  const watchTree = await evaluate(`(async () => {
    displaySelectedVariables(); state.latestById.set('deep.speed',12.5); updateLive();
    const branches=document.querySelectorAll('#selectedVariables details').length;
    const ids=[...document.querySelectorAll('#selectedVariables .selected-variable-row')].map(row=>row.dataset.variableId);
    const value=document.querySelector('#selectedVariables .selected-variable-value').textContent;
    const root=document.querySelector('#selectedVariables details'); root.open=false;
    await new Promise(resolve=>setTimeout(resolve,30)); displaySelectedVariables();
    const preserved=!document.querySelector('#selectedVariables details').open;
    changeVariableSelection(['deep.speed'],false);
    return {branches,ids,value,preserved,empty:document.getElementById('selectedVariables').children.length===0};
  })()`);
  assert.deepEqual(watchTree,{branches:3,ids:['deep.speed'],value:'12.50000',preserved:true,empty:true});
  const pickerScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(root, '.cache', 'electron-ui-variable-picker.png'), Buffer.from(pickerScreenshot.data, 'base64'));
  const variableControls = await evaluate(`(async () => {
    const readOnlyButtons = document.querySelectorAll('#variables .variable-write').length;
    const fixtureVariables = Array.from({ length: 100 }, (_, index) => ({ id: 'global-' + index, name: 'global_' + index,
      type: 'float', address: 0x20000000 + 4 * index, scalarKind: 'float32', byteWidth: 4, writable: true }));
    setVariableCatalog(fixtureVariables); state.selected = [];
    state.debugAccess = true; document.getElementById('search').value = '';
    displayVariables();
    const list = document.getElementById('variables'); list.scrollTop = 400;
    const before = list.scrollTop;
    list.querySelectorAll('input[type="checkbox"]')[60].click();
    const after = list.scrollTop;
    const countBeforeWrite = state.selected.length;
    list.querySelector('.variable-write').click();
    const dialogOpened = document.getElementById('writeDialog').open;
    const priorFetch = window.fetch; let writeRequest;
    window.fetch = (input, init) => {
      if (input === '/api/write-variable') {
        writeRequest = JSON.parse(init.body);
        return Promise.resolve(new Response(JSON.stringify({ id: writeRequest.id, value: '1.25', verified: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }));
      }
      return priorFetch(input, init);
    };
    document.getElementById('writeValue').value = '1.25';
    try { await document.getElementById('writeSubmit').onclick(); }
    finally { window.fetch = priorFetch; }
    return { readOnlyButtons, before, after, dialogOpened, closed: !document.getElementById('writeDialog').open,
      selectedUnchanged: state.selected.length === countBeforeWrite, writeRequest };
  })()`);
  assert.equal(variableControls.readOnlyButtons, 0);
  assert.ok(variableControls.before > 0);
  assert.equal(variableControls.after, variableControls.before);
  assert.equal(variableControls.dialogOpened && variableControls.closed && variableControls.selectedUnchanged, true);
  assert.deepEqual(variableControls.writeRequest, { id: 'global-0', value: '1.25' });
  await evaluate("document.getElementById('closeVariablePicker').click(); document.getElementById('search').value = ''; displayVariables()");
  const independentWatch = await evaluate(`(async () => {
    const id=state.selected[0], previousFetch=window.fetch, requests=[];
    displaySelectedVariables();
    const destination=document.querySelector('#selectedVariables select');
    destination.value='watch-only'; destination.dispatchEvent(new Event('change'));
    window.fetch=async (url,init)=> {
      if(['/api/debug/snapshot','/api/subscribe','/api/write-variable'].includes(url)) {
        const request=JSON.parse(init.body); requests.push({url,request});
        const result=url==='/api/debug/snapshot'?{values:[{id,value:7.25}]}:url==='/api/subscribe'?{ids:[],banks:1}:{id,value:8.5,verified:true};
        return new Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return previousFetch(url,init);
    };
    try {
      await readWatchValues([id]);
      const noSubscribe=requests.every(item=>item.url!=='/api/subscribe');
      const readValue=document.querySelector('#selectedVariables .selected-variable-value').textContent;
      document.querySelector('#selectedVariables .variable-write').click();
      document.getElementById('writeValue').value='8.5'; await document.getElementById('writeSubmit').onclick();
      await document.getElementById('subscribe').onclick();
      return {noSubscribe,readValue,plotIds:plotVariableIds(),selected:state.selected.length,
        subscription:requests.find(item=>item.url==='/api/subscribe').request.ids.includes(id),
        wrote:requests.some(item=>item.url==='/api/write-variable' && item.request.id===id)};
    } finally {window.fetch=previousFetch;}
  })()`);
  assert.deepEqual(independentWatch,{noSubscribe:true,readValue:'7.250000',plotIds:[],selected:1,subscription:true,wrote:true});
  // The resize handle may be hidden behind a narrow hosted desktop or the
  // saved sidebar width may already be at its 640 px limit.
  await call('Emulation.setDeviceMetricsOverride',{width:1000,height:700,deviceScaleFactor:1,mobile:false});
  const sidebarDrag = await evaluate(`(async () => {
    setView('scope'); setScopeSidebarWidth(240);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const handle = document.getElementById('scopeResize').getBoundingClientRect();
    const x=handle.left+handle.width/2, y=handle.top+handle.height/2;
    return {x,y,before:document.getElementById('scopeSidebar').getBoundingClientRect().width,
      hit:document.elementFromPoint(x,y)?.id,limit:Math.min(640,window.innerWidth-350)};
  })()`);
  assert.equal(sidebarDrag.hit,'scopeResize',`Resize handle must be visible: ${JSON.stringify(sidebarDrag)}`);
  assert.ok(sidebarDrag.limit>=sidebarDrag.before+70,'Viewport must allow a 70 px resize');
  let sidebarWidth;
  try {
    // CDP mouse coordinates are mapped differently by some hosted macOS and
    // Windows desktops after Emulation.setDeviceMetricsOverride. The hit test
    // above checks the visible handle; dispatch pointer events in the renderer
    // so the resize behavior is deterministic on every runner.
    sidebarWidth = await evaluate(`(() => {
      const handle=document.getElementById('scopeResize');
      handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button:0,clientX:${sidebarDrag.x},clientY:${sidebarDrag.y}}));
      window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,buttons:1,clientX:${sidebarDrag.x + 70},clientY:${sidebarDrag.y}}));
      window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,button:0,clientX:${sidebarDrag.x + 70},clientY:${sidebarDrag.y}}));
      return document.getElementById('scopeSidebar').getBoundingClientRect().width;
    })()`);
    assert.ok(sidebarWidth>=sidebarDrag.before+60,`Resize did not move: before=${sidebarDrag.before}, after=${sidebarWidth}`);
  } finally { await call('Emulation.clearDeviceMetricsOverride'); }

  const debugInspector = await evaluate(`(async () => {
    const previousFetch = window.fetch;
    const source = ${JSON.stringify(path.join(pnxFixture, 'app', 'app.cpp'))};
    const names = ['can_diag_sample_count','can_diag_bus[0].state_bo','can_diag_bus[0].ack_total',
      'can_diag_bus[0].rx_frames_total','can_diag_bus[0].tx_attempts_total'];
    const values = [10,1,5,0,10];
    setVariableCatalog(names.map((name, index) => ({ id: 'diag-' + index, name, type: 'uint32_t' })));
    state.connected = true; state.debugAccess = true; renderDebugPanel();
    window.fetch = (url, options) => String(url) === '/api/debug/snapshot'
      ? Promise.resolve(new Response(JSON.stringify(JSON.parse(options.body).includeStack
        ? { values: [], frame: { source: { path: source }, line: 1, instructionPointerReference: '0x08001234' } }
        : { values: JSON.parse(options.body).ids.map(id => ({ id, value: values[Number(id.slice(5))] })) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } })) : previousFetch(url, options);
    try {
      await handleDebugEvent({ event: 'stopped', reason: 'breakpoint' });
      const marker = document.querySelector('#breakpointGutter .current-execution')?.textContent === '1'
        && document.getElementById('executionLine').classList.contains('visible');
      const location = document.getElementById('debugLocation').textContent;
      document.getElementById('diagnosticTarget').value = 'can0';
      await captureDiagnosticSnapshot();
      const diagnosis = document.getElementById('diagnosticFindings').textContent;
      const listed = document.querySelectorAll('#diagnosticValues .diagnostic-value').length;
      const statusHint = statusFindings([{ name: 'state.can.last_status', type: 'types::status', value: 2 }])[0];
      return { marker, location, workspace: state.workspace, source, diagnosis, listed,
        icon: !!document.querySelector('#quickContinue svg'), statusHint };
    } finally { window.fetch = previousFetch; }
  })()`);
  const debugScreenshot = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(path.join(root, '.cache', 'electron-ui-debug.png'), Buffer.from(debugScreenshot.data, 'base64'));
  await evaluate("handleDebugEvent({ event: 'continued' })");
  debugInspector.cleared = await evaluate("!document.getElementById('executionLine').classList.contains('visible')");
  assert.equal(debugInspector.marker && debugInspector.cleared && debugInspector.icon, true, JSON.stringify(debugInspector));
  assert.match(debugInspector.location, /app\.cpp:1 · 0x08001234/);
  assert.match(debugInspector.diagnosis, /Bus Off/);
  assert.equal(debugInspector.listed, 5);
  assert.match(debugInspector.statusHint, /not_configured/);
  console.log(JSON.stringify({ profile: realProbe ? 'stlink-300' : mockBanked ? 'mock-banked-4' : 'mock-4', configPage, configNavigation, deviceTools, toolchainSetup, missingToolPrompt, probePicker, editor, genericState, navigation, savedDirtyTabs: 2, workflows, terminal, plots, axis, dragOrder: order,
    acquisition: { ...acquisition, liveValues: acquisition.liveValues.slice(0, 8) }, selectedView, plotInteraction, wheelZoom, panned, fullScreenPlot, fullScreenGrid, csv, variableTree, deepTree, variableControls, sidebarWidth, debugInspector,
    rendererTaskSecondsInTwoSeconds: Number((duration(performanceAfter) - duration(performanceBefore)).toFixed(3)), screenshotPath }, null, 2));
  assert.equal(await evaluate("document.getElementById('quickStop').disabled"), false);
  await evaluate("document.getElementById('quickStop').onclick()");
  assert.equal(await evaluate("!state.connected && !state.debugAccess && document.getElementById('quickStop').disabled && !document.getElementById('executionLine').classList.contains('visible')"), true);
  const driverChecks = await evaluate(`(async () => {
    const originalFetch = window.fetch;
    const results = [];
    try {
      for (const status of ['missing', 'ready', 'unknown', 'absent']) {
        window.fetch = async url => url === '/api/probes/stlink-driver'
          ? { ok: true, json: async () => ({ platform: 'win32', state: status, devices: [] }) } : originalFetch(url);
        await document.getElementById('checkStlinkDriver').onclick();
        results.push({ status, text: document.getElementById('stlinkDriverStatus').textContent,
          enabled: !document.getElementById('checkStlinkDriver').disabled,
          link: document.querySelector('#stlinkDriverStatus a').href });
      }
    } finally { window.fetch = originalFetch; }
    return results;
  })()`);
  assert.match(driverChecks[0].text, /代码 28/);
  assert.match(driverChecks[1].text, /状态正常/);
  assert.match(driverChecks[2].text, /无法确定/);
  assert.match(driverChecks[3].text, /未检测到/);
  assert.ok(driverChecks.every(item => item.enabled && item.link === 'https://www.st.com/en/development-tools/stsw-link009.html'));
  const groupChecks = await evaluate(`(async () => {
    const original = state.activePlotGroup;
    document.getElementById('addPlotGroup').click();
    const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
    dialog.querySelector('input').value = 'IMU'; dialog.close('save');
    await new Promise(resolve => setTimeout(resolve, 30));
    const created = state.activePlotGroup !== original && document.getElementById('plotGrid').children.length === 1;
    const id = state.activePlotGroup;
    document.getElementById('addPlot').click();
    const multiple = document.getElementById('plotGrid').children.length === 2;
    document.querySelector('#plotGroups button').click();
    const switched = state.activePlotGroup === original && [...document.getElementById('plotGrid').children].every(card => state.plots.find(plot => plot.id === card.dataset.plotId).groupId !== id);
    const row = document.querySelector('.selected-variable-row');
    row?.querySelector('.selected-variable-top').click();
    const actions = !row || getComputedStyle(row.querySelector('.selected-variable-actions')).display === 'flex';
    return {created, multiple, switched, actions};
  })()`);
  assert.deepEqual(groupChecks, {created:true, multiple:true, switched:true, actions:true});
  console.log('Curve group switching and variable actions passed');
  console.log('ST-Link driver UI checks passed');
  await evaluate("setView('editor')");
  const chrome=await evaluate(`({top:document.querySelector('.titlebar').getBoundingClientRect().height,tools:document.querySelector('.editor-toolbar').getBoundingClientRect().height,statusInFooter:document.getElementById('status').parentElement.id==='statusBar'})`);
  assert.deepEqual(chrome,{top:34,tools:30,statusInFooter:true});
  const chromeImage=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(path.join(root,'.cache','electron-ui-compact-editor.png'),Buffer.from(chromeImage.data,'base64'));

  const themeCheck=await evaluate(`(() => {
    document.getElementById('themeToggle').click();
    return {theme:document.documentElement.dataset.theme,saved:localStorage.getItem('pnx-theme'),config:document.getElementById('configFrame').contentDocument.documentElement.dataset.theme,axis:themeColor('#dark','#light')};
  })()`);
  assert.deepEqual(themeCheck,{theme:'light',saved:'light',config:'light',axis:'#light'});
  // Theme colors transition; computed style can still report the old frame.
  const themeDeadline=Date.now()+2000;
  while (Date.now()<themeDeadline && await evaluate("getComputedStyle(document.getElementById('editorSurface')).backgroundColor")!=='rgb(255, 255, 255)') await pause(40);
  assert.equal(await evaluate("getComputedStyle(document.getElementById('editorSurface')).backgroundColor"),'rgb(255, 255, 255)');
  const iconStyle = () => evaluate(`(() => {const style=getComputedStyle(document.getElementById('quickBuild'));return {background:style.backgroundColor,color:style.color};})()`);
  const iconDeadline=Date.now()+2000;
  while (Date.now()<iconDeadline && (await iconStyle()).color!=='rgb(54, 91, 181)') await pause(40);
  assert.deepEqual(await iconStyle(),{background:'rgba(0, 0, 0, 0)',color:'rgb(54, 91, 181)'});
  assert.equal(await evaluate("getComputedStyle(document.getElementById('explorer')).backgroundColor"),'rgb(243, 244, 246)');
  assert.equal(await evaluate("getComputedStyle(document.getElementById('log')).backgroundColor"),'rgb(255, 255, 255)');
  await pause(150);
  const lightImage=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
  writeFileSync(path.join(root,'.cache','electron-ui-light.png'),Buffer.from(lightImage.data,'base64'));
  await evaluate("document.getElementById('themeToggle').click()");
  assert.equal(await evaluate("document.documentElement.dataset.theme"),'dark');
  const flashEvents = await evaluate(`(async () => {
    const previousFetch=window.fetch; let reads=0;
    window.fetch=(...args)=>{reads++; return previousFetch(...args);};
    try {
      state.debugAccess=false; state.flashAccess=true;
      await handleDebugEvent({event:'stopped',reason:'flash'});
      return {reads,paused:state.debugPaused};
    } finally {window.fetch=previousFetch;state.flashAccess=false;}
  })()`);
  assert.deepEqual(flashEvents,{reads:0,paused:false});
  const allPause = await evaluate(`(async () => {
    await connect(true,false); state.selected=state.variables.slice(0,2).map(v=>v.id); await applySampling();
    await new Promise(resolve=>setTimeout(resolve,200));
    // Include a hidden group and a plot that was paused individually earlier.
    plotView(state.plots[0].id).paused=true;
    document.getElementById('pauseAllPlots').click();
    const time=state.lastTimestampNs, samples=state.sampleCount;
    const aligned=state.plots.every(p=>plotView(p.id).paused && plotView(p.id).anchorNs===time);
    const frozen=plotView(state.plots[0].id).snapshot;
    const count=[...frozen.series.values()].reduce((n,a)=>n+a.length,0);
    await new Promise(resolve=>setTimeout(resolve,200));
    const unchanged=[...frozen.series.values()].reduce((n,a)=>n+a.length,0)===count;
    const sampling=state.sampleCount>samples;
    state.activePlotGroup=state.plotGroups.at(-1).id; renderPlots();
    const hiddenPaused=[...document.querySelectorAll('.plot-pause')].every(b=>b.textContent==='继续');
    document.getElementById('pauseAllPlots').click();
    const resumed=state.plots.every(p=>!plotView(p.id).paused && plotView(p.id).snapshot===null);
    return {aligned,unchanged,sampling,hiddenPaused,resumed};
  })()`);
  assert.deepEqual(allPause,{aligned:true,unchanged:true,sampling:true,hiddenPaused:true,resumed:true});
  console.log('All plots pause:',JSON.stringify(allPause));
  const watchPersistence = await evaluate(`(async () => {
    await connect(true,false);
    const variable=state.variables[0]; state.selected=[variable.id]; state.plotAssignments.set(variable.id,state.plots[0].id);
    const before=captureWatchConfig();
    await api('/api/watch-config',before);
    await disconnect(); await new Promise(resolve=>setTimeout(resolve,100));
    const retained=captureWatchConfig().variables;
    state.selected=[]; setVariableCatalog([],[]);
    await loadWatchFile();
    const offline=captureWatchConfig().variables;
    await connect(true,false);
    const resolved=state.selected.every(id=>!state.variableById.get(id)?.unavailable);
    const after=captureWatchConfig();
    const grid=document.getElementById('plotGrid').getBoundingClientRect();
    const scope=document.getElementById('scopeArea').getBoundingClientRect();
    await disconnect();
    return {before:before.variables,retained,offline,after:after.variables,resolved,toolbarHeight:grid.top-scope.top};
  })()`);
  assert.deepEqual(watchPersistence.retained,watchPersistence.before);
  assert.deepEqual(watchPersistence.offline,watchPersistence.before);
  assert.deepEqual(watchPersistence.after,watchPersistence.before);
  assert.equal(watchPersistence.resolved,true);
  assert.ok(watchPersistence.toolbarHeight < 160);
  console.log('Workspace watch persistence:',JSON.stringify(watchPersistence));
  const largeSearch = await evaluate(`(() => {
    const vars = Array.from({length:32000}, (_,i) => ({id:'perf-'+i,name:'sensor.channel_'+i,type:'float',writable:true,address:0x20000000+i*4}));
    setVariableCatalog(vars); state.selected=[]; state.connected=true; state.debugAccess=false;
    document.getElementById('search').value='sensor';
    const start=performance.now(); displayVariables();
    const elapsed=performance.now()-start;
    const rows=document.querySelectorAll('#variables .variable-leaf').length;
    const total=state.matchingVariableIds.length;
    document.getElementById('variableNext').click();
    const next=document.querySelector('#variables input').value;
    changeVariableSelection(['perf-0'],true);
    const watch=document.querySelector('#selectedVariables .selected-variable-row');
    const reason=watch.querySelector('.variable-write-reason').textContent;
    const upgrade=[...watch.querySelectorAll('button')].some(b=>b.textContent==='切换可写连接');
    document.getElementById('search').value='channel_31999'; displayVariables();
    return {rows,total,next,elapsed,reason,upgrade,match:state.matchingVariableIds};
  })()`);
  assert.equal(largeSearch.rows,200); assert.equal(largeSearch.total,32000);
  assert.equal(largeSearch.next,'perf-200'); assert.equal(largeSearch.upgrade,true);
  assert.match(largeSearch.reason,/只读采样/); assert.deepEqual(largeSearch.match,['perf-31999']);
  console.log('Large catalog search:',JSON.stringify(largeSearch));

  await evaluate('window.close()');
  closedByTest = true;
} finally {
  if (!closedByTest && evaluate && ws?.readyState === WebSocket.OPEN) {
    try { await Promise.race([evaluate('disconnect().catch(() => {})'), pause(2500)]); } catch { /* Best effort. */ }
    try { await Promise.race([evaluate('window.close()'), pause(2500)]); } catch { /* Best effort. */ }
  }
  ws?.close();
  if (child.exitCode === null) {
    await Promise.race([once(child, 'exit'), pause(5000)]);
    if (child.exitCode === null) child.kill();
  }
}
