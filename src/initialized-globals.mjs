import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const hash = text => createHash('sha256').update(text).digest('hex');
const types = '(?:auto|bool|char|float|double|int|short|long|signed|unsigned|u?int(?:8|16|32|64)_t|size_t)';
const declaration = new RegExp(`^\\s*((?:(?:static|inline|volatile|const|constexpr|constinit|extern|${types})\\s+)+)([A-Za-z_]\\w*(?:::[A-Za-z_]\\w*)*)\\s*([\\s\\S]*)$`);

// Named aggregate types are admitted only as declarations, never by guessing
// member names. DWARF still supplies the member path, address and scalar type.
const aggregateDeclaration = /^\s*((?:(?:static|inline|volatile|const|constexpr|constinit|extern)\s+)*(?:(?:struct|class)\s+)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*\s+)([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*([\s\S]*)$/;
function matchDeclaration(text) {
  if (/^\s*(?:using|typedef|return|namespace)\b/.test(text)) return null;
  const candidates = [text.match(declaration), text.match(aggregateDeclaration)].filter(Boolean);
  const match = candidates.find(item => /^\s*(?:[=({]|$)/.test(item[3])) || candidates[0];
  return match && !/^(?:struct|class|enum)$/.test(match[1].trim()) ? match : null;
}
function hasTopLevelComma(text) {
  let depth = 0;
  for (const char of text) {
    if ('{(['.includes(char)) depth++;
    else if ('})]'.includes(char)) depth--;
    else if (char === ',' && depth === 0) return true;
  }
  return false;
}

// Deliberately conservative: ignore conditional compilation and class/function
// bodies. Unknown declarations must never become writable by a name-only match.
export function initializedDeclarations(source) {
  let conditional = 0, continued = false;
  const filtered = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, text => text.replace(/[^\n]/g, ' '))
    .split('\n').map(line => {
      if (/^\s*#\s*(?:if|ifdef|ifndef)\b/.test(line)) conditional++;
      const omit = conditional > 0 || /^\s*#/.test(line) || continued;
      continued = (continued || /^\s*#/.test(line)) && /\\\s*$/.test(line);
      if (/^\s*#\s*endif\b/.test(line)) conditional = Math.max(0, conditional - 1);
      return omit ? ' '.repeat(line.length) : line;
    }).join('\n');
  const result = [], scopes = []; let start = 0, nested = 0, initializer = 0;
  for (let i = 0; i < filtered.length; i++) {
    const c = filtered[i];
    if (nested) { if (c === '{') nested++; if (c === '}' && --nested === 0) start = i + 1; continue; }
    if (initializer) { if (c === '{') initializer++; if (c === '}') initializer--; continue; }
    if (c === '{') {
      const prefix = filtered.slice(start, i).trim();
      const ns = prefix.match(/^(?:inline\s+)?namespace\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*$/);
      if (ns) { scopes.push(ns[1]); start = i + 1; }
      else if (/^extern\s*$/.test(prefix)) { scopes.push(''); start = i + 1; }
      else if (matchDeclaration(prefix) && !/[()]/.test(prefix)) initializer = 1;
      else { nested = 1; start = i + 1; }
    } else if (c === '}') { scopes.pop(); start = i + 1; }
    else if (c === ';') {
      const match = matchDeclaration(filtered.slice(start, i));
      if (match) {
        const [, type, name, tail] = match;
        if (/\bextern\b/.test(type)) { start = i + 1; continue; }
        const initialized = !/\b(?:extern|const|constexpr)\b/.test(type) && !hasTopLevelComma(tail)
          && (/^\s*=\s*\S[\s\S]*$/.test(tail) || /^\s*\{[\s\S]*\}\s*$/.test(tail)
            || /^\s*\(\s*(?:[+-]?[\d.][\w.+-]*|true|false)\s*\)\s*$/.test(tail));
        result.push({ name: [...scopes.filter(Boolean), name].join('::'), initialized, line: filtered.slice(0, start).split('\n').length });
      }
      start = i + 1;
    }
  }
  return result;
}

export async function initializerEvidence(root, elf) {
  const entries = new Map(); if (!root || !elf) return entries;
  const elfTime = (await stat(elf)).mtimeMs; let files = 0, bytes = 0;
  const visit = async relative => {
    for (const item of await readdir(path.join(root, relative), { withFileTypes: true })) {
      if (item.isSymbolicLink() || ['.git','.cache','build','dist','target','node_modules'].includes(item.name)) continue;
      const rel = path.join(relative, item.name), full = path.join(root, rel);
      if (item.isDirectory()) await visit(rel);
      else if (item.isFile() && /\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i.test(item.name)) {
        const info = await stat(full); files++; bytes += info.size;
        if (files > 6000 || bytes > 32 * 1024 * 1024) throw new Error('Source scan limit exceeded');
        if (info.size > 2 * 1024 * 1024) throw new Error('Source file too large to verify');
        const text = await readFile(full, 'utf8'), fileHash = hash(text);
        for (const declaration of initializedDeclarations(text)) {
          const evidence = { path: full, hash: fileHash, line: declaration.line, initialized: declaration.initialized && info.mtimeMs <= elfTime };
          if (entries.has(declaration.name)) entries.set(declaration.name, null);
          else entries.set(declaration.name, evidence);
        }
      }
    }
  };
  await visit(''); return entries;
}
export function markInitializedGlobals(catalog, evidence, parentProof = null, blocked = false) {
  for (const item of catalog || []) {
    const forbidden = blocked || item.pointerAddress != null || /[&*]|\bconst\b/.test(item.typeName || '');
    const expression = item.expression || '';
    const suffix = parentProof && expression.startsWith(parentProof.expression)
      ? expression.slice(parentProof.expression.length) : '';
    const directMember = /^(?:\.[A-Za-z_]\w*|\[\d+\])+$/.test(suffix);
    // Inherit only along the actual DWARF tree, not arbitrary name prefixes.
    const found = evidence.has(expression) ? evidence.get(expression)
      : directMember ? parentProof.evidence : null;
    item.explicitInitializer = !forbidden && !!found?.initialized;
    item.initializerEvidence = item.explicitInitializer ? found : null;
    item.writeReason = forbidden ? '只读：常量、指针或引用成员不可写'
      : item.explicitInitializer ? '' : '只读：未确认唯一、显式初始化且未晚于 ELF 的全局变量或结构体声明';
    const proof = item.explicitInitializer ? { expression, evidence: found } : null;
    markInitializedGlobals(item.children, evidence, proof, forbidden);
  }
}
export async function verifyInitializer(item) {
  const evidence = item?.initializerEvidence;
  if (!item?.explicitInitializer || !evidence) throw new Error('仅允许修改能确认显式初始化的全局变量');
  if (hash(await readFile(evidence.path, 'utf8')) !== evidence.hash) throw new Error('变量声明文件已改变，请重新编译并连接后再写入');
}
