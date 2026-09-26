const $ = id => document.getElementById(id);
const token = window.PNX_TOKEN;
const colors = ['#5ee1a8','#ffbd69','#6db6ff','#ff7397','#bb9aff','#f0e07b','#6de1e9','#f890e7'];
const BANK_CHANNELS = 256;
const PLOT_PAGE_SIZE = 64;
const state = { board: 'h723_mc02', preset: 'h723-debug', config: {}, hardware: {}, variables: [], selected: [], activeIds: [], activeIndex: new Map(), points: [], latest: [], series: new Map(), latestById: new Map(), latestAtById: new Map(), firstTimestampNs: null, lastTimestampNs: 0, banks: 1, bankSize: BANK_CHANNELS, bankDwellMs: 0, streamEpoch: null, sampleCount: 0, droppedFrames: 0, rateWindow: [], lastSampleAt: 0, connected: false, flashAccess: false,
  projectProfile: null, debugAccess: false, debugPaused: false, debugReason: '', stoppedAt: null, breakpoints: new Map(), breakpointResults: new Map(), workspace: null, projectRoot: null, file: null, files: new Map(), variableById: new Map(), variableTree: [], variableNodes: new Map(), variableLeafIds: new Map(), expandedVariables: new Set(), matchingVariableIds: [], plotGroups: [{ id: 'default', name: '默认组' }], activePlotGroup: 'default', plots: [{ id: 'plot-1', name: '曲线 1' }], plotAssignments: new Map(), plotPages: new Map(), plotViews: new Map(), view: 'editor',
  observedValues: new Map(), valueChangedAt: new Map(), valueSeenAt: new Map(), recording: false, recordFile: null, recordRows: 0, recordError: null, missingTools: [] };
async function api(route, data) {
  const response = await fetch(route, { method: data === undefined ? 'GET' : 'POST', headers: { 'X-PnX-Token': token, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}
async function perform(action) { try { await action(); } catch (error) {
  log(`ERROR: ${error.message}`, activeTerminal);
  $('status').textContent = /reset not supported by WinUSB/i.test(error.message)
    ? 'ST-Link 连接失败：WinUSB 无法软件复位探针，请重新插拔探针后重试。' : error.message;
} }
async function scanProbes() {
  const button = $('scanProbes');
  button.disabled = true;
  $('probeScanStatus').textContent = '正在扫描 USB 调试探针…';
  try {
    const { probes } = await api('/api/probes');
    const counts = new Map();
    for (const probe of probes) counts.set(probe.selector, (counts.get(probe.selector) || 0) + 1);
    const list = $('probeList');
    list.replaceChildren(new Option('自动选择', 'auto'));
    for (const probe of probes) {
      const label = `${probe.family} · ${probe.identifier}${probe.serialNumber ? ` · ${probe.serialNumber}` : ''}`;
      const option = new Option(label, probe.selector);
      if (counts.get(probe.selector) > 1) { option.disabled = true; option.textContent += ' · selector 重复'; }
      list.add(option);
    }
    const current = $('probe').value.trim() || 'auto';
    list.value = current;
    if (list.value !== current) list.selectedIndex = -1;
    $('probeScanStatus').textContent = probes.length ? `发现 ${probes.length} 个探针；请选择 ST-Link 或 DAPLink / CMSIS-DAP 后连接。` : '未发现探针。请检查 USB 连接与调试探针驱动。';
  } catch (error) { $('probeScanStatus').textContent = `扫描失败：${error.message}`; throw error; }
  finally { button.disabled = false; }
}
const terminalNames = { general: '常规', build: '构建', debug: '调试', flash: '烧录', diagnostics: '诊断' };
async function checkStlinkDriver() {
  const button = $('checkStlinkDriver'), output = $('stlinkDriverStatus');
  button.disabled = true; output.textContent = '正在读取 ST-Link 设备与驱动信息…';
  try {
    const result = await api('/api/probes/stlink-driver');
    const messages = {
      absent: '未检测到已接入的 ST-Link，无法判断驱动是否已安装。请检查 USB 数据线和接口，再重新检测。',
      missing: '检测到 ST-Link 接口缺少驱动（代码 28）。请安装 ST 官方驱动后重新插拔设备并检测。',
      error: '检测到 ST-Link 接口异常。请根据下方设备错误码检查设备管理器；异常不一定由驱动导致。',
      ready: 'Windows 报告 ST-Link 设备状态正常。可点击“扫描探针”继续；此检查不代表 SWD 连接或目标板正常。',
      unknown: result.error || '设备状态信息不完整，无法确定驱动是否正常。请在设备管理器中检查。',
      unsupported: '当前系统不使用 Windows ST-Link 驱动检查。请通过“扫描探针”检查识别情况；Linux 还需检查 USB 访问权限。',
    };
    output.replaceChildren();
    const summary = document.createElement('p'); summary.textContent = messages[result.state] || messages.unknown; output.append(summary);
    for (const device of result.devices || []) {
      const row = document.createElement('p');
      row.textContent = `${device.name || 'ST-Link 接口'} · ${device.id} · 错误码 ${device.problem ?? '未知'} · 服务 ${device.service || '未知'} · 驱动 ${device.provider || '未知'} ${device.version || ''} · INF ${device.inf || '未知'}`;
      output.append(row);
    }
    if (result.platform === 'win32') {
      const link = document.createElement('a'); link.textContent = 'ST 官方驱动下载（STSW-LINK009）';
      link.href = 'https://www.st.com/en/development-tools/stsw-link009.html'; link.target = '_blank'; link.rel = 'noopener noreferrer'; output.append(link);
      if (window.PNXDesktop?.openToolDownload) link.onclick = event => { event.preventDefault(); perform(() => window.PNXDesktop.openToolDownload('stlink')); };
    }
  } catch (error) { output.textContent = `检查失败：${error.message}`; }
  finally { button.disabled = false; }
}
const terminals = new Map([['general', '']]);
let activeTerminal = 'general';
let nextTerminal = 1;
function renderTerminals() {
  $('terminalTabs').replaceChildren();
  for (const id of terminals.keys()) {
    const tab = document.createElement('button');
    tab.className = `terminal-tab${id === activeTerminal ? ' active' : ''}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(id === activeTerminal));
    tab.textContent = terminalNames[id] || id;
    tab.onclick = () => activateTerminal(id);
    $('terminalTabs').append(tab);
  }
  const view = $('log');
  view.textContent = terminals.get(activeTerminal) || '';
  view.scrollTop = view.scrollHeight;
}
function activateTerminal(id, show = true) {
  if (!terminals.has(id)) terminals.set(id, '');
  activeTerminal = id;
  if (show) document.body.classList.remove('terminal-closed');
  renderTerminals();
}
function log(value, channel = 'general') {
  if (!terminals.has(channel)) terminals.set(channel, '');
  const old = terminals.get(channel);
  const addition = `${value}${String(value).endsWith('\n') ? '' : '\n'}`;
  terminals.set(channel, (old + addition).slice(-100000));
  if (channel === activeTerminal) {
    const view = $('log');
    view.textContent = terminals.get(channel);
    view.scrollTop = view.scrollHeight;
  } else renderTerminals();
}
const toolLabels = { cmake: 'CMake', ninja: 'Ninja', arm: 'Arm GNU Toolchain' };
function showToolchain(tools, prefix) {
  $('toolchainStatus').replaceChildren();
  const heading = document.createElement('strong'); heading.textContent = prefix; $('toolchainStatus').append(heading);
  for (const name of Object.keys(toolLabels)) {
    const row = document.createElement('div');
    const tool = tools?.[name];
    row.textContent = tool ? `${toolLabels[name]}：${tool.directory}（${tool.source === 'PATH' ? '已在 PATH' : '已找到'}）` : `${toolLabels[name]}：未找到`;
    $('toolchainStatus').append(row);
  }
}
async function setupToolchain() {
  const button = $('toolchainSetup'); button.disabled = true;
  $('toolchainStatus').textContent = '正在检查 PATH 和安装目录…';
  try {
    const folder = $('toolchainFolder').value.trim();
    const scan = await api(`/api/toolchain/scan${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`);
    showToolchain(scan.tools, scan.complete ? '已找到全部工具，正在配置…' : '以下工具需要安装：');
    if (!scan.complete) {
      state.missingTools = scan.missing;
      $('toolchainMissingText').textContent = scan.missing.map(name => toolLabels[name]).join('、');
      $('toolchainMissing').showModal();
      return;
    }
    const result = await api('/api/toolchain/configure', {});
    showToolchain(result.configured, result.userPathError ? '平台已配置；写入当前用户 PATH 失败：' + result.userPathError
      : result.scope === 'app' ? '平台已配置，可立即编译；系统 PATH 未修改。' : '配置完成，可立即编译。');
    log(`编译工具链已配置：${result.added.length ? result.added.join('；') : '工具已在 PATH'}`, 'build');
  } catch (error) { $('toolchainStatus').textContent = `配置失败：${error.message}`; throw error; }
  finally { button.disabled = false; }
}
$('terminalAdd').onclick = () => activateTerminal(`终端 ${nextTerminal++}`);
$('terminalClear').onclick = () => { terminals.set(activeTerminal, ''); renderTerminals(); };
$('terminalHide').onclick = () => document.body.classList.add('terminal-closed');
$('terminalToggle').onclick = () => document.body.classList.toggle('terminal-closed');
document.addEventListener('keydown', event => {
  if (event.ctrlKey && event.key === '`') { event.preventDefault(); document.body.classList.toggle('terminal-closed'); }
});
let terminalResizeStart;
$('terminalResize').addEventListener('pointerdown', event => {
  terminalResizeStart = { y: event.clientY, height: $('terminalPanel').getBoundingClientRect().height };
  $('terminalResize').setPointerCapture(event.pointerId);
});
$('terminalResize').addEventListener('pointermove', event => {
  if (!terminalResizeStart) return;
  const height = Math.max(130, Math.min(window.innerHeight * 0.65, terminalResizeStart.height + terminalResizeStart.y - event.clientY));
  $('desktopShell').style.setProperty('--terminal-height', `${height}px`);
});
$('terminalResize').addEventListener('pointerup', () => { terminalResizeStart = undefined; });
function setScopeSidebarWidth(width) {
  const limited = Math.max(180, Math.min(Math.min(640, window.innerWidth - 350), Math.round(width)));
  $('desktopShell').style.setProperty('--scope-sidebar-width', `${limited}px`);
  try { localStorage.setItem('pnx-scope-sidebar-width', String(limited)); } catch { /* Storage can be disabled. */ }
  scheduleDraw(true);
}
let scopeResizeStart;
$('scopeResize').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  scopeResizeStart = { x: event.clientX, width: $('scopeSidebar').getBoundingClientRect().width };
  $('scopeResize').setPointerCapture(event.pointerId);
  $('scopeResize').classList.add('resizing');
});
$('scopeResize').addEventListener('pointermove', event => {
  if (scopeResizeStart) setScopeSidebarWidth(scopeResizeStart.width + event.clientX - scopeResizeStart.x);
});
function endScopeResize() { scopeResizeStart = undefined; $('scopeResize').classList.remove('resizing'); }
$('scopeResize').addEventListener('pointerup', endScopeResize);
$('scopeResize').addEventListener('pointercancel', endScopeResize);
$('scopeResize').addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
  event.preventDefault();
  setScopeSidebarWidth($('scopeSidebar').getBoundingClientRect().width + (event.key === 'ArrowRight' ? 20 : -20));
});
renderTerminals();
function configFrameSource() { return `/config-editor?board=${encodeURIComponent(state.board)}&preset=${encodeURIComponent(state.preset)}&role=params`; }
function updateConfigFrame() {
  const frame = $('configFrame');
  if (state.projectRoot) {
    frame.removeAttribute('srcdoc');
    const source = configFrameSource();
    if (frame.getAttribute('src') !== source) frame.setAttribute('src', source);
  } else {
    frame.removeAttribute('src');
    const placeholder = '<body style="background:#181b20;color:#b8c4d3;font:14px Segoe UI,sans-serif;padding:24px">PnX 配置插件未启用或未识别到兼容工程。请点击顶部“目标与插件”设置通用调试目标和构建任务。</body>';
    if (frame.getAttribute('srcdoc') !== placeholder) frame.setAttribute('srcdoc', placeholder);
  }
}
function setView(view) {
  if (!['editor', 'scope', 'config', 'tools'].includes(view)) return;
  state.view = view;
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll('[data-view-target]')) {
    const active = button.dataset.viewTarget === view || (view === 'tools' && button.dataset.viewTarget === 'config');
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  try { localStorage.setItem('pnx-active-view', view); } catch { /* Storage can be disabled. */ }
  if (view === 'scope') scheduleDraw(true);
  if (view === 'config') updateConfigFrame();
}
function fileDirty(file = state.file) { return !!file && file.value !== file.text; }
const definitionHistory = [];
function editorLocation() {
  if (!state.file) return null;
  return { path: state.file.path, offset: $('codeEditor').selectionStart, scrollTop: $('codeEditor').scrollTop, scrollLeft: $('codeEditor').scrollLeft };
}
function wordAtCursor() {
  const editor = $('codeEditor'), source = editor.value;
  if (editor.selectionStart !== editor.selectionEnd) {
    const selected = source.slice(editor.selectionStart, editor.selectionEnd);
    return /^[A-Za-z_]\w*$/.test(selected) ? selected : null;
  }
  let start = editor.selectionStart;
  if (start > 0 && !/[A-Za-z_0-9]/.test(source[start]) && /[A-Za-z_0-9]/.test(source[start - 1])) start--;
  if (!/[A-Za-z_0-9]/.test(source[start] || '')) return null;
  let end = start + 1;
  while (start > 0 && /[A-Za-z_0-9]/.test(source[start - 1])) start--;
  while (end < source.length && /[A-Za-z_0-9]/.test(source[end])) end++;
  const name = source.slice(start, end);
  return /^[A-Za-z_]\w*$/.test(name) ? name : null;
}
function offsetForLine(text, line, column = 1) {
  let offset = 0;
  for (let row = 1; row < line && offset < text.length; row++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  const end = text.indexOf('\n', offset);
  return Math.min(offset + Math.max(0, column - 1), end < 0 ? text.length : end);
}
async function navigateTo(location, remember = true) {
  const previous = editorLocation();
  if (location.path !== state.file?.path) await openFile(location.path, document.createElement('button'));
  if (remember && previous) definitionHistory.push(previous);
  $('goBack').disabled = definitionHistory.length === 0;
  const editor = $('codeEditor');
  const offset = location.offset ?? offsetForLine(editor.value, location.line, location.column);
  editor.focus(); editor.setSelectionRange(offset, offset + (location.length || 0));
  if (location.scrollTop !== undefined) editor.scrollTop = location.scrollTop;
  else {
    const line = location.line || editor.value.slice(0, offset).split('\n').length;
    const rowHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
    editor.scrollTop = Math.max(0, (line - 1) * rowHeight - editor.clientHeight * .3);
  }
  editor.scrollLeft = location.scrollLeft || 0;
  if (state.file) { state.file.scrollTop = editor.scrollTop; state.file.scrollLeft = editor.scrollLeft; }
  syncHighlightScroll();
}
function dirtyEditorOverrides() {
  const overrides = {}, current = state.file;
  let budget = 1_200_000;
  for (const file of [current, ...state.files.values()]) {
    if (!file || !fileDirty(file) || Object.hasOwn(overrides, file.path)) continue;
    const cost = file.value.length * 3;
    if (cost > budget) continue;
    overrides[file.path] = file.value; budget -= cost;
  }
  return overrides;
}
async function goToDefinition() {
  if (!state.file) return;
  const name = wordAtCursor();
  if (!name) { $('status').textContent = '请将光标放在 C/C++ 标识符上'; return; }
  const editor = $('codeEditor');
  let start = editor.selectionStart;
  while (start > 0 && /[A-Za-z_0-9]/.test(editor.value[start - 1])) start--;
  const qualifier = editor.value.slice(0, start).match(/(?:::)?(?:[A-Za-z_]\w*\s*::\s*)+$/)?.[0] || '';
  const result = await api('/api/workspace/definitions', { name: qualifier.replace(/\s/g, '') + name, overrides: dirtyEditorOverrides() });
  if (!result.matches.length) { $('status').textContent = `未找到 ${name} 的定义`; return; }
  const definitions = result.matches.filter(item => item.rank < 3);
  const owners = new Set(result.matches.map(item => item.qualifiedName));
  if ((definitions.length === 1 && owners.size === 1) || result.matches.length === 1) { await navigateTo({ ...(definitions[0] || result.matches[0]), length: name.length }); return; }
  $('definitionTitle').textContent = `跳转到 ${name} 的定义`;
  $('definitionHint').textContent = `找到 ${result.matches.length} 个候选位置。请选择要打开的位置。`;
  $('definitionResults').replaceChildren(...result.matches.map(item => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'definition-result';
    const heading = document.createElement('strong'); heading.textContent = `${item.path}:${item.line} · ${item.kind}`;
    const preview = document.createElement('span'); preview.textContent = item.preview;
    button.append(heading, preview);
    button.onclick = () => { $('definitionDialog').close(); perform(() => navigateTo({ ...item, length: name.length })); };
    return button;
  }));
  $('definitionDialog').showModal();
}
function goToLine() {
  if (!state.file) return;
  const editor = $('codeEditor');
  $('lineNumber').max = String(editor.value.split('\n').length);
  $('lineNumber').value = String(editor.value.slice(0, editor.selectionStart).split('\n').length);
  $('lineDialog').showModal(); $('lineNumber').focus(); $('lineNumber').select();
}
// Keep confirmations in the renderer: native JS dialogs can leave Windows
// Electron text controls without keyboard focus after closing.
function confirmAction(message) {
  const previousFocus = document.activeElement;
  const dialog = document.createElement('dialog');
  dialog.className = 'confirmation-dialog';
  const title = document.createElement('h2'); title.textContent = '确认操作';
  const text = document.createElement('p'); text.textContent = message;
  const actions = document.createElement('div'); actions.className = 'row';
  const cancel = document.createElement('button'); cancel.textContent = '取消';
  const accept = document.createElement('button'); accept.textContent = '确认'; accept.className = 'primary';
  cancel.onclick = () => dialog.close('cancel');
  accept.onclick = () => dialog.close('confirm');
  actions.append(cancel, accept); dialog.append(title, text, actions); document.body.append(dialog);
  return new Promise(resolve => {
    dialog.onclose = () => {
      const accepted = dialog.returnValue === 'confirm';
      dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(accepted);
    };
    dialog.showModal(); cancel.focus();
  });
}
async function mayCloseFile() { return ![...state.files.values()].some(fileDirty) || await confirmAction('当前工作区有未保存修改。放弃修改并继续？'); }
const escapeHtml = text => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const cppToken = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|^\s*#[^\n]*|\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b|\b[A-Za-z_]\w*\b/gm;
const cppKeywords = new Set('alignas alignof asm auto break case catch class const consteval constexpr constinit continue default delete do else enum explicit export extern false for friend goto if inline mutable namespace new noexcept nullptr operator override private protected public register reinterpret_cast requires return sizeof static static_assert struct switch template this throw true try typedef typename union using virtual volatile while'.split(' '));
const cppTypes = new Set('bool char char8_t char16_t char32_t double float int long short signed unsigned void wchar_t size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t'.split(' '));
const pythonToken = /#[^\n]*|(?:[rRuUbBfF]{0,2})(?:"""[\s\S]*?(?:"""|(?![\s\S]))|'''[\s\S]*?(?:'''|(?![\s\S]))|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b|\b[A-Za-z_]\w*\b/gm;
const pythonKeywords = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '));
const pythonTypes = new Set('bool bytes dict float int list object set str tuple range print len self super'.split(' '));
let highlightTimer;
let stopRevision = 0;
function highlightCode() {
  const file = state.file;
  const source = $('codeEditor').value;
  const plain = source.length > 250_000;
  $('codeEditor').classList.toggle('plain', plain);
  if (plain) { $('codeHighlight').textContent = ''; return; }
  const python = /\.(py|pyw|pyi)$/i.test(file?.path || '');
  if (!file || (!python && !/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(file.path))) { $('codeHighlight').innerHTML = escapeHtml(source) + '\n'; return; }
  let out = '', at = 0;
  for (const match of source.matchAll(python ? pythonToken : cppToken)) {
    out += escapeHtml(source.slice(at, match.index));
    const word = match[0]; let kind = '';
    if (python && word.startsWith('#')) kind = 'comment';
    else if (python && /^[rRuUbBfF]{0,2}[\"']/.test(word)) kind = 'string';
    else if (word.startsWith('//') || word.startsWith('/*')) kind = 'comment';
    else if (word.startsWith('"') || word.startsWith("'")) kind = 'string';
    else if (word.trimStart().startsWith('#')) kind = 'preproc';
    else if (/^(?:\d|0x)/.test(word)) kind = 'number';
    else if ((python ? pythonKeywords : cppKeywords).has(word)) kind = 'keyword';
    else if ((python ? pythonTypes : cppTypes).has(word)) kind = 'type';
    out += kind ? `<span class="tok-${kind}">${escapeHtml(word)}</span>` : escapeHtml(word);
    at = match.index + word.length;
  }
  $('codeHighlight').innerHTML = out + escapeHtml(source.slice(at)) + '\n';
}
function scheduleHighlight() { clearTimeout(highlightTimer); highlightTimer = setTimeout(highlightCode, 65); }
function breakpointStorageKey() { return `pnx-breakpoints:${state.workspace || ''}`; }
function loadBreakpoints() {
  state.breakpoints.clear(); state.breakpointResults.clear();
  try {
    const saved = JSON.parse(localStorage.getItem(breakpointStorageKey()) || '{}');
    for (const [file, lines] of Object.entries(saved)) if (Array.isArray(lines) && lines.length <= 64)
      state.breakpoints.set(file, new Set(lines.filter(line => Number.isSafeInteger(line) && line > 0)));
  } catch { /* Ignore invalid saved breakpoints. */ }
  renderBreakpointGutter();
}
function saveBreakpoints() {
  try { localStorage.setItem(breakpointStorageKey(), JSON.stringify(Object.fromEntries([...state.breakpoints].map(([file, lines]) => [file, [...lines].sort((a, b) => a - b)])))); }
  catch { /* Storage can be disabled. */ }
}
function renderExecutionLine() {
  const marker = $('executionLine'), editor = $('codeEditor');
  const active = state.debugPaused && state.stoppedAt?.path === state.file?.path;
  marker.classList.toggle('visible', !!active);
  if (!active) return;
  const rowHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
  marker.style.top = `${22 + (state.stoppedAt.line - 1) * rowHeight - editor.scrollTop}px`;
  marker.style.height = `${rowHeight}px`;
}
function renderBreakpointGutter() {
  const gutter = $('breakpointGutter'), editor = $('codeEditor');
  if (!state.file || !gutter) { gutter?.replaceChildren(); renderExecutionLine(); return; }
  const rowHeight = parseFloat(getComputedStyle(editor).lineHeight) || 21;
  const first = Math.max(1, Math.floor(editor.scrollTop / rowHeight) - 1);
  const last = Math.min(editor.value.split('\n').length, Math.ceil((editor.scrollTop + editor.clientHeight) / rowHeight) + 2);
  const lines = state.breakpoints.get(state.file.path) || new Set();
  gutter.replaceChildren(...Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
    const line = first + index, button = document.createElement('button');
    button.type = 'button'; button.className = 'breakpoint-line'; button.textContent = String(line);
    button.style.top = `${22 + (line - 1) * rowHeight - editor.scrollTop}px`;
    const owners = breakpointOwners(state.file.path, line);
    const hasBreakpoint = owners.length > 0;
    const result = state.breakpointResults.get(state.file.path)?.get(owners[0]);
    button.classList.toggle('has-breakpoint', hasBreakpoint);
    button.classList.toggle('unverified', hasBreakpoint && !state.debugAccess);
    button.classList.toggle('rejected', hasBreakpoint && state.debugAccess && result?.verified === false);
    const current = state.debugPaused && state.stoppedAt?.path === state.file.path && state.stoppedAt.line === line;
    button.classList.toggle('current-execution', current);
    button.title = `${hasBreakpoint ? `移除第 ${line} 行断点` : `设置第 ${line} 行断点`}${current ? ' · 当前执行位置（移除断点后仍保持暂停）' : ''}`;
    button.setAttribute('aria-label', button.title);
    const file = state.file.path;
    // A stop/scroll update may replace this node before mouseup. Handle the
    // pointer action now; retain click for keyboard/assistive activation only.
    button.onpointerdown = event => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.preventDefault();
      perform(() => toggleBreakpoint(file, line));
    };
    button.onclick = event => { if (!event || event.detail === 0) return perform(() => toggleBreakpoint(file, line)); };
    return button;
  }));
  renderExecutionLine();
}
async function syncBreakpoints(file) {
  if (!state.debugAccess) return;
  const lines = [...(state.breakpoints.get(file) || [])].sort((a, b) => a - b);
  const result = await api('/api/debug/breakpoints', { path: file, lines });
  state.breakpointResults.set(file, new Map(lines.map((line, index) => [line, result.breakpoints?.[index] || { verified: false, message: '调试器未返回断点状态' }])));
  if (file === state.file?.path) renderBreakpointGutter();
  const rejected = lines.filter(line => state.breakpointResults.get(file).get(line).verified === false);
  if (rejected.length) log(`${file}: ${rejected.length} 个断点未验证，请检查编译优化和 DWARF 行号`, 'debug');
}
async function syncAllBreakpoints() {
  for (const [file, lines] of state.breakpoints) if (lines.size) {
    try { await syncBreakpoints(file); } catch (error) { log(`${file}: 断点下发失败：${error.message}`, 'debug'); }
  }
}
function breakpointOwners(file, line) {
  return [...(state.breakpoints.get(file) || [])].filter(requested => requested === line || state.breakpointResults.get(file)?.get(requested)?.line === line);
}
let breakpointUpdate = Promise.resolve();
function toggleBreakpoint(file, line) {
  const update = breakpointUpdate.catch(() => {}).then(() => updateBreakpoint(file, line));
  breakpointUpdate = update; return update;
}
async function updateBreakpoint(file, line) {
  if (!/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(file)) return;
  const lines = state.breakpoints.get(file) || new Set();
  const owners = breakpointOwners(file, line);
  if (!owners.length && lines.size >= 64) throw new Error('每个文件最多设置 64 个断点');
  if (!owners.length && state.debugAccess && state.file?.path === file && fileDirty()) { await saveFileEntry(state.file); updateEditor(); }
  if (owners.length) owners.forEach(owner => lines.delete(owner)); else lines.add(line);
  state.breakpoints.set(file, lines); state.breakpointResults.delete(file); saveBreakpoints(); renderBreakpointGutter();
  if (state.debugAccess) await syncBreakpoints(file);
}
function renderTabs() {
  $('fileTabs').replaceChildren(...[...state.files.values()].map(file => {
    const tab = document.createElement('button'); tab.className = `file-tab${file === state.file ? ' active' : ''}`; tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(file === state.file));
    const title = document.createElement('span'); title.textContent = file.path.split('/').at(-1);
    const dirty = document.createElement('span'); dirty.className = 'tab-dirty'; dirty.textContent = fileDirty(file) ? '●' : '';
    const close = document.createElement('span'); close.className = 'tab-close'; close.textContent = '×'; close.setAttribute('aria-label', `关闭 ${file.path}`);
    close.onclick = event => { event.stopPropagation(); closeFile(file.path); };
    tab.onclick = () => activateFile(file.path); tab.append(title, dirty, close); return tab;
  }));
}
function activateFile(path) {
  const file = state.files.get(path); if (!file) return;
  state.file = file; $('codeEditor').value = file.value; $('codeEditor').scrollTop = file.scrollTop || 0; $('codeEditor').scrollLeft = file.scrollLeft || 0;
  for (const row of document.querySelectorAll('#fileTree .tree-row')) { const active = row.dataset.path === path; row.classList.toggle('active', active); row.setAttribute('aria-selected', String(active)); }
  updateEditor(); highlightCode(); syncHighlightScroll(); renderBreakpointGutter(); setView('editor');
}
async function closeFile(path) {
  const file = state.files.get(path); if (!file) return;
  if (fileDirty(file) && !(await confirmAction(`${path} 尚未保存。关闭此标签？`))) return;
  const paths = [...state.files.keys()], index = paths.indexOf(path); state.files.delete(path);
  if (state.file === file) { state.file = null; const next = paths[index + 1] || paths[index - 1]; if (next) activateFile(next); }
  updateEditor();
}
function syncHighlightScroll() { $('codeHighlight').scrollTop = $('codeEditor').scrollTop; $('codeHighlight').scrollLeft = $('codeEditor').scrollLeft; }
function updateEditor() {
  const file = state.file;
  const markdown = /\.(md|markdown|mdown)$/i.test(file?.path || '');
  const preview = markdown && !!file.previewMarkdown;
  $('markdownToggle').classList.toggle('hidden', !markdown);
  $('markdownToggle').textContent = preview ? '显示源码' : '预览 Markdown';
  $('markdownToggle').setAttribute('aria-pressed', String(preview));
  $('markdownPreview').classList.toggle('hidden', !preview);
  if (preview) $('markdownPreview').innerHTML = window.renderMarkdown(file.value);
  else $('markdownPreview').replaceChildren();
  $('editorSurface').classList.toggle('hidden', !file || preview);
  $('emptyEditor').classList.toggle('hidden', !!file);
  renderTabs();
  $('editorPath').textContent = file?.path || '未打开文件';
  $('editorDirty').textContent = fileDirty() ? '● 未保存' : '';
  $('saveFile').disabled = !fileDirty();
  renderBreakpointGutter();
}
async function chooseBrowserFolder() {
  const dialog = $('folderDialog');
  $('folderPath').value = state.workspace || '';
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'open' ? $('folderPath').value.trim() : null), { once: true }));
}
async function openFolder() {
  if (!(await mayCloseFile())) return;
  const folder = window.PNXDesktop?.chooseFolder ? await window.PNXDesktop.chooseFolder() : await chooseBrowserFolder();
    if (!folder) return;
    const result = await api('/api/workspace/open', { folder });
    if (result.root !== state.workspace) { resetConnectionUI(false); expandedDirectories.clear(); }
    state.workspace = result.root; state.projectRoot = result.projectRoot; state.file = null; state.files.clear(); loadBreakpoints(); definitionHistory.length = 0; $('goBack').disabled = true; updateEditor();
  await loadWatchFile(true);
  $('workspaceLabel').textContent = result.root;
  $('folderRoot').textContent = result.root;
  $('fileTree').replaceChildren(); await renderDirectory('', $('fileTree'));
  setView('editor');
  await loadProjectProfile();
  if (state.projectRoot) { await loadBoard(); log(`PnX 项目已切换至 ${result.root}`); }
  else { state.config = {}; state.hardware = {}; $('hardware').replaceChildren(); $('editor').classList.add('hidden'); fillMotor(); await loadBuildPresets(); log(`已打开文件夹 ${result.root}；构建使用此文件夹的 CMake 预设`); }
}
const expandedDirectories = new Set();
function fileIcon(name, directory) {
  const icon = document.createElement('span'); icon.className = 'explorer-file-icon'; icon.setAttribute('aria-hidden', 'true');
  const extension = name.split('.').at(-1).toLowerCase();
  const kind = directory ? 'folder' : ['c','cpp','cc','cxx'].includes(extension) ? 'cpp' : ['h','hpp','hxx'].includes(extension) ? 'header' : extension === 'json' ? 'json' : /cmake|CMakeLists/.test(name) ? 'cmake' : extension === 'md' ? 'markdown' : 'file';
  icon.dataset.kind = kind;
  icon.innerHTML = directory ? '<svg viewBox="0 0 16 16"><path d="M1.5 4h5l1.5 1.5h6.5v8h-13zM1.5 4V2.5h5L8 4"/></svg>' : '<svg viewBox="0 0 16 16"><path d="M3 1.5h6l4 4v9H3zM9 1.5v4h4"/></svg>';
  return icon;
}
async function renderDirectory(relative, container) {
  if (!relative) { $('folderRoot').textContent = (state.workspace || '').split(/[\\/]/).filter(Boolean).at(-1) || '尚未打开文件夹'; $('folderRoot').title = state.workspace || ''; }
  const result = await api(`/api/workspace/list?path=${encodeURIComponent(relative)}`);
  container.replaceChildren(...result.entries.map(entry => {
    const shell = document.createElement('div');
    const row = document.createElement('button'); row.className = `tree-row${entry.directory ? ' folder' : ''}`;
    row.dataset.path = entry.path; row.title = entry.path; row.setAttribute('role','treeitem'); row.setAttribute('aria-selected',String(state.file?.path === entry.path)); row.classList.toggle('active',state.file?.path === entry.path);
    const chevron = document.createElement('span'); chevron.className = 'tree-chevron'; chevron.textContent = entry.directory ? '›' : '';
    const label = document.createElement('span'); label.className = 'tree-label'; label.textContent = entry.name;
    row.append(chevron);
    if (!entry.directory) row.append(fileIcon(entry.name, false));
    row.append(label);
    shell.append(row);
    if (entry.directory) {
      const children = document.createElement('div'); children.className = 'tree-children hidden'; shell.append(children);
      row.setAttribute('aria-expanded','false'); children.setAttribute('role','group');
      const expand = async () => { await renderDirectory(entry.path, children); children.classList.remove('hidden'); row.setAttribute('aria-expanded','true'); expandedDirectories.add(entry.path); };
      row.onclick = () => perform(async () => {
        if (children.classList.contains('hidden')) await expand();
        else { children.classList.add('hidden'); row.setAttribute('aria-expanded','false'); expandedDirectories.delete(entry.path); }
      });
      if (expandedDirectories.has(entry.path)) perform(expand);
    } else row.onclick = () => perform(() => openFile(entry.path, row));
    return shell;
  }));
}
$('refreshExplorer').onclick = () => perform(() => state.workspace ? renderDirectory('', $('fileTree')) : Promise.resolve());
$('collapseExplorer').onclick = () => { expandedDirectories.clear(); for (const node of $('fileTree').querySelectorAll('.tree-children')) node.classList.add('hidden'); for (const row of $('fileTree').querySelectorAll('[aria-expanded]')) row.setAttribute('aria-expanded','false'); };
$('fileTree').addEventListener('keydown', event => {
  const row=event.target.closest('.tree-row'); if(!row) return;
  const rows=[...$('fileTree').querySelectorAll('.tree-row')].filter(item=>item.getClientRects().length), index=rows.indexOf(row);
  if (event.key==='ArrowDown' || event.key==='ArrowUp') { event.preventDefault(); rows[Math.max(0,Math.min(rows.length-1,index+(event.key==='ArrowDown'?1:-1)))]?.focus(); }
  if (event.key==='ArrowRight' && row.getAttribute('aria-expanded')==='false' || event.key==='ArrowLeft' && row.getAttribute('aria-expanded')==='true') {event.preventDefault();row.click();}
});
function resizeExplorer(width) { const value=Math.max(180,Math.min(560,window.innerWidth*.45,width)); $('desktopShell').style.setProperty('--explorer-width',value+'px'); try {localStorage.setItem('pnx-explorer-width',String(value));}catch{} }
try {const width=Number(localStorage.getItem('pnx-explorer-width')); if(width) resizeExplorer(width);}catch{}
$('explorerResize').onpointerdown = event => { event.preventDefault(); $('explorerResize').setPointerCapture(event.pointerId); };
$('explorerResize').onpointermove = event => { if($('explorerResize').hasPointerCapture(event.pointerId)) resizeExplorer(event.clientX-$('explorer').getBoundingClientRect().left); };
$('explorerResize').onpointerup = event => { if($('explorerResize').hasPointerCapture(event.pointerId)) $('explorerResize').releasePointerCapture(event.pointerId); };
$('explorerResize').onkeydown = event => {if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();resizeExplorer($('explorer').clientWidth+(event.key==='ArrowRight'?10:-10));}};
async function openFile(relative, row) {
  if (state.files.has(relative)) { activateFile(relative); return; }
  const result = await api(`/api/workspace/file?path=${encodeURIComponent(relative)}`);
  const text = result.text.replace(/\r\n/g, '\n');
  state.files.set(relative, { ...result, text, value: text, eol: result.text.includes('\r\n') ? '\r\n' : '\n' });
  for (const item of document.querySelectorAll('.tree-row.active')) item.classList.remove('active');
  row.classList.add('active');
  activateFile(relative);
}
async function saveFileEntry(file) {
  if (!fileDirty(file)) return;
  const value = file.value;
  const text = file.eol === '\r\n' ? value.replace(/\n/g, '\r\n') : value;
  const result = await api('/api/workspace/file', { path: file.path, text, expectedHash: file.hash });
  file.hash = result.hash; file.text = value;
  log(`已保存 ${file.path}`);
}
async function saveFile() {
  if (!state.file) return;
  await saveFileEntry(state.file);
  updateEditor();
}
async function saveDirtyFiles() {
  for (const file of state.files.values()) await saveFileEntry(file);
  updateEditor();
}
function option(value, label = value) { const item = document.createElement('option'); item.value = value; item.textContent = label; return item; }
async function loadBuildPresets() {
  const info = await api('/api/workspace/build-presets');
  const allowed = state.projectRoot ? state.boards[state.board]?.presets || [] : info.presets;
  const presets = info.presets.filter(value => allowed.includes(value));
  $('preset').replaceChildren(...presets.map(value => option(value)));
  $('preset').value = presets.includes(state.preset) ? state.preset : presets[0] || '';
  state.preset = $('preset').value;
  $('board').disabled = !state.projectRoot;
  $('configure').disabled = $('quickConfigure').disabled = !state.preset;
  $('build').disabled = $('quickBuild').disabled = !state.preset && !state.projectProfile?.build.executable;
  $('buildContext').textContent = state.projectRoot ? `当前 PnX 工程：${info.root}` : presets.length
    ? `当前 CMake 工程：${info.root}；调试目标可在“目标与插件”中设置。`
    : '当前文件夹没有可用的 CMake 预设。';
  updateDebugButtons();
}
async function loadBoard() {
  state.board = $('board').value;
  const result = await api(`/api/board?board=${encodeURIComponent(state.board)}`);
  state.hardware = result.hardware; state.config = result.config;
  await loadBuildPresets();
  $('hardware').replaceChildren(...Object.entries(result.hardware).flatMap(([kind, list]) => Array.isArray(list) ? list.map(value => { const span = document.createElement('span'); span.textContent = `${kind}: ${value}`; return span; }) : []));
  fillMotor();
  updateDebugButtons();
  if (state.view === 'config') updateConfigFrame();
}
function fillMotor() {
  const list = state.config.robot?.value?.devices?.motors?.list || [];
  const previous = $('motor').value;
  $('motor').replaceChildren(option('', '选择电机'), ...list.map((motor, index) => option(String(index), `${motor.name} · ${motor.model}`)));
  $('motor').value = list[Number(previous)] ? previous : '';
  showMotor();
}
function showMotor() {
  const list = state.config.robot?.value?.devices?.motors?.list || [];
  const motor = $('motor').value === '' ? undefined : list[Number($('motor').value)];
  $('motorBus').replaceChildren(...(state.hardware.can || []).map(value => option(value)));
  if (motor) { $('motorBus').value = motor.can_bus; $('motorModel').value = motor.model || ''; $('motorId').value = motor.can_id || ''; }
  else { $('motorModel').value = ''; $('motorId').value = ''; }
}
async function saveMotor() {
  const index = Number($('motor').value);
  const list = state.config.robot.value.devices?.motors?.list || [];
  if ($('motor').value === '' || !list[index]) throw new Error('先选择已有电机');
  const next = structuredClone(state.config.robot.value);
  const motor = next.devices.motors.list[index];
  motor.can_bus = $('motorBus').value;
  motor.model = $('motorModel').value.trim();
  motor.can_id = $('motorId').value.trim();
  if (!motor.model || !/^(0x[0-9a-f]+|\d+)$/i.test(motor.can_id)) throw new Error('型号或 CAN ID 无效');
  const result = await api('/api/config', { board: state.board, kind: 'robot', value: next, expectedHash: state.config.robot.hash });
  state.config.robot = { value: next, hash: result.hash };
  fillMotor(); log('robot.json 已保存；请重新校验配置和编译。');
}
let editing;
function editJson(kind) { editing = kind; $('editorTitle').textContent = `${kind}.json`; $('jsonText').value = JSON.stringify(state.config[kind].value, null, 2); $('editor').classList.remove('hidden'); }
async function saveJson() {
  if (!editing) return;
  const value = JSON.parse($('jsonText').value);
  const result = await api('/api/config', { board: state.board, kind: editing, value, expectedHash: state.config[editing].hash });
  state.config[editing] = { value, hash: result.hash };
  if (editing === 'robot') fillMotor();
  log(`${editing}.json 已保存；请重新校验配置和编译。`);
}
const PICKER_PAGE_SIZE = 200;
let pickerPage = 0, pickerCache = null, pickerSearchTimer;
function setVariableCatalog(variables, tree) {
  pickerCache = null; pickerPage = 0;
  state.variables = variables;
  state.variableById = new Map(variables.map(variable => [variable.id, variable]));
  state.variableTree = Array.isArray(tree) ? tree : variables.map(variable => ({ ...variable, expression: variable.name, children: [] }));
  state.variableNodes.clear(); state.variableLeafIds.clear();
  const index = node => {
    node.searchText = `${node.name || ''} ${node.expression || ''}`.toLowerCase();
    state.variableNodes.set(node.id, node);
    const ids = node.children?.length ? node.children.flatMap(index) : [node.id];
    state.variableLeafIds.set(node.id, ids);
    return ids;
  };
  state.variableTree.forEach(index);
}
function filteredVariableTree(nodes, query, inheritedMatch = false) {
  return nodes.flatMap(node => {
    const nameMatches = inheritedMatch || !query || node.searchText.includes(query);
    if (!node.children?.length) return nameMatches ? [node] : [];
    const children = filteredVariableTree(node.children, query, nameMatches);
    return children.length ? [{ ...node, children }] : [];
  });
}
function changeVariableSelection(ids, checked) {
  const selected = new Set(state.selected);
  for (const id of ids) {
    if (checked) {
      selected.add(id);
      if (!state.plotAssignments.has(id)) state.plotAssignments.set(id, 'watch-only');
    } else selected.delete(id);
  }
  state.selected = [...selected];
  displayVariables(); displaySelectedVariables(); renderPlots(); updateLive(); scheduleAutoSampling();
}
function displayVariables() {
  const query = $('search').value.trim().toLowerCase();
  const selected = new Set(state.selected);
  if (!pickerCache || pickerCache.query !== query) {
    const matching = query ? filteredVariableTree(state.variableTree, query) : state.variableTree;
    const ids = [];
    const collect = node => { if (node.children?.length) node.children.forEach(collect); else ids.push(node.id); };
    matching.forEach(collect);
    pickerCache = { query, matching, ids }; pickerPage = 0;
  }
  const { matching, ids: matchingIds } = pickerCache;
  // Page visible tree rows, retaining ancestors on every page. Never create
  // thousands of DOM controls for broad searches or large expanded arrays.
  const visible = [], parents = new Map();
  const visit = (node, parent) => {
    visible.push(node); parents.set(node.id, parent);
    if (node.children?.length && (query || state.expandedVariables.has(node.id))) node.children.forEach(child => visit(child, node));
  };
  matching.forEach(node => visit(node, null));
  const pages = Math.max(1, Math.ceil(visible.length / PICKER_PAGE_SIZE));
  pickerPage = Math.max(0, Math.min(pickerPage, pages - 1));
  const pageIds = new Set();
  for (let node of visible.slice(pickerPage * PICKER_PAGE_SIZE, (pickerPage + 1) * PICKER_PAGE_SIZE)) {
    while (node && !pageIds.has(node.id)) { pageIds.add(node.id); node = parents.get(node.id); }
  }
  $('variablePage').textContent = `${pickerPage + 1} / ${pages}`;
  $('variablePrevious').disabled = pickerPage === 0;
  $('variableNext').disabled = pickerPage + 1 >= pages;
  state.matchingVariableIds = matchingIds;
  $('selectedCount').textContent = `已选 ${state.selected.length}`;
  $('bankCount').textContent = `曲线 ${plotVariableIds().length} 路 · 分 ${Math.max(1, Math.ceil(plotVariableIds().length / state.bankSize))} 组`;
  $('refreshWatchValues').disabled = !state.connected || !state.selected.length;
  $('selectMatches').disabled = !state.connected || !query || !matchingIds.length;
  $('selectMatches').textContent = `添加筛选结果（${matchingIds.length} 匹配）`;
  const list = $('variables'), scrollTop = list.scrollTop;
  let shownLeaves = 0;
  const renderNode = (node, depth) => {
    const indent = `${8 + Math.min(depth, 8) * 14}px`;
    if (!node.children?.length) {
      shownLeaves++;
      const variable = state.variableById.get(node.id) || node;
      const label = document.createElement('label'); label.className = 'variable-leaf'; label.style.paddingLeft = indent;
      const box = document.createElement('input'); box.type = 'checkbox'; box.value = node.id;
      box.checked = selected.has(node.id); label.classList.toggle('selected', box.checked);
      box.onchange = () => changeVariableSelection([node.id], box.checked);
      const swatch = document.createElement('i'); swatch.className = 'variable-swatch'; swatch.style.background = box.checked ? colors[state.selected.indexOf(node.id) % colors.length] : '#596575';
      const name = document.createElement('span'); name.className = 'variable-name'; name.textContent = node.name || variable.name; name.title = node.expression || variable.name; label.append(box, swatch, name);
      if (box.checked) { const destination = document.createElement('select'); destination.setAttribute('aria-label', `${variable.name} 所在曲线`); destination.replaceChildren(option('watch-only', '仅查看 / 修改'), ...state.plots.map(plot => option(plot.id, plotGroupLabel(plot)))); destination.value = state.plotAssignments.get(node.id) || state.plots[0].id; destination.onclick = event => event.stopPropagation(); destination.onchange = () => { state.plotAssignments.set(node.id, destination.value); renderPlots(); savePlotLayout(); }; label.append(destination); }
      if (variable.writable && state.debugAccess && state.connected) { const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'variable-write'; edit.textContent = '✎'; edit.title = `修改 ${variable.name} (${variable.type})`; edit.setAttribute('aria-label', edit.title); edit.onclick = event => { event.preventDefault(); event.stopPropagation(); openVariableWrite(variable); }; label.append(edit); }
      return label;
    }
    const wrapper = document.createElement('div'); wrapper.className = 'variable-branch';
    const row = document.createElement('div'); row.className = 'variable-branch-row'; row.style.paddingLeft = indent;
    const expanded = !!query || state.expandedVariables.has(node.id);
    const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'variable-expander'; toggle.textContent = expanded ? '▾' : '▸'; toggle.setAttribute('aria-label', `${expanded ? '折叠' : '展开'} ${node.name}`); toggle.setAttribute('aria-expanded', String(expanded));
    const toggleBranch = () => { if (state.expandedVariables.has(node.id)) state.expandedVariables.delete(node.id); else state.expandedVariables.add(node.id); displayVariables(); };
    toggle.disabled = !!query;
    toggle.onclick = toggleBranch;
    const ids = state.variableLeafIds.get(node.id) || [];
    const selectedCount = ids.filter(id => selected.has(id)).length;
    const box = document.createElement('input'); box.type = 'checkbox'; box.checked = ids.length > 0 && selectedCount === ids.length; box.indeterminate = selectedCount > 0 && selectedCount < ids.length;
    box.setAttribute('aria-label', `选择 ${node.name} 的全部 ${ids.length} 个底层变量`);
    box.onchange = () => changeVariableSelection(ids, box.checked);
    const title = document.createElement('button'); title.type = 'button'; title.className = 'variable-branch-title'; title.textContent = node.name || node.expression; title.title = `${node.expression || node.name} · ${node.type || ''}`; title.onclick = toggle.disabled ? null : toggleBranch;
    const count = document.createElement('span'); count.className = 'variable-branch-count'; count.textContent = String(ids.length);
    row.append(toggle, box, title, count); wrapper.append(row);
    if (expanded) for (const child of node.children) if (pageIds.has(child.id)) wrapper.append(renderNode(child, depth + 1));
    return wrapper;
  };
  list.replaceChildren(...matching.filter(node => pageIds.has(node.id)).map(node => renderNode(node, 0)));
  $('variableCount').textContent = `${shownLeaves} / ${matchingIds.length} 匹配`;
  list.scrollTop = scrollTop;
}
const collapsedWatchBranches = new Set();
function displaySelectedVariables() {
  const list = $('selectedVariables'), scrollTop = list.scrollTop;
  const selected = new Set(state.selected), rendered = new Set();
  const positions = new Map(state.selected.map((id,index) => [id,index]));
  const renderLeaf = (id, label) => {
    const index = positions.get(id);
    const variable = state.variableById.get(id);
    if (!variable) return document.createTextNode('');
    rendered.add(id);
    const row = document.createElement('div'); row.className = 'selected-variable-row'; row.dataset.variableId = id;
    const top = document.createElement('div'); top.className = 'selected-variable-top';
    const swatch = document.createElement('i'); swatch.className = 'variable-swatch'; swatch.style.background = colors[index % colors.length];
    const name = document.createElement('span'); name.className = 'selected-variable-name'; name.textContent = label || variable.name; name.title = `${variable.name} · ${variable.type || ''}`;
    const value = document.createElement('strong'); value.className = 'selected-variable-value'; value.textContent = '—'; value.setAttribute('aria-label', `${variable.name} 当前值`);
    top.append(swatch, name, value);
    const actions = document.createElement('div'); actions.className = 'selected-variable-actions';
    const destination = document.createElement('select'); destination.setAttribute('aria-label', `${variable.name} 所在曲线`);
    destination.replaceChildren(option('watch-only', '仅查看 / 修改'), ...state.plots.map(plot => option(plot.id, plotGroupLabel(plot))));
    destination.value = state.plotAssignments.get(id) || state.plots[0].id;
    destination.onchange = () => { state.plotAssignments.set(id, destination.value); renderPlots(); displayVariables(); savePlotLayout(); };
    actions.append(destination);
    row.tabIndex = 0; row.title = `${variable.name}：点击展开曲线分配与读写操作`;
    const expandActions = () => { const expanded = row.classList.toggle('editing'); row.setAttribute('aria-expanded', String(expanded)); };
    row.setAttribute('aria-expanded', 'false');
    top.onclick = expandActions;
    row.onkeydown = event => { if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); expandActions(); } };
    const read = document.createElement('button'); read.textContent = '↻'; read.setAttribute('aria-label', '读取当前值'); read.title = '读取当前值，不订阅曲线';
    read.disabled = !state.connected || !!variable.unavailable; read.onclick = () => perform(() => readWatchValues([id])); actions.append(read);
    if (variable.writable && state.debugAccess && state.connected) {
      const edit = document.createElement('button'); edit.className = 'variable-write'; edit.textContent = '✎'; edit.title = `修改 ${variable.name}`;
      edit.onclick = () => openVariableWrite(variable); actions.append(edit);
    } else {
      const reason = document.createElement('span'); reason.className = 'hint'; reason.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/></svg>'; reason.setAttribute('aria-label', '只读');
      reason.title = variable.writable ? '当前为只读采样连接，请切换可写连接' : variable.writeReason || '未确认显式初始化的全局标量';
      const explanation = document.createElement('span'); explanation.className = 'variable-write-reason'; explanation.textContent = reason.title;
      actions.append(reason, explanation);
      if (variable.writable && !state.debugAccess) {
        const enable = document.createElement('button'); enable.textContent = '切换可写连接';
        enable.onclick = () => perform(() => enableVariableWrites(variable.id)); actions.append(enable);
      }
    }
    const remove = document.createElement('button'); remove.className = 'variable-remove'; remove.textContent = '×'; remove.title = `移除 ${variable.name}`;
    remove.onclick = () => changeVariableSelection([id], false);
    actions.append(remove); row.append(top, actions); return row;
  };
  const renderNode = node => {
    if (!node.children?.length) return selected.has(node.id) ? { element: renderLeaf(node.id, node.name), count: 1 } : null;
    const children = node.children.map(renderNode).filter(Boolean);
    if (!children.length) return null;
    const count = children.reduce((sum, child) => sum + child.count, 0);
    const branch = document.createElement('details'); branch.className = 'watch-branch'; branch.dataset.branchId = node.id;
    branch.open = !collapsedWatchBranches.has(node.id);
    const summary = document.createElement('summary'); summary.title = node.expression || node.name;
    const title = document.createElement('span'); title.textContent = node.name || node.expression;
    const amount = document.createElement('small'); amount.textContent = String(count); amount.title = '已添加变量数';
    summary.append(title, amount);
    const body = document.createElement('div'); body.className = 'watch-branch-children'; body.append(...children.map(child => child.element));
    branch.append(summary, body);
    branch.addEventListener('toggle', () => { if (branch.open) collapsedWatchBranches.delete(node.id); else collapsedWatchBranches.add(node.id); });
    return { element: branch, count };
  };
  const roots = state.variableTree.map(renderNode).filter(Boolean).map(item => item.element);
  for (const id of state.selected) if (!rendered.has(id)) roots.push(renderLeaf(id));
  list.replaceChildren(...roots);
  list.scrollTop = scrollTop;
  updateLive();
}
async function enableVariableWrites(id) {
  const selected = [...state.selected];
  await connect(false, false, true, false);
  changeVariableSelection(selected.filter(key => state.variableById.has(key)), true);
  const variable = state.variableById.get(id);
  if (variable?.writable && state.debugAccess) openVariableWrite(variable);
}
let variableToWrite;
function plotVariableIds() { return state.selected.filter(id => state.plotAssignments.get(id) !== 'watch-only'); }
async function readWatchValues(ids) {
  if (!state.connected) throw new Error('请先连接目标');
  ids = ids.filter(id=>!state.variableById.get(id)?.unavailable);
  const connectionCatalog = state.variableById;
  $('refreshWatchValues').disabled = true;
  try {
    for (let start = 0; start < ids.length; start += 40) {
      const result = await api('/api/debug/snapshot', { ids: ids.slice(start, start + 40) });
      if (!state.connected || state.variableById !== connectionCatalog) return;
      for (const item of result.values) state.latestById.set(item.id, item.value);
    }
    updateLive(); $('watchReadStatus').textContent = `${new Date().toLocaleTimeString()} 已读取 ${ids.length} 个变量（按需快照）`;
  } finally { $('refreshWatchValues').disabled = !state.connected || !state.selected.length; }
}
$('refreshWatchValues').onclick = () => perform(() => readWatchValues(state.selected));
function openVariableWrite(variable) {
  variableToWrite = variable;
  $('writeTarget').textContent = `${variable.name} · ${variable.type} · 0x${variable.address.toString(16).toUpperCase()}`;
  const current = state.latestById.get(variable.id);
  $('writeCurrent').textContent = current !== undefined ? `最近读取值：${current}` : '尚未读取；可先点击变量行的“读取”';
  $('writeValue').value = Number.isFinite(current) ? String(current) : '';
  $('writeError').textContent = '';
  $('writeDialog').showModal(); $('writeValue').focus(); $('writeValue').select();
}
$('writeCancel').onclick = () => $('writeDialog').close();
$('writeValue').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); $('writeSubmit').click(); } };
$('writeSubmit').onclick = async () => {
  if (!variableToWrite) return;
  $('writeSubmit').disabled = true; $('writeError').textContent = '';
  try {
    const result = await api('/api/write-variable', { id: variableToWrite.id, value: $('writeValue').value });
    state.latestById.set(variableToWrite.id, result.value); updateLive();
    log(`变量写入并读回校验：${variableToWrite.name} = ${result.value}`, 'debug');
    $('writeDialog').close();
  } catch (error) { $('writeError').textContent = error.message; }
  finally { $('writeSubmit').disabled = false; }
};
let nextPlotId = 2, drawPending = false, lastDraw = 0, liveTimer;
const PLOT_MAX_SECONDS = 120;
const PLOT_SAMPLE_BUDGET = 300000;
function timeWindowSeconds(value) { return Math.max(0.1, Math.min(PLOT_MAX_SECONDS, Number.isFinite(Number(value)) ? Number(value) : 10)); }
function plotView(id) {
  if (!state.plotViews.has(id)) state.plotViews.set(id, { seconds: timeWindowSeconds($('plotTimeWindow').value), paused: false, anchorNs: null, snapshot: null });
  return state.plotViews.get(id);
}
function savePlotLayout() { try { localStorage.setItem('pnx-plots', JSON.stringify({ groups: state.plotGroups, activeGroup: state.activePlotGroup, plots: state.plots, assignments: [...state.plotAssignments], columns: $('plotColumns').value, seconds: timeWindowSeconds($('plotTimeWindow').value), windows: [...state.plotViews].map(([id, view]) => [id, view.seconds]) })); } catch { /* Storage can be disabled. */ } }
function resetPlotViews() {
  for (const view of state.plotViews.values()) { view.paused = false; view.anchorNs = null; view.snapshot = null; }
}
function plotData(plotId) {
  const view = plotView(plotId);
  return view.snapshot || { series: state.series, firstTimestampNs: state.firstTimestampNs, lastTimestampNs: state.lastTimestampNs };
}
function availablePlotStart(card, data) {
  let start = Infinity;
  for (const id of card.plotIds) start = Math.min(start, data.series.get(id)?.[0]?.[0] ?? Infinity);
  return Number.isFinite(start) ? start : data.firstTimestampNs ?? data.lastTimestampNs;
}
function plotRange(card) {
  const view = plotView(card.dataset.plotId), data = plotData(card.dataset.plotId);
  const firstT = availablePlotStart(card, data);
  const end = view.paused ? Math.max(firstT, Math.min(data.lastTimestampNs, view.anchorNs ?? data.lastTimestampNs)) : data.lastTimestampNs;
  return { minT: Math.max(firstT, end - view.seconds * 1e9), maxT: end, firstT, latestT: data.lastTimestampNs, data };
}
function refreshPlotViewbar(card) {
  const view = plotView(card.dataset.plotId);
  const label = card.querySelector('.plot-view-label');
  if (!label) return;
  const offset = view.paused ? Math.max(0, ((state.lastTimestampNs || view.anchorNs) - view.anchorNs) / 1e9) : 0;
  label.textContent = `${Number(view.seconds.toFixed(2))} 秒 · ${view.paused ? `已暂停${offset >= 0.1 ? ` · 回看 ${offset.toFixed(1)} 秒` : ''}` : '实时'}`;
  card.querySelector('.plot-pause').textContent = view.paused ? '继续' : '暂停';
  card.querySelector('.plot-pause').title = view.paused ? '恢复实时显示' : '冻结此曲线画面；采集与 CSV 记录继续';
}
function updateAllPlotsPauseButton() {
  const paused = state.plots.length > 0 && state.plots.every(p => plotView(p.id).paused);
  $('pauseAllPlots').textContent = paused ? '全部继续' : '全部暂停';
  $('pauseAllPlots').setAttribute('aria-pressed', String(paused));
}
function toggleAllPlotsPause() {
  const resume = state.plots.every(p => plotView(p.id).paused);
  // Capture in one synchronous turn so every group shares the same endpoint.
  const timestamp = state.lastTimestampNs;
  const snapshot = resume ? null : {series:new Map([...state.series].map(([id, points]) => [id, points.slice()])),firstTimestampNs:state.firstTimestampNs,lastTimestampNs:timestamp};
  for (const plot of state.plots) {
    const view = plotView(plot.id);
    view.paused = !resume; view.snapshot = snapshot; view.anchorNs = resume ? null : timestamp;
  }
  for (const card of $('plotGrid').children) refreshPlotViewbar(card);
  updateAllPlotsPauseButton(); scheduleDraw(true);
}
$('pauseAllPlots').onclick = toggleAllPlotsPause;
function freezePlot(card) {
  const view = plotView(card.dataset.plotId);
  if (view.paused) return;
  const assigned = state.activeIds.filter(id => (state.plotAssignments.get(id) || state.plots[0].id) === card.dataset.plotId);
  view.snapshot = { series: new Map(assigned.map(id => [id, (state.series.get(id) || []).slice()])), firstTimestampNs: state.firstTimestampNs, lastTimestampNs: state.lastTimestampNs };
  view.paused = true; view.anchorNs = state.lastTimestampNs;
  updateAllPlotsPauseButton();
  refreshPlotViewbar(card);
}
function togglePlotPause(card) {
  const view = plotView(card.dataset.plotId);
  if (view.paused) { view.paused = false; view.snapshot = null; view.anchorNs = null; }
  else freezePlot(card);
  refreshPlotViewbar(card); updateAllPlotsPauseButton(); scheduleDraw(true);
}
function clampPlotAnchor(card, value) {
  const view = plotView(card.dataset.plotId), data = plotData(card.dataset.plotId);
  const earliest = availablePlotStart(card, data);
  const minimum = Math.min(data.lastTimestampNs, earliest + view.seconds * 1e9);
  return Math.max(minimum, Math.min(data.lastTimestampNs, value));
}
function zoomPlot(card, factor, cursorFraction = 1, freeze = false) {
  if (freeze) freezePlot(card);
  const view = plotView(card.dataset.plotId), previous = view.seconds;
  const next = timeWindowSeconds(previous * factor);
  if (next === previous) return;
  if (view.paused) {
    const anchor = view.anchorNs ?? plotData(card.dataset.plotId).lastTimestampNs;
    const focus = anchor - (1 - cursorFraction) * previous * 1e9;
    view.seconds = next;
    view.anchorNs = clampPlotAnchor(card, focus + (1 - cursorFraction) * next * 1e9);
  } else view.seconds = next;
  refreshPlotViewbar(card); savePlotLayout(); scheduleDraw(true);
}
function panPlot(card, deltaPixels, widthPixels, startingAnchor) {
  freezePlot(card);
  const view = plotView(card.dataset.plotId);
  view.anchorNs = clampPlotAnchor(card, startingAnchor - deltaPixels / Math.max(1, widthPixels) * view.seconds * 1e9);
  refreshPlotViewbar(card); updateAllPlotsPauseButton(); scheduleDraw(true);
}
function reorderPlot(sourceId, targetId) {
  const from = state.plots.findIndex(plot => plot.id === sourceId), to = state.plots.findIndex(plot => plot.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  state.plots.splice(to, 0, ...state.plots.splice(from, 1));
  renderPlots(); savePlotLayout();
}
function openOscilloscopeSettings(plot) {
  const dialog = document.createElement('dialog'); dialog.className = 'scope-properties';
  const title = document.createElement('h3'); title.textContent = `Oscilloscope · ${plot.name}`;
  const hint = document.createElement('p'); hint.textContent = '选择此图显示的变量。未分配的变量仍自动更新数值。';
  const rows = document.createElement('div'); rows.className = 'scope-property-variables';
  const choices = state.selected.map(id => {
    const label = document.createElement('label'), input = document.createElement('input'); input.type = 'checkbox'; input.checked = state.plotAssignments.get(id) === plot.id;
    label.append(input, document.createTextNode(state.variableById.get(id)?.name || id)); rows.append(label); return {id,input};
  });
  const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.onclick = () => dialog.close();
  const save = document.createElement('button'); save.textContent = '应用'; save.onclick = () => {
    for (const {id,input} of choices) if (state.selected.includes(id)) {
      if (input.checked) state.plotAssignments.set(id, plot.id);
      else if (state.plotAssignments.get(id) === plot.id) state.plotAssignments.set(id, 'watch-only');
    }
    renderPlots(); displaySelectedVariables(); displayVariables(); savePlotLayout(); dialog.close();
  };
  dialog.append(title,hint,rows,cancel,save); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal();
}
function plotGroupLabel(plot) { return `${state.plotGroups.find(group => group.id === (plot.groupId || 'default'))?.name || '默认组'} / ${plot.name}`; }
function renderPlotGroups() {
  $('plotGroups').replaceChildren(...state.plotGroups.map(group => {
    const button = document.createElement('button'); button.textContent = group.name;
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(group.id === state.activePlotGroup));
    button.onclick = () => { state.activePlotGroup = group.id; renderPlots(); savePlotLayout(); };
    return button;
  }));
  $('removePlotGroup').disabled = state.plotGroups.length < 2;
}
function renderPlots() {
  updateAllPlotsPauseButton();
  renderPlotGroups();
  const visiblePlots = state.plots.filter(plot => (plot.groupId || 'default') === state.activePlotGroup);
  const grid = $('plotGrid'); grid.style.setProperty('--plot-columns', $('plotColumns').value); grid.dataset.count = String(visiblePlots.length);
  grid.replaceChildren(...visiblePlots.map(plot => {
    const card = document.createElement('section'); card.className = 'plot-card'; card.dataset.plotId = plot.id;
    const header = document.createElement('div'); header.className = 'plot-header';
    const title = document.createElement('strong'); title.textContent = `⠿  ${plot.name}`;
    const count = document.createElement('span'); count.className = 'plot-count';
    const ids = state.activeIds.filter(id => (state.plotAssignments.get(id) || state.plots[0].id) === plot.id);
    const pages = Math.max(1, Math.ceil(ids.length / PLOT_PAGE_SIZE));
    const page = Math.min(state.plotPages.get(plot.id) || 0, pages - 1);
    state.plotPages.set(plot.id, page);
    card.plotIds = ids.slice(page * PLOT_PAGE_SIZE, (page + 1) * PLOT_PAGE_SIZE);
    const currentView = plotView(plot.id);
    if (currentView.paused && currentView.anchorNs != null) currentView.anchorNs = clampPlotAnchor(card, currentView.anchorNs);
    count.textContent = pages > 1 ? `${ids.length} 路 · ${page + 1}/${pages} 页` : `${ids.length} 路`;
    header.append(title, count);
    if (pages > 1) for (const [symbol, delta] of [['‹', -1], ['›', 1]]) {
      const button = document.createElement('button'); button.textContent = symbol;
      button.title = delta < 0 ? '上一页变量' : '下一页变量'; button.disabled = page + delta < 0 || page + delta >= pages;
      button.onclick = () => { state.plotPages.set(plot.id, page + delta); renderPlots(); };
      header.append(button);
    }
    const settings = document.createElement('button'); settings.textContent = '⚙'; settings.title = 'Oscilloscope · 曲线设置'; settings.setAttribute('aria-label', '曲线设置'); settings.onclick = () => openOscilloscopeSettings(plot); header.append(settings);
    if (state.plots.length > 1) for (const [symbol, direction] of [['←',-1],['→',1]]) { const move = document.createElement('button'); move.textContent = symbol; move.title = direction < 0 ? '向前移动曲线' : '向后移动曲线'; const position = state.plots.indexOf(plot); move.disabled = position + direction < 0 || position + direction >= state.plots.length; move.onclick = () => reorderPlot(plot.id, state.plots[position + direction].id); header.append(move); }
    if (state.plots.length > 1) { const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '移除曲线'; remove.onclick = () => { state.plots = state.plots.filter(item => item.id !== plot.id); state.plotPages.delete(plot.id); state.plotViews.delete(plot.id); for (const [id, assigned] of state.plotAssignments) if (assigned === plot.id) state.plotAssignments.set(id, state.plots[0].id); renderPlots(); displayVariables(); displaySelectedVariables(); savePlotLayout(); }; header.append(remove); }
    let drag = null;
    const hoveredCard = event => document.elementFromPoint(event.clientX, event.clientY)?.closest('.plot-card');
    const clearDrag = () => { card.classList.remove('dragging'); for (const item of grid.children) item.classList.remove('drag-over'); drag = null; };
    header.onpointerdown = event => {
      if (event.button !== 0 || event.target.closest('button') || state.plots.length < 2) return;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      header.setPointerCapture(event.pointerId);
    };
    header.onpointermove = event => {
      if (!drag || event.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5) return;
      drag.moved = true; card.classList.add('dragging');
      const target = hoveredCard(event);
      for (const item of grid.children) item.classList.toggle('drag-over', item === target && item !== card);
    };
    header.onpointerup = event => {
      if (!drag || event.pointerId !== drag.id) return;
      const targetId = drag.moved ? hoveredCard(event)?.dataset.plotId : null;
      header.releasePointerCapture(event.pointerId); clearDrag();
      if (targetId) reorderPlot(plot.id, targetId);
    };
    header.onpointercancel = clearDrag;
    const viewbar = document.createElement('div'); viewbar.className = 'plot-viewbar';
    const viewLabel = document.createElement('span'); viewLabel.className = 'plot-view-label'; viewbar.append(viewLabel);
    const action = (text, title, className, run) => { const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = text; button.title = title; button.setAttribute('aria-label', title); button.onclick = run; viewbar.append(button); return button; };
    action('−', '缩小时间轴', 'plot-zoom-out', () => zoomPlot(card, 1.5));
    action('＋', '放大时间轴', 'plot-zoom-in', () => zoomPlot(card, 1 / 1.5));
    action('暂停', '冻结此曲线画面；采集与 CSV 记录继续', 'plot-pause', () => togglePlotPause(card));
    action('全屏', '将此曲线全屏显示', 'plot-fullscreen', () => perform(async () => { if (document.fullscreenElement === card) await document.exitFullscreen(); else await card.requestFullscreen(); }));
    action('PNG', '导出当前曲线视图为 PNG', 'plot-export', () => perform(() => exportPlot(card)));
    const body = document.createElement('div'); body.className = 'plot-body'; const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', `${plot.name} 实时曲线`); body.append(canvas);
    let plotDrag = null;
    canvas.onpointerdown = event => { if (event.button !== 0 || !state.lastTimestampNs) return; plotDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, anchor: plotView(plot.id).anchorNs ?? plotData(plot.id).lastTimestampNs, moved: false }; canvas.setPointerCapture(event.pointerId); };
    canvas.onpointermove = event => {
      if (!plotDrag || plotDrag.id !== event.pointerId) return;
      if (!plotDrag.moved && Math.hypot(event.clientX - plotDrag.x, event.clientY - plotDrag.y) < 4) return;
      plotDrag.moved = true; canvas.classList.add('panning');
      panPlot(card, event.clientX - plotDrag.x, canvas.getBoundingClientRect().width - 76, plotDrag.anchor);
    };
    canvas.onpointerup = event => { if (plotDrag?.id === event.pointerId) { canvas.releasePointerCapture(event.pointerId); plotDrag = null; canvas.classList.remove('panning'); } };
    canvas.onpointercancel = () => { plotDrag = null; canvas.classList.remove('panning'); };
    canvas.addEventListener('wheel', event => {
      if (!state.lastTimestampNs) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - 60) / Math.max(1, rect.width - 76)));
      zoomPlot(card, event.deltaY < 0 ? 1 / 1.25 : 1.25, fraction, true);
    }, { passive: false });
    const legend = document.createElement('div'); legend.className = 'plot-legend'; legend.replaceChildren(...card.plotIds.slice(0, 24).map(id => { const item = document.createElement('span'); item.title = state.variableById.get(id)?.name || id; const color = document.createElement('i'); color.style.background = colors[(state.activeIndex.get(id) || 0) % colors.length]; item.append(color, document.createTextNode(item.title)); return item; }));
    if (card.plotIds.length > 24) legend.append(document.createTextNode(`… 本页另有 ${card.plotIds.length - 24} 路`));
    card.append(header, viewbar, body, legend); refreshPlotViewbar(card); return card;
  })); scheduleDraw(true);
}
function scheduleDraw(force = false) {
  if (drawPending || state.view !== 'scope' || document.hidden) return;
  const delay = force ? 0 : Math.max(0, 33 - (performance.now() - lastDraw)); drawPending = true;
  setTimeout(() => requestAnimationFrame(() => { drawPending = false; lastDraw = performance.now(); drawPlots(); }), delay);
}
function updateConnection() {
  $('connectionBadge').textContent = state.connected ? '已连接' : '未连接';
  $('connectionBadge').classList.toggle('on', state.connected);
  $('scopeDisconnect').disabled = !state.connected;
}
function updateLive() {
  for (const row of $('selectedVariables').querySelectorAll('.selected-variable-row')) {
    const id = row.dataset.variableId;
    if (!id) continue;
    const latest = state.latestById.get(id);
    const value = Number.isFinite(latest) ? latest.toPrecision(7) : latest !== undefined ? String(latest) : '—';
    const target = row.querySelector('.selected-variable-value');
    if (target.textContent !== value) target.textContent = value;
    const sampleAt = state.latestAtById.get(id);
    const age = state.banks > 1 && sampleAt && state.lastTimestampNs >= sampleAt ? ` · ${((state.lastTimestampNs - sampleAt) / 1e9).toFixed(1)}s 前` : '';
    target.title = `${state.variableById.get(id)?.name || id}${age}`;
  }
}
function updateRecordUi() {
  $('recordStart').disabled = !state.connected || !state.activeIds.length || state.recording;
  $('recordStop').disabled = !state.recording;
  $('exportCsv').disabled = !state.recordFile || state.recording;
  $('recordStatus').textContent = state.recording ? '正在记录完整采样…'
    : state.recordError ? `记录中断：${state.recordError} · ${state.recordFile || ''}`
      : state.recordFile ? `${state.recordRows} 行 · ${state.recordFile}` : '尚未记录';
  $('recordStatus').title = state.recordFile || '';
}
function applyRecordStatus(result) {
  state.recording = result.active === true;
  state.recordFile = result.file || null;
  state.recordRows = result.rows || 0;
  state.recordError = result.error || null;
  updateRecordUi();
}
function updateScopeNotice() {
  const notice = $('scopeNotice');
  const now = performance.now();
  const allObserved = state.activeIds.length && state.activeIds.every(id =>
    state.valueSeenAt.has(id) && now - state.valueSeenAt.get(id) < 2500 && now - state.valueChangedAt.get(id) >= 2500);
  if (!allObserved) { notice.classList.add('hidden'); notice.textContent = ''; return; }
  const dwtCache = state.activeIds.some(id => /^state\.sys_time\.(s|ms|us)$/.test(state.variableById.get(id)?.name || ''));
  notice.textContent = dwtCache
    ? '探针持续读取，但所选值已超过 2.5 秒不变。state.sys_time 只在固件调用 bsp::dwt::update()/now() 时刷新；可改选 uwTick 或 _tx_timer_system_clock 检查目标是否在运行。'
    : '探针持续读取，但所选值已超过 2.5 秒不变。读取速率表示取样次数，不表示固件变量在变化；请确认目标正在运行且变量会被更新。';
  notice.classList.remove('hidden');
}
function debugSourcePath(source) {
  const root = String(state.workspace || '').replaceAll('\\', '/').replace(/\/$/, '');
  const full = String(source || '').replaceAll('\\', '/');
  if (!root || !full.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return null;
  return full.slice(root.length + 1);
}
function renderDebugPanel() {
  $('debugPanel').classList.toggle('hidden', !state.connected);
  $('diagnosticSnapshot').disabled = !state.connected;
  const stopped = state.debugPaused;
  $('debugStopIcon').textContent = stopped ? '▶' : '●';
  $('debugStopIcon').classList.toggle('stopped', stopped);
  $('debugStopTitle').textContent = stopped ? `已暂停 · ${state.debugReason || '断点'}`
    : state.debugAccess ? '目标正在运行' : '只读采样连接';
  const stop = state.stoppedAt;
  $('debugLocation').textContent = stopped ? stop?.path && stop?.line ? `${stop.path}:${stop.line} · ${stop.pc || 'PC 未知'}`
    : stop?.pc || '正在读取停住位置…' : '可读取全局诊断状态';
  $('jumpToStop').disabled = !stopped || !stop?.path || !stop?.line;
  renderBreakpointGutter();
}
async function handleDebugEvent(data) {
  if (!state.debugAccess || state.flashAccess || flashInProgress) return;
  const revision = ++stopRevision;
  if (data.event !== 'stopped') {
    state.debugPaused = false; state.debugReason = ''; state.stoppedAt = null;
    updateDebugButtons(); renderDebugPanel(); return;
  }
  state.debugPaused = true; state.debugReason = data.reason || '断点'; state.stoppedAt = null;
  updateDebugButtons(); renderDebugPanel();
  try {
    const result = await api('/api/debug/snapshot', { ids: [], includeStack: true });
    if (revision !== stopRevision || !state.debugPaused) return;
    const frame = result.frame;
    const relative = debugSourcePath(frame?.source?.path);
    state.stoppedAt = { path: relative, line: Number.isInteger(frame?.line) ? frame.line : null,
      pc: frame?.instructionPointerReference || 'PC 未知' };
    renderDebugPanel();
    if (relative && state.stoppedAt.line) {
      try { await navigateTo({ path: relative, line: state.stoppedAt.line }, false); }
      catch (error) { log(`无法打开停住位置：${error.message}`, 'debug'); }
    }
    log(`目标暂停：${state.debugReason} · ${$('debugLocation').textContent}`, 'debug');
  } catch (error) {
    if (revision === stopRevision) { $('debugLocation').textContent = `位置读取失败：${error.message}`; log(`位置读取失败：${error.message}`, 'debug'); }
  }
}
function updateDebugButtons() {
  $('saveWatchConfig').disabled = $('loadWatchConfig').disabled = !state.workspace;
  $('debugState').textContent = state.debugAccess ? (state.debugPaused ? `已暂停：${state.debugReason || '断点'}` : '调试器已连接') : '未连接调试器';
  $('quickPause').disabled = !state.debugAccess || state.debugPaused;
  $('quickContinue').disabled = !state.debugAccess || !state.debugPaused;
  $('quickStep').disabled = !state.debugAccess || !state.debugPaused;
  $('quickStop').disabled = !state.debugAccess;
  const hasTarget = !flashInProgress && (!!state.projectRoot || !!(state.workspace && state.projectProfile?.target.chip && state.projectProfile?.target.elf));
  $('quickDebug').disabled = $('quickFlash').disabled = $('flash').disabled = !hasTarget;
  $('quickDebug').title = buildBeforeConnect() ? '保存、编译并连接调试器' : '使用配置的 ELF 连接调试器';
  $('quickFlash').title = buildBeforeConnect() ? '确认后编译并烧录' : '确认后烧录配置的 ELF';
  $('attach').disabled = $('connectFlash').disabled = $('scopeAttach').disabled = $('scopeWriteConnect').disabled = !hasTarget;
  for (const element of document.querySelectorAll('.debug-diagnostic-row,#diagnosticFindings,#diagnosticValues')) element.classList.toggle('hidden', !state.projectRoot);
  const target = state.projectProfile?.target;
  $('scopeTargetSummary').textContent = target?.chip && target?.elf
    ? `${target.chip} · ${target.elf}`
    : state.projectRoot ? '使用 PnX 板卡预设的 ELF 采集；添加变量后，在曲线设置中选择显示变量。'
    : '普通工程同样支持曲线：打开文件夹 → 目标设置填写芯片和 ELF → 连接目标板 → 添加变量并分配曲线。';
  $('serialTest').disabled = false;
}
function captureWatchConfig() {
  return {format:'pnx-watch',version:1,
    variables:state.selected.map(id => ({expression:state.variableById.get(id)?.name,plotId:state.plotAssignments.get(id) || 'watch-only'})).filter(v=>v.expression),
    groups:state.plotGroups.map(g=>({...g})), plots:state.plots.map(p=>({...p,groupId:p.groupId || 'default',seconds:plotView(p.id).seconds})),
    activeGroup:state.activePlotGroup,columns:Number($('plotColumns').value),seconds:timeWindowSeconds($('plotTimeWindow').value),rate:Number($('scopeRate').value) || 1000};
}
function restoreWatchConfig(config) {
  state.plotGroups=config.groups.map(g=>({...g})); state.plots=config.plots.map(p=>({...p})); state.activePlotGroup=config.activeGroup;
  $('plotColumns').value=String(config.columns); $('plotTimeWindow').value=String(config.seconds); $('scopeRate').value=$('rate').value=String(config.rate);
  state.plotViews.clear(); for(const p of config.plots) plotView(p.id).seconds=p.seconds;
  nextPlotId=Math.max(2,...state.plots.map(p=>Number(p.id.replace('plot-',''))+1 || 2));
  const byName=new Map();
  for(const variable of state.variables.filter(v=>!v.unavailable)) {
    if(byName.has(variable.name)) byName.set(variable.name,null); else byName.set(variable.name,variable);
  }
  state.selected=[]; state.plotAssignments.clear();
  for(const entry of config.variables) {
    let variable=byName.get(entry.expression);
    if(!variable) {
      variable={id:'saved:'+entry.expression,name:entry.expression,unavailable:true,writable:false,writeReason:'当前 ELF 未找到唯一同名变量，保留配置等待重新连接'};
      state.variableById.set(variable.id,variable);
    }
    state.selected.push(variable.id); state.plotAssignments.set(variable.id,entry.plotId);
  }
  displayVariables(); displaySelectedVariables(); renderPlots(); updateLive();
}
async function loadWatchFile(quiet=false) {
  if(!state.workspace) return;
  try {
    const {config}=await api('/api/watch-config');
    if(config) { restoreWatchConfig(config); if(state.connected) scheduleAutoSampling(); log('已加载 pnx-watch.json'); }
    else if(!quiet) log('当前工程尚未保存 pnx-watch.json');
  } catch(error) { log(`查看配置加载失败：${error.message}`); }
}
$('saveWatchConfig').onclick=()=>perform(async()=>{
  const result=await api('/api/watch-config',captureWatchConfig()); log(`查看配置已保存：${result.path}`);
  await renderDirectory('', $('fileTree'));
});
$('loadWatchConfig').onclick=()=>perform(()=>loadWatchFile());
async function connect(mock, allowFlash, allowDebug = false, switchView = true) {
  const previousWatch = captureWatchConfig();
  const rate = Number(state.view === 'scope' ? $('scopeRate').value : $('rate').value) || 1000;
  $('rate').value = String(rate); $('scopeRate').value = String(rate);
  let result;
  try { result = await api('/api/connect', { mock, allowFlash, allowDebug, preset: state.preset, probe: $('probe').value.trim(), speedKHz: Number($('speed').value), rate }); }
  catch (error) { resetConnectionUI(); throw error; }
  if (result.probe && result.probe !== $('probe').value.trim()) {
    $('probe').value = result.probe;
    $('probeList').value = result.probe;
    log(`探针已切换：${result.probe}`);
  }
  clearTimeout(liveTimer); liveTimer = null;
  setVariableCatalog(result.variables, result.tree); state.connected = true; state.flashAccess = allowFlash && !mock; state.debugAccess = allowDebug && !mock; state.debugPaused = false; state.debugReason = ''; state.stoppedAt = null; stopRevision++; state.selected = []; state.activeIds = []; state.activeIndex.clear(); state.points = []; state.latest = []; state.series.clear(); resetPlotViews(); state.latestById.clear(); state.latestAtById.clear(); state.firstTimestampNs = null; state.lastTimestampNs = 0; state.banks = 1; state.bankSize = BANK_CHANNELS; state.bankDwellMs = 0; state.streamEpoch = null; state.sampleCount = 0; state.droppedFrames = 0; state.rateWindow = []; state.observedValues.clear(); state.valueChangedAt.clear(); state.valueSeenAt.clear(); updateScopeNotice();
  $('openVariablePicker').disabled = false; $('subscribe').disabled = false; $('disconnect').disabled = false;
  displayVariables(); displaySelectedVariables(); updateConnection(); updateDebugButtons(); renderDebugPanel(); updateRecordUi(); renderPlots(); if (switchView) setView('scope'); log(`已连接：${mock ? '模拟目标' : result.chip || result.board}，变量 ${result.variables.length} 个`, allowDebug ? 'debug' : allowFlash ? 'flash' : 'general');
  restoreWatchConfig(previousWatch);
  if(state.selected.length && !allowFlash) scheduleAutoSampling();
  if (state.debugAccess && !allowFlash) await syncAllBreakpoints();
}
function receiveSamples(batch) {
  if (!state.connected) return;
  state.lastSampleAt = performance.now();
  if (state.banks === 1 && state.streamEpoch !== batch.streamEpoch) {
    state.streamEpoch = batch.streamEpoch; state.series.clear(); state.points = []; state.firstTimestampNs = null; state.lastTimestampNs = 0; state.sampleCount = 0; state.rateWindow = [];
  }
  batch.ids.forEach((id, index) => {
    const value = batch.latest[index];
    if (!Number.isFinite(value)) return;
    if (!state.observedValues.has(id) || !Object.is(state.observedValues.get(id), value)) state.valueChangedAt.set(id, state.lastSampleAt);
    state.observedValues.set(id, value);
    state.valueSeenAt.set(id, state.lastSampleAt);
  });
  if (batch.points.length) {
    state.firstTimestampNs ??= batch.points[0][0];
    state.lastTimestampNs = Math.max(state.lastTimestampNs, batch.points.at(-1)[0]);
  }
  if (state.banks === 1) {
    state.activeIds = batch.ids;
    state.activeIndex = new Map(batch.ids.map((id, index) => [id, index]));
    state.latest = batch.latest;
  }
  const limit = Math.max(8, Math.min(120000, Math.floor(PLOT_SAMPLE_BUDGET / Math.max(1, state.activeIds.length))));
  batch.ids.forEach((id, index) => {
    if (!state.variableById.has(id)) return;
    let series = state.series.get(id);
    if (!series) { series = []; state.series.set(id, series); }
    for (const point of batch.points) {
      const value = point[index + 1];
      if (Number.isFinite(value)) { series.push([point[0], value]); state.latestAtById.set(id, point[0]); }
    }
    if (series.length > limit) series.splice(0, series.length - limit);
    state.latestById.set(id, batch.latest[index]);
  });
  state.sampleCount += batch.sampleCount; state.droppedFrames = batch.droppedFrames;
  const now = performance.now(); state.rateWindow.push([now, batch.sampleCount]); while (state.rateWindow.length > 1 && now - state.rateWindow[0][0] > 3000) state.rateWindow.shift();
  if (!liveTimer) liveTimer = setTimeout(() => { liveTimer = null; const elapsed = (state.rateWindow.at(-1)?.[0] - state.rateWindow[0]?.[0]) / 1000; const hz = elapsed >= 0.5 ? (state.rateWindow.reduce((sum, entry) => sum + entry[1], 0) / elapsed).toFixed(1) : '计算中'; const groups = state.banks > 1 ? ` · ${state.banks} 组轮换（每组约 ${state.bankDwellMs} ms）` : ''; $('metrics').textContent = `总体读取 ${hz} S/s · 已收 ${state.sampleCount} 样本 · 丢帧 ${state.droppedFrames}${groups} · 绘制最高 30 FPS`; updateLive(); updateScopeNotice(); for (const card of $('plotGrid').children) if (plotView(card.dataset.plotId).paused) refreshPlotViewbar(card); }, 100);
  scheduleDraw();
}
function plotAxis(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = -0.05; max = 0.05; }
  if (min === max) { const half = Math.max(0.005, Math.abs(min) * 0.01); min -= half; max += half; }
  const raw = (max - min) / 9;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find(value => value * power >= raw) * power;
  let lower = Math.floor((min - (10 * step - (max - min)) / 2) / step) * step;
  if (lower + 10 * step < max) lower += step;
  return { min: lower, max: lower + 10 * step, step, ticks: 10 };
}
function plotTickLabel(value, step) {
  const clean = Math.abs(value) < step / 100 ? 0 : value;
  let digits = 0;
  while (digits < 8 && Math.abs(step * 10 ** digits - Math.round(step * 10 ** digits)) > 1e-8) digits++;
  digits = Math.max(2, digits);
  return clean === 0 || (Math.abs(clean) >= 1e-5 && Math.abs(clean) < 10000) ? clean.toFixed(digits) : clean.toExponential(2);
}
function plotFrame(width, height, ratio) {
  const left = 60 * ratio, right = 16 * ratio, top = 16 * ratio, bottom = 30 * ratio;
  return { left, right, top, bottom, width: width - left - right, height: height - top - bottom };
}
function drawPlotGrid(ctx, frame, ratio, axis, range) {
  ctx.lineWidth = ratio;
  ctx.font = `${10 * ratio}px Consolas, monospace`;
  ctx.fillStyle = themeColor('#9aa7b8', '#526071');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= axis.ticks; i++) {
    const value = axis.min + i * axis.step;
    const y = frame.top + (axis.ticks - i) / axis.ticks * frame.height;
    ctx.strokeStyle = Math.abs(value) < axis.step / 10 ? themeColor('#485360','#8c98a6') : themeColor('#2c323a','#dce2e8');
    ctx.beginPath(); ctx.moveTo(frame.left, y); ctx.lineTo(frame.left + frame.width, y); ctx.stroke();
    if (frame.height / axis.ticks >= 14 * ratio || i % 2 === 0) ctx.fillText(plotTickLabel(value, axis.step), frame.left - 6 * ratio, y);
  }
  ctx.strokeStyle = themeColor('#2c323a', '#dce2e8');
  for (let i = 0; i <= 6; i++) {
    const x = frame.left + i * frame.width / 6; ctx.beginPath(); ctx.moveTo(x, frame.top); ctx.lineTo(x, frame.top + frame.height); ctx.stroke();
    if (Number.isFinite(range?.firstT) && Number.isFinite(range.maxT)) {
      const seconds = (range.minT + (range.maxT - range.minT) * i / 6 - range.firstT) / 1e9;
      ctx.fillStyle = themeColor('#9aa7b8', '#526071'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(`${seconds.toFixed(Math.abs(seconds) < 10 ? 1 : 0)}s`, x, frame.top + frame.height + 5 * ratio);
    }
  }
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}
function drawPlots() {
  if (state.view !== 'scope' || document.hidden) return;
  const ratio = Math.min(devicePixelRatio || 1, 2), gridRect = $('plotGrid').getBoundingClientRect();
  for (const card of $('plotGrid').children) {
    const cardRect = card.getBoundingClientRect(); if (document.fullscreenElement !== card && (cardRect.bottom < gridRect.top || cardRect.top > gridRect.bottom)) continue;
    const canvas = card.querySelector('canvas'), rect = canvas.getBoundingClientRect(); if (!rect.width || !rect.height) continue;
    const width = Math.round(rect.width * ratio), height = Math.round(rect.height * ratio);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, width, height);
    const frame = plotFrame(width, height, ratio);
    drawSeriesPlot(ctx, card, width, height, frame, ratio);
  }
}
function lowerBoundSeries(series, timestamp) { let lo = 0, hi = series.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (series[mid][0] < timestamp) lo = mid + 1; else hi = mid; } return lo; }
function upperBoundSeries(series, timestamp) { let lo = 0, hi = series.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (series[mid][0] <= timestamp) lo = mid + 1; else hi = mid; } return lo; }
function drawSeriesPlot(ctx, card, width, height, frame, ratio) {
  const ids = card.plotIds || [];
  const range = plotRange(card);
  const histories = ids.map(id => [id, range.data.series.get(id) || []]).filter(([, series]) => series.length);
  if (!histories.length) {
    drawPlotGrid(ctx, frame, ratio, plotAxis(NaN, NaN), range);
    ctx.fillStyle = themeColor('#8491a2', '#657080'); ctx.font = `${12 * ratio}px Consolas, monospace`; ctx.textAlign = 'center';
    ctx.fillText(ids.length ? '等待实时数据' : '从左侧选择变量并分配到此曲线', width / 2, height / 2); ctx.textAlign = 'start'; return;
  }
  const { minT, maxT } = range;
  let min = Infinity, max = -Infinity;
  for (const [, series] of histories) {
    const from = lowerBoundSeries(series, minT), to = upperBoundSeries(series, maxT);
    for (let position = from; position < to; position++) {
      const value = series[position][1];
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min)) {
    drawPlotGrid(ctx, frame, ratio, plotAxis(NaN, NaN), range);
    ctx.fillStyle = themeColor('#8491a2', '#657080'); ctx.font = `${12 * ratio}px Consolas, monospace`; ctx.textAlign = 'center';
    ctx.fillText('当前时间窗口内无该页样本', width / 2, height / 2); ctx.textAlign = 'start'; return;
  }
  const axis = plotAxis(min, max); min = axis.min; max = axis.max;
  drawPlotGrid(ctx, frame, ratio, axis, range);
  const gap = state.banks > 1 ? Math.max(150e6, state.bankDwellMs * 0.8e6) : Infinity;
  ctx.save(); ctx.beginPath(); ctx.rect(frame.left, frame.top, frame.width, frame.height); ctx.clip();
  for (const [id, series] of histories) {
    ctx.strokeStyle = colors[(state.activeIndex.get(id) || 0) % colors.length]; ctx.lineWidth = 1.4 * ratio;
    ctx.beginPath(); let previous = null, count = 0;
    const from = lowerBoundSeries(series, minT), to = upperBoundSeries(series, maxT);
    const step = Math.max(1, Math.floor((to - from) / Math.max(1, frame.width / ratio * 1.5)));
    for (let position = from; position < to; position += step) {
      const [timestamp, value] = series[position];
      const x = frame.left + (timestamp - minT) / (maxT - minT || 1) * frame.width;
      const y = frame.top + (max - value) / (max - min) * frame.height;
      if (previous === null || timestamp - previous > gap) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      previous = timestamp; count++;
    }
    if (to > from && (to - 1 - from) % step !== 0) {
      const [timestamp, value] = series[to - 1];
      const x = frame.left + (timestamp - minT) / (maxT - minT || 1) * frame.width;
      const y = frame.top + (max - value) / (max - min) * frame.height;
      if (previous === null || timestamp - previous > gap) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      previous = timestamp; count++;
    }
    if (count === 1 && previous !== null) {
      const [timestamp, value] = series[Math.min(series.length - 1, to - 1)];
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(frame.left + (timestamp - minT) / (maxT - minT || 1) * frame.width - ratio, frame.top + (max - value) / (max - min) * frame.height - ratio, 2 * ratio, 2 * ratio);
    }
    ctx.stroke();
  }
  ctx.restore();
}
async function exportPlot(card) {
  const plot = state.plots.find(item => item.id === card.dataset.plotId);
  if (!plot) throw new Error('Curve no longer exists');
  const output = document.createElement('canvas'); output.width = 1600; output.height = 900;
  const ctx = output.getContext('2d'); ctx.fillStyle = themeColor('#17181d', '#ffffff'); ctx.fillRect(0, 0, output.width, output.height);
  ctx.fillStyle = themeColor('#e8e8eb', '#20252d'); ctx.font = 'bold 30px "Segoe UI", sans-serif'; ctx.fillText(plot.name, 42, 52);
  ctx.fillStyle = themeColor('#9ca5b4', '#586575'); ctx.font = '18px "Segoe UI", sans-serif'; ctx.fillText(card.querySelector('.plot-view-label').textContent, 42, 82);
  ctx.save(); ctx.translate(0, 92); drawSeriesPlot(ctx, card, 1600, 680, plotFrame(1600, 680, 2), 2); ctx.restore();
  ctx.font = '17px Consolas, monospace'; let x = 42, y = 804;
  for (const id of card.plotIds) {
    const name = state.variableById.get(id)?.name || id;
    const width = Math.min(350, ctx.measureText(name).width + 33);
    if (x + width > 1550) { x = 42; y += 30; }
    if (y > 875) break;
    ctx.fillStyle = colors[(state.activeIndex.get(id) || 0) % colors.length]; ctx.fillRect(x, y - 12, 11, 11);
    ctx.fillStyle = themeColor('#c5cad5', '#394655'); ctx.fillText(name, x + 19, y); x += width + 18;
  }
  const blob = await new Promise(resolve => output.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG export failed');
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = `${plot.name.replace(/[\\/:*?"<>|]/g, '_')}-${new Date().toISOString().replaceAll(':', '-')}.png`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { bytes: blob.size, type: blob.type };
}
async function init() {
  try { const savedView = localStorage.getItem('pnx-active-view'); setView(savedView === 'tools' ? 'config' : savedView || 'editor'); } catch { setView('editor'); }
  try { const width = Number(localStorage.getItem('pnx-scope-sidebar-width')); if (Number.isFinite(width) && width > 0) setScopeSidebarWidth(width); } catch { /* Storage can be disabled. */ }
  try { const layout = JSON.parse(localStorage.getItem('pnx-plots') || 'null'); if (Array.isArray(layout?.plots) && layout.plots.length && layout.plots.length <= 32) { const plots = layout.plots.filter(plot => typeof plot.id === 'string' && typeof plot.name === 'string'); if (plots.length) { state.plots = plots; if (Array.isArray(layout.groups) && layout.groups.length) { state.plotGroups = layout.groups.filter(group => typeof group.id === 'string' && typeof group.name === 'string'); if (!state.plotGroups.length) state.plotGroups = [{id:'default',name:'默认组'}]; } state.activePlotGroup = state.plotGroups.some(group => group.id === layout.activeGroup) ? layout.activeGroup : state.plotGroups[0].id; for (const plot of plots) if (!state.plotGroups.some(group => group.id === (plot.groupId || 'default'))) plot.groupId = state.activePlotGroup; state.plotAssignments = new Map(Array.isArray(layout.assignments) ? layout.assignments : []); $('plotColumns').value = String(layout.columns || '2'); $('plotTimeWindow').value = String(timeWindowSeconds(layout.seconds)); if (Array.isArray(layout.windows)) for (const [id, seconds] of layout.windows) if (plots.some(plot => plot.id === id)) state.plotViews.set(id, { seconds: timeWindowSeconds(seconds), paused: false, anchorNs: null, snapshot: null }); nextPlotId = Math.max(2, ...state.plots.map(plot => Number(plot.id.replace('plot-', '')) + 1 || 2)); } } } catch { /* Ignore stale layout. */ }
  updateConnection(); updateDebugButtons(); updateLive(); renderPlots();
  const info = await api('/api/boards'); state.boards = info.boards;
  $('board').replaceChildren(...Object.keys(info.boards).map(value => option(value)));
  const workspace = await api('/api/workspace');
  state.projectRoot = workspace.projectRoot;
  const savedToolchain = await api('/api/toolchain/status');
  if (savedToolchain.configured) showToolchain(savedToolchain.configured, '已配置，可直接编译。');
  applyRecordStatus(await api('/api/record/status'));
  if (workspace.root) { state.workspace = workspace.root; loadBreakpoints(); $('workspaceLabel').textContent = workspace.root; $('folderRoot').textContent = workspace.root; await renderDirectory('', $('fileTree')); }
  await loadProjectProfile();
  await loadWatchFile(true);
  if (state.projectRoot) await loadBoard(); else await loadBuildPresets();
  const events = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  events.addEventListener('status', event => { const message = JSON.parse(event.data); $('status').textContent = message; if (message === 'Disconnected' || message.startsWith('Adapter exited:')) resetConnectionUI(); });
  events.addEventListener('log', event => { const data = JSON.parse(event.data); log(typeof data === 'string' ? data : data.text, data.channel || 'general'); });
  events.addEventListener('samples', event => receiveSamples(JSON.parse(event.data)));
  events.addEventListener('catalog', event => { const payload = JSON.parse(event.data); if (!payload.variables?.length) return; const saved = captureWatchConfig(); setVariableCatalog(payload.variables, payload.tree || []); restoreWatchConfig(saved); });
  events.addEventListener('debug', event => { const data = JSON.parse(event.data); perform(() => handleDebugEvent(data)); });
  events.addEventListener('record', event => applyRecordStatus(JSON.parse(event.data)));
  new ResizeObserver(() => scheduleDraw(true)).observe($('plotGrid'));
  $('plotGrid').onscroll = () => scheduleDraw(true);
  document.addEventListener('fullscreenchange', () => { $('plotGridFullscreen').textContent = document.fullscreenElement === $('plotGrid') ? '退出全屏' : '全屏曲线区'; for (const card of $('plotGrid').children) card.querySelector('.plot-fullscreen').textContent = document.fullscreenElement === card ? '退出全屏' : '全屏'; scheduleDraw(true); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleDraw(true); });
  setInterval(() => {
    if (state.connected && state.activeIds.length && performance.now() - state.lastSampleAt > 2500) {
      const warning = `采集超时：${state.activeIds.length} 路变量超过 2.5 秒没有样本；请检查状态栏中的探针读取错误`;
      if ($('metrics').textContent !== warning) $('metrics').textContent = warning;
    }
  }, 1000);
}
for (const button of document.querySelectorAll('[data-view-target]')) button.onclick = () => setView(button.dataset.viewTarget);
$('openDeviceTools').onclick = () => setView('tools');
$('backToConfig').onclick = () => setView('config');
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== $('configFrame').contentWindow) return;
  const message = event.data;
  if (message.type === 'pnx-config-preset') { $('preset').value = message.preset; state.preset = message.preset; }
  else if (message.type === 'pnx-config-configure') { setView('editor'); $('quickConfigure').click(); }
  else if (message.type === 'pnx-config-saved') perform(async () => {
    const result = await api(`/api/board?board=${encodeURIComponent(message.board)}`);
    state.config = result.config; state.hardware = result.hardware; fillMotor(); updateDebugButtons();
    log(`${message.board} 图形配置已保存；重新编译后生效`);
  });
  else if (message.type === 'pnx-config-open-file') perform(async () => {
    const root = (state.workspace || '').replaceAll('\\', '/').replace(/\/$/, '') + '/';
    const target = String(message.path || '').replaceAll('\\', '/');
    if (!root || !target.toLowerCase().startsWith(root.toLowerCase())) throw new Error('请先在工作台打开当前 PnX 项目文件夹');
    await openFile(target.slice(root.length), document.createElement('button'));
  });
});
$('board').onchange = () => perform(loadBoard);
$('toolchainSetup').onclick = () => perform(setupToolchain);
$('toolchainMissingClose').onclick = () => $('toolchainMissing').close();
$('toolchainDownload').onclick = () => perform(async () => {
  if (window.PNXDesktop?.openToolDownload) for (const name of state.missingTools) await window.PNXDesktop.openToolDownload(name);
  else for (const name of state.missingTools) window.open({ cmake: 'https://cmake.org/download/', ninja: 'https://github.com/ninja-build/ninja/releases', arm: 'https://developer.arm.com/tools-and-software/gnu-toolchain#Downloads' }[name], '_blank');
  $('toolchainMissing').close();
});
$('scanProbes').onclick = () => perform(scanProbes);
$('checkStlinkDriver').onclick = () => perform(checkStlinkDriver);
$('probeList').onchange = () => { $('probe').value = $('probeList').value; };
$('probe').oninput = () => { $('probeList').selectedIndex = -1; };
$('openFolder').onclick = () => perform(openFolder);
$('markdownToggle').onclick = () => { if (state.file) { state.file.previewMarkdown = !state.file.previewMarkdown; updateEditor(); } };
$('codeEditor').oninput = () => { if (state.file) state.file.value = $('codeEditor').value; updateEditor(); scheduleHighlight(); };
$('codeEditor').onscroll = () => { if (state.file) { state.file.scrollTop = $('codeEditor').scrollTop; state.file.scrollLeft = $('codeEditor').scrollLeft; } syncHighlightScroll(); renderBreakpointGutter(); };
function hideDefinitionOverlay() { $('definitionOverlay').classList.remove('active'); }
function showDefinitionOverlay() {
  if (!state.file || state.view !== 'editor' || document.querySelector('dialog[open]')) return;
  const overlay = $('definitionOverlay'), editor = $('codeEditor');
  if (overlay.classList.contains('active')) return;
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const match of editor.value.matchAll(/[A-Za-z_]\w*/g)) {
    fragment.append(document.createTextNode(editor.value.slice(offset, match.index)));
    const link = document.createElement('span'); link.textContent = match[0]; link.dataset.offset = String(match.index);
    link.title = `跳转到 ${match[0]} 的定义（Ctrl / Cmd + 单击）`;
    fragment.append(link); offset = match.index + match[0].length;
  }
  fragment.append(document.createTextNode(editor.value.slice(offset) + '\n'));
  overlay.replaceChildren(fragment); overlay.classList.add('active');
  overlay.scrollTop = editor.scrollTop; overlay.scrollLeft = editor.scrollLeft;
}
document.addEventListener('keydown', event => { if (event.key === 'Control' || event.key === 'Meta') showDefinitionOverlay(); else hideDefinitionOverlay(); });
document.addEventListener('keyup', event => { if (!event.ctrlKey && !event.metaKey) hideDefinitionOverlay(); });
window.addEventListener('blur', hideDefinitionOverlay);
document.addEventListener('pointermove', event => { if (!event.ctrlKey && !event.metaKey) hideDefinitionOverlay(); });
document.addEventListener('pointerdown', event => { if (!$('definitionOverlay').contains(event.target)) hideDefinitionOverlay(); }, true);
$('codeEditor').addEventListener('pointermove', event => { if (event.ctrlKey || event.metaKey) showDefinitionOverlay(); });
$('definitionOverlay').addEventListener('wheel', event => {
  event.preventDefault(); const editor = $('codeEditor'); editor.scrollTop += event.deltaY; editor.scrollLeft += event.deltaX;
  $('definitionOverlay').scrollTop = editor.scrollTop; $('definitionOverlay').scrollLeft = editor.scrollLeft;
}, { passive: false });
$('definitionOverlay').addEventListener('click', event => {
  const link = event.target.closest('span[data-offset]');
  hideDefinitionOverlay();
  if (!(event.ctrlKey || event.metaKey) || !link) return;
  event.preventDefault(); const offset = Number(link.dataset.offset);
  $('codeEditor').setSelectionRange(offset, offset + link.textContent.length);
  perform(goToDefinition);
});
$('goDefinition').onclick = () => perform(goToDefinition);
$('goBack').onclick = () => perform(async () => { const previous = definitionHistory.pop(); if (previous) await navigateTo(previous, false); $('goBack').disabled = definitionHistory.length === 0; });
$('goLine').onclick = goToLine;
$('definitionClose').onclick = () => $('definitionDialog').close();
$('lineDialog').addEventListener('close', () => { if ($('lineDialog').returnValue === 'jump') perform(() => navigateTo({ path: state.file.path, line: Number($('lineNumber').value), column: 1 })); });
$('saveFile').onclick = () => perform(saveFile);
document.addEventListener('keydown', event => { if (event.key.toLowerCase() === 's' && (event.ctrlKey || event.metaKey) && state.file) { event.preventDefault(); perform(saveFile); } });
document.addEventListener('keydown', event => {
  if (state.view !== 'editor' || !state.file || document.querySelector('dialog[open]')) return;
  if (event.key === 'F12') { event.preventDefault(); perform(goToDefinition); }
  if (event.key === 'F9') { event.preventDefault(); const line = $('codeEditor').value.slice(0, $('codeEditor').selectionStart).split('\n').length; perform(() => toggleBreakpoint(state.file.path, line)); }
  else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'g') { event.preventDefault(); goToLine(); }
  else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); $('goBack').click(); }
});
$('scopeRate').onchange = () => { $('rate').value = $('scopeRate').value; };
$('rate').onchange = () => { $('scopeRate').value = $('rate').value; };
$('preset').onchange = () => { state.preset = $('preset').value; };
async function loadProjectProfile() {
  state.projectProfile = await api('/api/project-settings');
  state.projectRoot = state.projectProfile.projectRoot;
  updateDebugButtons(); updateConfigFrame();
}
$('projectSettings').onclick = () => perform(async () => {
  await loadProjectProfile(); const profile = state.projectProfile;
  $('projectSettingsRoot').textContent = profile.root || '请先打开工程文件夹';
  $('targetChip').value = profile.target.chip; $('targetElf').value = profile.target.elf; $('targetBuildFirst').checked = profile.target.buildBeforeDebug;
  $('taskExecutable').value = profile.build.executable; $('taskArguments').value = JSON.stringify(profile.build.args);
  $('projectPluginList').replaceChildren(...profile.availablePlugins.map(plugin => {
    const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.dataset.pluginId = plugin.id; box.checked = plugin.enabled;
    if (plugin.id === 'pnx') box.id = 'pnxPluginEnabled';
    label.append(box, document.createTextNode(`${plugin.name} · API ${plugin.apiVersion}${plugin.detected ? ' · 已识别工程' : ''}`)); return label;
  }));
  $('pnxPluginHint').textContent = profile.pnxDetected ? '已识别 PnX 工程，可按工程启用或关闭。' : '当前目录不符合 PnX config 结构；通用调试不需要此插件。';
  $('projectSettingsError').textContent = ''; $('projectSettingsDialog').showModal();
});
$('detectTarget').onclick = () => perform(async () => {
  const found=await api('/api/project-detection');
  $('detectedElf').replaceChildren(option('','选择发现的 ELF'),...found.candidates.map(item=>option(item.elf,item.elf)));
  if(found.chip) $('targetChip').value=found.chip;
  if(found.elf) {$('targetElf').value=found.elf;$('detectedElf').value=found.elf;}
  $('detectionHint').textContent=found.ambiguous?'发现多个 ELF，请选择与板上固件一致的文件。':`识别来源：${found.sources.join('、') || '工程 ELF 扫描'}；发现 ${found.candidates.length} 个 ELF。`;
});
$('detectedElf').onchange=()=>{if($('detectedElf').value)$('targetElf').value=$('detectedElf').value;};
$('scopeTargetSettings').onclick = () => $('projectSettings').onclick();
$('projectSettingsCancel').onclick = () => $('projectSettingsDialog').close();
$('projectSettingsForm').onsubmit = async event => {
  event.preventDefault();
  try {
    const args = JSON.parse($('taskArguments').value || '[]');
    const profile = await api('/api/project-settings', { plugins: Object.fromEntries([...$('projectPluginList').querySelectorAll('input')].map(box => [box.dataset.pluginId, box.checked])), target:{chip:$('targetChip').value,elf:$('targetElf').value,buildBeforeDebug:$('targetBuildFirst').checked},build:{executable:$('taskExecutable').value,args} });
    resetConnectionUI(); state.projectProfile = profile; state.projectRoot = profile.projectRoot; state.config = {}; state.hardware = {};
    if (state.projectRoot) await loadBoard(); else { $('hardware').replaceChildren(); fillMotor(); await loadBuildPresets(); }
    updateConfigFrame(); updateDebugButtons(); $('projectSettingsDialog').close();
    log('工程设置已保存；旧调试连接已关闭。');
  } catch (error) { $('projectSettingsError').textContent = error.message; }
};
$('reload').onclick = () => perform(state.projectRoot ? loadBoard : loadBuildPresets);
$('motor').onchange = showMotor;
$('saveMotor').onclick = () => perform(saveMotor);
$('showRobot').onclick = () => editJson('robot');
$('showParams').onclick = () => editJson('params');
$('closeJson').onclick = () => $('editor').classList.add('hidden');
$('saveJson').onclick = () => perform(saveJson);
$('configure').onclick = () => perform(async () => { activateTerminal('build'); const result = await api('/api/configure', { preset: state.preset }); log(`配置完成：${result.buildDir || state.preset}`, 'build'); });
async function buildCurrent() { activateTerminal('build'); await saveDirtyFiles(); const result = await api('/api/build', { preset: state.preset }); log(`编译完成：${result.elf || result.buildDir || state.preset}`, 'build'); await loadProjectProfile(); await renderDirectory('', $('fileTree')); }
$('build').onclick = () => perform(buildCurrent);
$('quickConfigure').onclick = $('configure').onclick;
$('quickBuild').onclick = $('build').onclick;
$('quickDebug').onclick = () => perform(async () => { if (buildBeforeConnect()) await buildCurrent(); activateTerminal('debug'); await connect(false, false, true, false); });
for (const [id, command] of [['quickPause','pause'],['quickContinue','continue'],['quickStep','next']]) $(id).onclick = () => perform(async () => { activateTerminal('debug'); await api('/api/debug', { command }); log(`调试命令完成：${command}`, 'debug'); });
$('jumpToStop').onclick = () => perform(async () => { if (state.stoppedAt?.path && state.stoppedAt.line) await navigateTo({ path: state.stoppedAt.path, line: state.stoppedAt.line }, false); });
$('diagnosticSnapshot').onclick = () => perform(captureDiagnosticSnapshot);
$('diagnosticTarget').onchange = () => { $('diagnosticFilter').classList.toggle('hidden', $('diagnosticTarget').value !== 'status'); $('diagnosticFindings').replaceChildren(); $('diagnosticValues').replaceChildren(); $('diagnosticSummary').textContent = '点击“读取快照”查看当前全局诊断字段。'; };
$('mock').onclick = () => perform(() => connect(true, false));
$('attach').onclick = () => perform(() => connect(false, false));
$('connectFlash').onclick = () => perform(() => connect(false, true));
$('scopeMock').onclick = () => perform(() => connect(true, false));
$('scopeAttach').onclick = () => perform(() => connect(false, false));
$('scopeWriteConnect').onclick = () => perform(() => connect(false, false, true));
function buildBeforeConnect() { return state.projectProfile?.target.buildBeforeDebug || (!!state.projectRoot && !state.projectProfile?.target.elf); }
let flashInProgress = false;
async function flashCurrent() {
  if (flashInProgress) return;
  flashInProgress = true; updateDebugButtons();
  clearTimeout(autoSampleTimer);
  try {
  if (!(await confirmAction(`烧录 ${state.projectProfile?.target.elf || state.preset} 的 ELF，随后复位目标板？`))) return;
  const motorDemo = state.config.params?.value?.test?.auto_run_on_boot && state.config.params?.value?.test?.motor_demo;
  if (motorDemo && !(await confirmAction('当前配置启用了 motor_demo，复位后可能驱动电机。确认继续？'))) return;
  if (buildBeforeConnect()) await buildCurrent();
  activateTerminal('flash');
  await connect(false, true, false, false);
  await api('/api/flash', { preset: state.preset, ackMotorMotion: !!motorDemo });
  resetConnectionUI();
  log('烧录及校验完成，目标已复位并启动，烧录连接已释放', 'flash');
  } finally { flashInProgress = false; updateDebugButtons(); }
}
$('flash').onclick = () => perform(flashCurrent);
$('quickFlash').onclick = () => perform(flashCurrent);
async function disconnect() {
  await api('/api/disconnect', {});
  resetConnectionUI();
}
function resetConnectionUI(preserveWatch = true) {
  if ($('writeDialog').open) $('writeDialog').close();
  variableToWrite = undefined;
  if (!preserveWatch) { state.selected=[]; setVariableCatalog([],[]); state.expandedVariables.clear(); state.plotAssignments.clear(); state.plotGroups=[{id:'default',name:'默认组'}]; state.activePlotGroup='default'; state.plots=[{id:'plot-1',name:'曲线 1',groupId:'default'}]; }
  clearTimeout(liveTimer); liveTimer = null;
  state.connected = false; state.flashAccess = false; state.debugAccess = false; state.debugPaused = false; state.debugReason = ''; state.stoppedAt = null; stopRevision++; state.activeIds = []; state.activeIndex.clear(); state.latest = []; state.points = []; state.series.clear(); resetPlotViews(); state.latestById.clear(); state.latestAtById.clear(); state.firstTimestampNs = null; state.lastTimestampNs = 0; state.banks = 1; state.bankSize = BANK_CHANNELS; state.bankDwellMs = 0; state.streamEpoch = null; state.sampleCount = 0; state.droppedFrames = 0; state.rateWindow = []; state.lastSampleAt = 0; state.observedValues.clear(); state.valueChangedAt.clear(); state.valueSeenAt.clear(); state.recording = false; updateScopeNotice();
  if ($('variablePicker').open) $('variablePicker').close();
  $('disconnect').disabled = true; $('flash').disabled = true; $('openVariablePicker').disabled = true; $('subscribe').disabled = true;
  $('metrics').textContent = '尚未采集数据'; state.breakpointResults.clear(); updateConnection(); updateDebugButtons(); renderDebugPanel(); $('diagnosticFindings').replaceChildren(); $('diagnosticValues').replaceChildren(); displayVariables(); displaySelectedVariables(); updateRecordUi(); renderPlots();
}
$('disconnect').onclick = () => perform(disconnect);
$('quickStop').onclick = () => perform(async () => { activateTerminal('debug'); await disconnect(); log('调试会话已结束，探针已断开', 'debug'); });
$('scopeDisconnect').onclick = () => perform(disconnect);
$('openVariablePicker').onclick = () => { $('search').value = ''; displayVariables(); $('variablePicker').showModal(); $('search').focus(); };
$('closeVariablePicker').onclick = () => $('variablePicker').close();
$('search').oninput = () => {
  clearTimeout(pickerSearchTimer);
  pickerSearchTimer = setTimeout(() => { pickerPage = 0; $('variables').scrollTop = 0; displayVariables(); }, 120);
};
$('variablePrevious').onclick = () => { pickerPage--; displayVariables(); $('variables').scrollTop = 0; };
$('variableNext').onclick = () => { pickerPage++; displayVariables(); $('variables').scrollTop = 0; };
$('selectMatches').onclick = () => { if (!$('search').value.trim()) return; clearTimeout(pickerSearchTimer); displayVariables(); changeVariableSelection(state.matchingVariableIds, true); };
let autoSampleTimer, samplingUpdate = Promise.resolve();
function scheduleAutoSampling() {
  clearTimeout(autoSampleTimer);
  autoSampleTimer = setTimeout(() => {
    if (!state.connected || state.flashAccess || flashInProgress) return;
    samplingUpdate = samplingUpdate.catch(() => {}).then(() => state.connected && !state.flashAccess && !flashInProgress ? applySampling() : undefined).catch(error => log(`自动采集失败：${error.message}`));
  }, 250);
}
async function applySampling() {
  if (state.recording) applyRecordStatus(await api('/api/record/stop', {}));
  const rate = Number($('scopeRate').value) || 1000; $('rate').value = String(rate);
  const result = await api('/api/subscribe', { ids: state.selected.filter(id=>!state.variableById.get(id)?.unavailable), rate });
  clearTimeout(liveTimer); liveTimer = null;
  state.activeIds = result.ids; state.activeIndex = new Map(result.ids.map((id, index) => [id, index])); state.points = []; state.latest = []; state.series.clear(); resetPlotViews(); state.latestById.clear(); state.latestAtById.clear(); state.firstTimestampNs = null; state.lastTimestampNs = 0; state.banks = result.banks; state.bankSize = result.bankSize; state.bankDwellMs = result.dwellMs; state.streamEpoch = null; state.sampleCount = 0; state.droppedFrames = 0; state.rateWindow = []; state.lastSampleAt = performance.now(); state.observedValues.clear(); state.valueChangedAt.clear(); state.valueSeenAt.clear(); updateScopeNotice();
  $('metrics').textContent = result.ids.length ? '等待实时数据' : '尚未选择变量'; displayVariables(); displaySelectedVariables(); updateRecordUi(); renderPlots();
  log(`已订阅 ${result.ids.length} 个变量，${state.banks} 组采集`);
}
$('subscribe').onclick = () => { clearTimeout(autoSampleTimer); samplingUpdate = samplingUpdate.catch(() => {}).then(() => applySampling()); return perform(() => samplingUpdate); };
function askPlotGroupName(initial) {
  const dialog = document.createElement('dialog'), form = document.createElement('form'); form.method = 'dialog';
  const label = document.createElement('label'); label.textContent = '曲线组名称';
  const input = document.createElement('input'); input.value = initial; input.maxLength = 80; input.setAttribute('aria-label', '曲线组名称'); label.append(input);
  const cancel = document.createElement('button'); cancel.textContent = '取消'; cancel.value = 'cancel';
  const save = document.createElement('button'); save.textContent = '确定'; save.value = 'save';
  form.append(label, cancel, save); dialog.append(form); document.body.append(dialog);
  input.onkeydown = event => { if (event.key === 'Enter') {event.preventDefault(); dialog.close('save');} };
  return new Promise(resolve => { dialog.onclose = () => { const result = dialog.returnValue === 'save' ? input.value.trim() : ''; dialog.remove(); resolve(result); }; dialog.showModal(); input.focus(); input.select(); });
}
$('addPlotGroup').onclick = async () => {
  const name = await askPlotGroupName(`曲线组 ${state.plotGroups.length + 1}`); if (!name) return;
  const id = `group-${Date.now()}`; state.plotGroups.push({id, name}); state.activePlotGroup = id;
  $('addPlot').click();
};
$('renamePlotGroup').onclick = async () => {
  const group = state.plotGroups.find(item => item.id === state.activePlotGroup);
  const name = await askPlotGroupName(group.name); if (!name) return;
  group.name = name; renderPlots(); displaySelectedVariables(); displayVariables(); savePlotLayout();
};
$('removePlotGroup').onclick = async () => {
  if (state.plotGroups.length < 2) return;
  const id = state.activePlotGroup, group = state.plotGroups.find(item => item.id === id);
  if (!(await confirmAction(`删除“${group.name}”？组内曲线将移到另一组，保留变量分配。`))) return;
  state.plotGroups = state.plotGroups.filter(item => item.id !== id); state.activePlotGroup = state.plotGroups[0].id;
  for (const plot of state.plots) if ((plot.groupId || 'default') === id) plot.groupId = state.activePlotGroup;
  renderPlots(); displaySelectedVariables(); displayVariables(); savePlotLayout();
};
$('addPlot').onclick = () => { const id = `plot-${nextPlotId++}`; state.plots.push({ id, name: `曲线 ${state.plots.length + 1}`, groupId: state.activePlotGroup }); renderPlots(); displayVariables(); displaySelectedVariables(); savePlotLayout(); };
$('plotTimeWindow').onchange = () => {
  const seconds = timeWindowSeconds($('plotTimeWindow').value); $('plotTimeWindow').value = String(seconds);
  for (const card of $('plotGrid').children) { const view = plotView(card.dataset.plotId); view.seconds = seconds; if (view.paused) view.anchorNs = clampPlotAnchor(card, view.anchorNs); refreshPlotViewbar(card); }
  savePlotLayout(); scheduleDraw(true);
};
$('plotGridFullscreen').onclick = () => perform(async () => { if (document.fullscreenElement === $('plotGrid')) await document.exitFullscreen(); else await $('plotGrid').requestFullscreen(); });
$('recordStart').onclick = () => perform(async () => { applyRecordStatus(await api('/api/record/start', {})); log(`开始记录：${state.recordFile}`); });
$('recordStop').onclick = () => perform(async () => { applyRecordStatus(await api('/api/record/stop', {})); log(`CSV 已保存：${state.recordFile}（${state.recordRows} 行）`); });
$('exportCsv').onclick = () => { if (!state.recordFile) return; const link = document.createElement('a'); link.href = `/api/record/csv?token=${encodeURIComponent(token)}`; link.download = state.recordFile.split(/[\\/]/).at(-1); document.body.append(link); link.click(); link.remove(); };
$('plotColumns').onchange = () => { renderPlots(); savePlotLayout(); };
$('serialTest').onclick = () => perform(async () => { activateTerminal('diagnostics'); await api('/api/serial-test', { port: $('serialPort').value, baud: Number($('baud').value) }); log('串口诊断已完成', 'diagnostics'); });
const darkCurveColors = [...colors];
function themeColor(dark, light) { return document.documentElement.dataset.theme === 'light' ? light : dark; }
function syncConfigTheme() {
  const doc = $('configFrame').contentDocument;
  if(doc) doc.documentElement.dataset.theme = document.documentElement.dataset.theme || 'dark';
}
function applyTheme(theme) {
  const light=theme==='light'; document.documentElement.dataset.theme=light?'light':'dark';
  try {localStorage.setItem('pnx-theme',light?'light':'dark');} catch {}
  $('themeToggle').textContent=light?'深色':'浅色';
  $('themeToggle').title=light?'切换深色模式':'切换浅色模式';
  $('themeToggle').setAttribute('aria-label',$('themeToggle').title);
  colors.splice(0,colors.length,...(light?['#087c50','#a55700','#0969bd','#bb2455','#7147bc','#807000','#007c86','#a42d93']:darkCurveColors));
  syncConfigTheme(); displayVariables(); displaySelectedVariables(); renderPlots(); scheduleDraw(true);
}
$('themeToggle').onclick=()=>applyTheme(document.documentElement.dataset.theme==='light'?'dark':'light');
$('configFrame').addEventListener('load',syncConfigTheme);
let initialTheme='dark'; try {initialTheme=localStorage.getItem('pnx-theme') || 'dark';} catch {}
applyTheme(initialTheme);
init().catch(error => log(`启动失败：${error.message}`));
