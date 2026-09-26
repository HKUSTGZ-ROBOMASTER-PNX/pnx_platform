import path from 'node:path';
import { readFileSync } from 'node:fs';
import { ROOT as root } from '../../paths.mjs';

const schema = JSON.parse(readFileSync(path.join(root, 'src', 'plugins', 'pnx', 'params.schema.json')));
const defaultData = JSON.parse(readFileSync(path.join(root, 'src', 'plugins', 'pnx', 'defaults.json')));
export const bindingKinds = { uart_ports: 'uart', can_buses: 'can', spi_buses: 'spi', adc_channels: 'adc', gpio_inputs: 'gpio_input_role', gpio_outputs: 'gpio_output_role' };
const models = ['dji_m2006','dji_m3508','dji_gm6020','dji_xroll','dm_dm4310','dm_dm8009p','lk_lk8016','lk_lk9025'];
export const motorFields = [
  { path: ['name'], type: 'string' }, { path: ['model'], type: 'string', choices: models },
  { path: ['can_bus'], type: 'string', resource: 'can' }, { path: ['can_type'], type: 'string', choices: ['classic','fd'] },
  { path: ['can_id'], type: 'string' }, { path: ['control_mode'], type: 'string', choices: ['relax','current','torque','mit','pos_speed','speed','multi','position_speed','velocity'], default: 'relax' },
];
export const get = (object, parts) => parts.reduce((value, key) => value?.[key], object);
const merge = (base, override) => {
  const result = { ...base };
  for (const [key, value] of Object.entries(override || {})) result[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key] || {}, value) : value;
  return result;
};
export const boardDefaults = board => merge(defaultData.common, defaultData.boards?.[board] || {});
export function motorModes(model = '') {
  if (model.startsWith('dm_')) return ['relax','mit','pos_speed','speed','position_speed','velocity'];
  if (model.startsWith('dji_') || model.startsWith('lk_')) return ['relax','current','torque'];
  return [];
}
export function parameterActive(parts, params, robot) {
  const source = params.remoter?.source || 'none';
  switch (parts[0]) {
    case 'bmi088': case 'ahrs': return robot?.devices?.bmi088?.enabled === true;
    case 'dmimu': return robot?.devices?.dmimu?.enabled === true;
    case 'usb': return params.build?.usbx === true;
    case 'ps2': return source === 'ps2';
    case 'remoter': return parts[1] === 'source' || !['none','off','disabled'].includes(source);
    case 'referee': return !!params.bindings?.referee_uart && params.bindings.referee_uart !== 'none';
    case 'can_diag': return parts[1] === 'enabled' || params.can_diag?.enabled === true;
    default: return true;
  }
}
function schemaFields(node, parts = []) {
  if (node.type === 'object') return Object.entries(node.properties || {}).flatMap(([key, child]) => schemaFields(child, [...parts, key]));
  if (!['string','number','integer','boolean'].includes(node.type)) return [];
  return [{ path: parts, type: node.type === 'integer' ? 'number' : node.type, integer: node.type === 'integer',
    choices: node['x-editorChoices'] || node.enum || node['x-extraChoices'], resource: node['x-resource'], min: node.minimum, max: node.maximum, default: node.default }];
}
const appFields = schemaFields(schema);
export function fields(role, object, hardware) {
  if (role === 'robot') return ['bmi088','led','dmimu'].map(key => ({ path: ['devices',key,'enabled'], type: 'boolean' })).concat([
    { path: ['devices','dmimu','can_bus'], type: 'string', resource: 'can' },
    { path: ['devices','dmimu','can_type'], type: 'string', choices: ['classic'] },
    { path: ['devices','dmimu','can_id'], type: 'string' }, { path: ['devices','dmimu','master_id'], type: 'string' },
  ]);
  const result = appFields.map(field => ({ ...field }));
  function walk(value, parts = []) {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) walk(child, [...parts, key]);
    else if (['string','number','boolean'].includes(typeof value) && !result.some(field => field.path.join('.') === parts.join('.'))) {
      const group = String(parts[1]);
      let resource = bindingKinds[group];
      if (parts[0] !== 'bindings' || group === 'adc_channels' || (parts.length > 3 && parts.at(-1) !== 'bus')) resource = undefined;
      result.push({ path: parts, type: typeof value, resource, choices: group === 'uart_ports' ? ['none'] : undefined });
    }
  }
  walk(object);
  for (const bus of hardware?.can || []) if (!result.some(field => field.path.join('.') === `can.${bus}.id_type`)) result.push({ path: ['can',bus,'id_type'], type: 'string' });
  for (const field of result) if (field.path[0] === 'can' && field.path[2] === 'id_type') { field.choices = ['standard','extended']; field.default = 'standard'; }
  return result.filter(field => field.path[0] !== 'can' || !hardware || hardware.can?.includes(String(field.path[1])))
    .filter(field => field.path[0] !== 'ps2' || (object.remoter?.source === 'ps2' && field.path[1] !== 'enabled' && (object.ps2?.backend === 'spi' ? !['cmd','data','clk'].includes(String(field.path[1])) : field.path[1] !== 'spi')))
    .sort((a,b) => Number(a.path[0] === 'bmi088') - Number(b.path[0] === 'bmi088'));
}
export function validate(field, value, hardware, fresh = true) {
  if (field.path.join('.') === 'remoter.source' && ['off','disabled'].includes(value)) value = 'none';
  if (typeof value !== field.type) throw new Error(`${field.path.join('.')}: 需要 ${field.type}`);
  if (field.type === 'number' && (!Number.isFinite(value) || (field.integer && !Number.isInteger(value)) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))) throw new Error('数值超出范围');
  if (field.resource) {
    if (!fresh || !hardware) throw new Error('硬件资源无法检查，请刷新');
    if (![...(field.choices || []),...(hardware[field.resource] || [])].includes(value)) throw new Error('当前板型不可用');
  } else if (field.choices && !field.choices.includes(value)) throw new Error('未知枚举值，请在文本中处理');
  if (field.path.at(-1) === 'name' && !value.trim()) throw new Error('名称不能为空');
  if (/^(can_id|master_id)$/.test(String(field.path.at(-1))) && !/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(value)) throw new Error('ID 使用十进制或 0x 十六进制字符串');
}
export function bindingValue(kind, resource, hardware) {
  const type = bindingKinds[kind]; if (!type) throw new Error('未知绑定类型');
  validate({ path: [], type: 'string', resource: type, choices: kind === 'uart_ports' ? ['none'] : undefined }, resource, hardware);
  if (kind === 'adc_channels') { const match = /^(adc[0-9]+)_ch([0-9]+)$/.exec(resource); if (!match) throw new Error('ADC 通道无效'); return { adc: match[1], channel: Number(match[2]) }; }
  return resource;
}
export function setPath(object, parts, value) {
  if (!Array.isArray(parts) || !parts.length || parts.some(key => typeof key !== 'string' && !Number.isInteger(key)) || parts.some(key => ['__proto__','prototype','constructor'].includes(key))) throw new Error('字段路径无效');
  let node = object;
  for (const key of parts.slice(0,-1)) { if (node[key] === undefined) node[key] = {}; if (!node[key] || typeof node[key] !== 'object') throw new Error('字段父级不是对象'); node = node[key]; }
  if (value === undefined) { if (Array.isArray(node)) node.splice(parts.at(-1), 1); else delete node[parts.at(-1)]; }
  else node[parts.at(-1)] = value;
}
export function testRequirements(object, robot) {
  const errors = {}, test = object.test || {};
  if (test.usart && (!object.bindings?.uart_ports?.test_uart || object.bindings.uart_ports.test_uart === 'none')) errors['test.usart'] = 'Add bindings.uart_ports.test_uart and select a UART.';
  if (test.can && !object.bindings?.can_buses?.test_can) errors['test.can'] = 'Add bindings.can_buses.test_can and select a CAN bus.';
  if (test.usb && !object.build?.usbx) errors['test.usb'] = 'Enable build.usbx for USB diagnosis.';
  if (test.remoter && (!object.remoter?.source || ['none','off','disabled'].includes(object.remoter.source))) errors['test.remoter'] = 'Select remoter.source and configure its binding.';
  if (test.referee_ui && (!object.bindings?.referee_uart || object.bindings.referee_uart === 'none')) errors['test.referee_ui'] = 'Select bindings.referee_uart.';
  if (test.imu && robot && !robot.devices?.bmi088?.enabled && !robot.devices?.dmimu?.enabled) errors['test.imu'] = 'Enable BMI088 or DMIMU in Robot.';
  if (test.motor_demo && robot && !robot.devices?.motors?.list?.length) errors['test.motor_demo'] = 'Add motors in Robot.';
  if (test.gpio_leds && !object.bindings?.gpio_outputs?.test_gpio) errors['test.gpio_leds'] = 'Add bindings.gpio_outputs.test_gpio and select a board GPIO output.';
  return errors;
}
