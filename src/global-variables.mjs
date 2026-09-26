const scalarKinds = new Set(['unsigned', 'signed', 'float32', 'float64', 'boolean']);
const ramRanges = [
  [0x10000000, 0x10010000],
  [0x20000000, 0x20100000],
  [0x24000000, 0x24100000],
  [0x30000000, 0x30100000],
  [0x38000000, 0x38100000],
];

function directRamScalar(item) {
  const width = item?.byteWidth;
  const validWidth = item?.scalarKind === 'float32' ? width === 4
    : item?.scalarKind === 'float64' ? width === 8 : [1, 2, 4, 8].includes(width);
  return Number.isSafeInteger(item?.address) && validWidth
    && item.pointerAddress == null && scalarKinds.has(item.scalarKind)
    && ramRanges.some(([start, end]) => item.address >= start && item.address + width <= end);
}

export function writableGlobal(item) {
  return directRamScalar(item) && item.writable === true && item.explicitInitializer === true && !item.children?.length
    && typeof item.typeName === 'string' && item.typeName.length > 0
    && !/[\[*\]]|\b(?:unknown|recursive|void|const)\b/i.test(item.typeName);
}

export function globalScalars(items, result = []) {
  for (const item of items || []) {
    if (!item || typeof item !== 'object' || item.pointerAddress != null) continue;
    if (item.id && item.expression && !item.children?.length && directRamScalar(item)) {
      result.push({ id: item.id, name: item.expression, type: item.typeName, typeName: item.typeName,
        address: item.address, scalarKind: item.scalarKind, byteWidth: item.byteWidth,
        explicitInitializer: item.explicitInitializer === true, initializerEvidence: item.initializerEvidence,
        writeReason: item.writeReason || '只读：不满足全局标量写入条件', writable: writableGlobal(item) });
    }
    if (Array.isArray(item.children) && !/\*/.test(item.typeName || '')) globalScalars(item.children, result);
  }
  return result;
}

export function globalTree(items) {
  const nodes = [];
  for (const item of items || []) {
    if (!item || typeof item !== 'object' || item.pointerAddress != null || /\*/.test(item.typeName || '')) continue;
    const children = globalTree(item.children);
    if (children.length) {
      nodes.push({ id: item.id, name: item.name || item.expression, expression: item.expression,
        type: item.typeName, children });
    } else if (!item.children?.length && item.id && item.expression && directRamScalar(item)) {
      nodes.push({ id: item.id, name: item.name || item.expression, expression: item.expression,
        type: item.typeName, address: item.address, scalarKind: item.scalarKind,
        byteWidth: item.byteWidth, explicitInitializer: item.explicitInitializer === true, writeReason: item.writeReason, writable: writableGlobal(item), children: [] });
    }
  }
  return nodes;
}

export function checkedWriteValue(item, input) {
  if (!writableGlobal(item)) throw new Error('Only typed, direct-address, non-pointer writable RAM globals can be changed');
  const source = typeof input === 'string' ? input.trim() : '';
  if (!source || source.length > 80) throw new Error('Enter a value');
  if (item.scalarKind === 'boolean') {
    if (!/^(?:true|false|0|1)$/.test(source)) throw new Error('Enter true, false, 0, or 1');
    return source;
  }
  if (item.scalarKind === 'float32' || item.scalarKind === 'float64') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(source)) throw new Error('Enter a finite decimal number');
    const number = Number(source);
    if (!Number.isFinite(number) || (item.scalarKind === 'float32' && !Number.isFinite(Math.fround(number)))) throw new Error('Enter a finite value in range');
    return source;
  }
  if (!/^-?(?:0[xX][0-9a-fA-F]+|[0-9]+)$/.test(source)) throw new Error('Enter an integer in decimal or hexadecimal');
  const value = /^-0[xX]/.test(source) ? -BigInt(source.slice(1)) : BigInt(source);
  const bits = BigInt(item.byteWidth * 8);
  const lower = item.scalarKind === 'signed' ? -(1n << (bits - 1n)) : 0n;
  const upper = item.scalarKind === 'signed' ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (value < lower || value > upper) throw new Error(`Value exceeds the ${item.byteWidth * 8}-bit ${item.scalarKind} range`);
  return /^-0[xX]/.test(source) ? value.toString() : source;
}
