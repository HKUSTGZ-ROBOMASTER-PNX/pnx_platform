const query = new URLSearchParams(location.search);
const host = { board: query.get('board') || 'h723_mc02', role: query.get('role') || 'params', preset: query.get('preset') || '', state: null, folded: { 'params:bindings': true } };
const endpoint = (refresh = false) => `/api/config-editor/state?board=${encodeURIComponent(host.board)}&role=${encodeURIComponent(host.role)}&preset=${encodeURIComponent(host.preset)}${refresh ? '&refresh=1' : ''}`;
async function request(url, body) {
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'X-PnX-Token': window.PNX_TOKEN, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || response.statusText);
  return result;
}
function deliver(value) { host.state = value; document.getElementById('configBack').hidden = host.role !== 'hardware'; window.postMessage(value, location.origin); }
async function refresh(force = false) { deliver(await request(endpoint(force))); }
function error(message) { window.postMessage({ type: 'error', message: String(message) }, location.origin); }
window.acquireVsCodeApi = () => ({
  getState: () => ({ folded: host.folded }),
  setState: value => { host.folded = value.folded || {}; },
  postMessage: async message => {
    try {
      if (message.type === 'ready') { await refresh(); return; }
      if (message.type === 'switchConfig') { host.role = host.role === 'params' ? 'robot' : 'params'; await refresh(); return; }
      if (message.type === 'hardware') { host.role = 'hardware'; await refresh(); return; }
      if (message.type === 'refresh') { await refresh(true); return; }
      if (message.type === 'preset') {
        const selected = prompt(`选择构建配置：${host.state.presets.join(' / ')}`, host.preset || host.state.preset);
        if (selected === null) return;
        if (!host.state.presets.includes(selected)) throw new Error('选择列表中的构建配置');
        host.preset = selected;
        parent.postMessage({ type: 'pnx-config-preset', preset: selected }, location.origin);
        await refresh(); return;
      }
      if (message.type === 'configure') { parent.postMessage({ type: 'pnx-config-configure' }, location.origin); return; }
      if (message.type === 'text' || message.type === 'board') {
        const target = message.type === 'board' ? host.state.context?.files?.board : host.state.context?.files?.[host.role];
        parent.postMessage({ type: 'pnx-config-open-file', path: target }, location.origin); return;
      }
      deliver(await request('/api/config-editor/action', { ...message, action: message.type, operation: message.action,
        board: host.board, role: host.role, preset: host.preset || host.state.preset }));
      parent.postMessage({ type: 'pnx-config-saved', board: host.board }, location.origin);
    } catch (cause) { error(cause.message || cause); }
  },
});
document.getElementById('configBack').onclick = () => { host.role = 'params'; refresh().catch(cause => error(cause.message)); };
