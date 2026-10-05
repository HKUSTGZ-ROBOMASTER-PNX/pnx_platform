import { globalScalars } from './global-variables.mjs';

const statusNames = ['ok', 'error', 'not_configured', 'invalid_arg', 'busy', 'not_initialized', 'timeout'];
const levelNames = ['', 'error', 'warning', 'info', 'debug'];
const recordFields = { sequence: [0, 4], tick: [4, 4], value: [8, 4],
  message: [12, 16], status: [28, 1], severity: [29, 1], length: [30, 1], reserved: [31, 1] };

function layout(catalog) {
  const records = catalog.find(item => item.expression === 'pnx_log_records');
  const capacity = Number(/^array\[(\d+)\]$/.exec(records?.typeName || '')?.[1]);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 255 ||
      !Number.isSafeInteger(records?.address) || records.pointerAddress != null) {
    throw new Error('ELF 中未找到支持的 pnx_log_records；请使用含 DWARF 的匹配固件');
  }
  const first = records.children?.[0];
  if (first?.address !== records.address || first.byteWidth !== 32 ||
      Object.entries(recordFields).some(([name, [offset, width]]) => {
        const field = first.children?.find(item => item.name === name);
        return field?.address !== records.address + offset || field.byteWidth !== width;
      })) throw new Error('固件 logger 记录布局不受支持');
  const globals = globalScalars(catalog);
  const metadata = ['pnx_log_magic', 'pnx_log_boot_count', 'pnx_log_next_sequence'].map(name => {
    const item = globals.find(item => item.name === name);
    if (!item || item.byteWidth !== 4 || item.scalarKind !== 'unsigned') {
      throw new Error(`ELF 中缺少日志元数据 ${name}`);
    }
    return item.address;
  });
  return { address: records.address, capacity, metadata };
}

async function memory(session, address, count) {
  const result = await session.request('readMemory', { memoryReference: `0x${address.toString(16)}`, count });
  const data = Buffer.from(result.data || '', 'base64');
  if (data.length !== count || result.unreadableBytes) throw new Error('日志内存读取不完整');
  return data;
}

export async function readLogger(session, catalog) {
  const { address, capacity, metadata } = layout(catalog);
  const readMetadata = async () => {
    const values = [];
    for (const at of metadata) values.push((await memory(session, at, 4)).readUInt32LE());
    return values;
  };
  const before = await readMetadata();
  const [magic, bootCount, next] = before;
  if (magic !== (0x504e5800 | capacity) || next === 0) {
    throw new Error('logger 尚未初始化，或当前板上固件与 ELF 不匹配');
  }
  // Read twice without halting the MCU. Publication sequence and unchanged
  // bytes exclude partially updated records; never display a torn snapshot.
  const bytes = await memory(session, address, capacity * 32);
  const again = await memory(session, address, capacity * 32);
  const after = await readMetadata();
  if (!bytes.equals(again) || before.some((value, index) => value !== after[index])) {
    throw new Error('日志在读取期间发生变化，请重新读取快照');
  }
  const count = Math.min(next - 1, capacity), records = [];
  for (let index = 0; index < count; ++index) {
    const sequence = next - 1 - index;
    const at = ((sequence - 1) % capacity) * 32;
    const length = bytes[at + 30], status = bytes[at + 28], severity = bytes[at + 29];
    if (bytes.readUInt32LE(at) !== sequence || length > 15 || bytes[at + 12 + length] !== 0 ||
        status >= statusNames.length || severity < 1 || severity > 4 || bytes[at + 31] !== 0) {
      throw new Error('日志记录不完整或格式不匹配，请重新读取快照');
    }
    records.push({ sequence, tick: bytes.readUInt32LE(at + 4), value: bytes.readInt32LE(at + 8),
      message: bytes.subarray(at + 12, at + 12 + length).toString('utf8'),
      status: statusNames[status], severity: levelNames[severity] });
  }
  return { bootCount, capacity, writeCount: next - 1, records };
}
