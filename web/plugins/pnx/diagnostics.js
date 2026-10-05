const canFields = ['state_bo','state_ep','state_ew','tec','rec','lec','cel_total','ack_total','rx_frames_total','tx_attempts_total','rx_overrun_total','busoff_total','fifo0_fill','fifo1_fill','rx_rate_avg','tx_rate_avg'];
const pnxStatusNames = ['ok','error','not_configured','invalid_arg','busy','not_initialized','not_connected','empty','too_large','invalid_context'];
function diagnosticVariables(target) {
  if (target === 'status') {
    const query = $('diagnosticFilter').value.trim().toLowerCase();
    return state.variables.filter(variable =>
      /(?:^|[.])(?:last_status|status|state|result|error|type)(?:$|[.])|(?:last_status|last_error|error_code)$/i.test(variable.name)
      && (!query || variable.name.toLowerCase().includes(query))).slice(0, 40);
  }
  const bus = Number(target.slice(3));
  if (!Number.isInteger(bus) || bus < 0 || bus > 2) return [];
  const field = new RegExp(`can_diag_bus\\.?\\[${bus}\\]\\.([A-Za-z_][A-Za-z_0-9]*)$`, 'i');
  const candidates = state.variables.filter(variable => field.test(variable.name));
  candidates.sort((a, b) => canFields.indexOf(a.name.match(field)?.[1]) - canFields.indexOf(b.name.match(field)?.[1]));
  const sampleCount = state.variables.find(variable => /(?:^|\.)can_diag_sample_count$/.test(variable.name));
  return [...(sampleCount ? [sampleCount] : []), ...candidates.filter(variable => canFields.includes(variable.name.match(field)?.[1]))].slice(0, 40);
}
function canFindings(values, target) {
  const get = name => {
    const bus = target.slice(3);
    const entry = values.find(item => item.name.endsWith(`.${name}`) && new RegExp(`can_diag_bus\\.?\\[${bus}\\]\\.`).test(item.name));
    return entry?.value == null ? null : Number(entry.value);
  };
  const messages = [];
  if (state.config.params?.value?.can_diag?.enabled === false) messages.push('当前板卡配置关闭了 can_diag；启用后重新编译并烧录才能读取板端指标。');
  const sample = values.find(item => /can_diag_sample_count$/.test(item.name));
  if (sample && Number(sample.value) === 0) messages.push('诊断采样计数为 0：可能尚未初始化 CAN，或定时采样尚未运行。');
  if (get('state_bo') > 0) messages.push('总线当前 Bus Off：优先检查接线、终端电阻、波特率与对端状态。');
  else if (get('state_ep') > 0) messages.push('总线当前 Error Passive：通信错误较多，查看 TEC/REC 与错误计数。');
  else if (get('state_ew') > 0) messages.push('总线当前 Error Warning：错误计数已达到警告状态。');
  if (get('ack_total') > 0) messages.push('累计出现过 ACK 错误：检查对端是否在线、接线及位时序。');
  if (get('rx_overrun_total') > 0) messages.push('累计出现过接收 FIFO 溢出：检查接收处理和回调耗时。');
  if (get('tx_attempts_total') === 0) messages.push('未记录到成功入队的发送帧；应用层可能尚未发起发送，或发送在入队前失败。');
  else if (get('rx_frames_total') === 0) messages.push('已记录发送入队，但尚无接收帧；继续检查对端发送、过滤器和总线接线。');
  if (!messages.length) messages.push('这些指标未指向明确故障；可结合状态字段、应用层回调与时间变化继续检查。');
  return messages;
}
function statusFindings(values) {
  const failures = values.filter(item => /\btypes::status\b/.test(item.type) && Number(item.value) > 0);
  if (failures.length) return failures.slice(0, 8).map(item => {
    const code = Number(item.value);
    return `${item.name}: ${pnxStatusNames[code] || `状态码 ${code}`}。请沿该状态字段的写入点检查初始化、配置和调用链。`;
  });
  return ['未发现非零的 types::status 全局字段；局部函数返回值不在此快照中。'];
}
async function captureLoggerSnapshot() {
  const result = await api('/api/logger');
  $('diagnosticSummary').textContent = `日志 · 启动 ${result.bootCount} · ${result.records.length}/${result.capacity} 条 · ${new Date().toLocaleTimeString()}`;
  const note = document.createElement('p');
  note.textContent = '最新记录在前；tick 为 ThreadX ticks。读取不暂停或修改目标；RAM 日志不保证断电保存。';
  $('diagnosticFindings').replaceChildren(note);
  const table = document.createElement('table');
  table.className = 'logger-table';
  const head = table.createTHead().insertRow();
  for (const name of ['序号', 'tick', '等级', '状态', '数值', '消息']) {
    const cell = document.createElement('th'); cell.textContent = name; head.append(cell);
  }
  const body = table.createTBody();
  for (const record of result.records) {
    const row = body.insertRow();
    for (const key of ['sequence', 'tick', 'severity', 'status', 'value', 'message']) {
      row.insertCell().textContent = String(record[key]);
    }
  }
  $('diagnosticValues').replaceChildren(table);
  if (!result.records.length) note.textContent += ' 当前无记录。';
}

async function captureDiagnosticSnapshot() {
  const target = $('diagnosticTarget').value;
  if (target === 'logger') {
    $('diagnosticFindings').replaceChildren(); $('diagnosticValues').replaceChildren();
    $('diagnosticSnapshot').disabled = true;
    try { await captureLoggerSnapshot(); }
    catch (error) { $('diagnosticSummary').textContent = error.message; throw error; }
    finally { $('diagnosticSnapshot').disabled = !state.connected; }
    return;
  }
  if (!state.projectRoot) throw new Error('PnX 诊断插件未启用');
  const variables = diagnosticVariables(target);
  const findings = $('diagnosticFindings'), details = $('diagnosticValues');
  findings.replaceChildren(); details.replaceChildren();
  if (!variables.length) {
    $('diagnosticSummary').textContent = target === 'status' ? 'ELF 中没有可直接读取的状态全局标量。'
      : 'ELF 中没有 can_diag_bus 字段；请确认固件启用了 CAN 诊断并包含 DWARF 信息。';
    return;
  }
  $('diagnosticSnapshot').disabled = true;
  try {
    const result = await api('/api/debug/snapshot', { ids: variables.map(variable => variable.id) });
    const read = new Map(result.values.map(item => [item.id, item.value]));
    const rows = variables.map(variable => ({ name: variable.name, type: variable.type, value: read.get(variable.id) ?? null }));
    $('diagnosticSummary').textContent = `${target === 'status' ? '状态字段' : `CAN${Number(target.slice(3)) + 1}`} · ${rows.length} 项 · ${new Date().toLocaleTimeString()}`;
    findings.replaceChildren(...(target === 'status' ? statusFindings(rows) : canFindings(rows, target)).map(message => {
      const item = document.createElement('p'); item.textContent = message; return item;
    }));
    details.replaceChildren(...rows.map(row => {
      const item = document.createElement('div'); item.className = 'diagnostic-value';
      const name = document.createElement('span'); name.textContent = `${row.name} · ${row.type}`; name.title = name.textContent;
      const value = document.createElement('strong');
      const decoded = /\btypes::status\b/.test(row.type) ? pnxStatusNames[Number(row.value)] : null;
      value.textContent = row.value == null ? '不可用' : decoded ? `${row.value} (${decoded})` : String(row.value);
      item.append(name, value); return item;
    }));
  } finally { $('diagnosticSnapshot').disabled = !state.connected; }
}
