import path from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';

const SOURCE = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/i;
const OMIT = new Set(['.git', '.cache', 'build', 'dist', 'node_modules', 'target']);
const MAX_FILES = 6000;
const MAX_BYTES = 2 * 1024 * 1024;

function maskNonCode(source) {
  let result = '', mode = 'code';
  for (let i = 0; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { result += '  '; i++; mode = 'line'; continue; }
      if (c === '/' && next === '*') { result += '  '; i++; mode = 'block'; continue; }
      if (c === '"' || c === "'") { result += ' '; mode = c; continue; }
      result += c;
    } else if (mode === 'line') {
      result += c === '\n' ? '\n' : ' ';
      if (c === '\n') mode = 'code';
    } else if (mode === 'block') {
      if (c === '*' && next === '/') { result += '  '; i++; mode = 'code'; }
      else result += c === '\n' ? '\n' : ' ';
    } else {
      if (c === '\\' && next) { result += '  '; i++; }
      else if (c === mode) { result += ' '; mode = 'code'; }
      else result += c === '\n' ? '\n' : ' ';
    }
  }
  return result;
}

function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text[i] === '\n') line++;
  return line;
}

export function definitionsInText(text, name, file) {
  if (!/^[A-Za-z_]\w*$/.test(name)) return [];
  const code = maskNonCode(text);
  const matches = [];
  const token = new RegExp(`\\b${name}\\b`, 'g');
  for (const match of code.matchAll(token)) {
    const offset = match.index;
    const start = code.lastIndexOf('\n', offset - 1) + 1;
    const end = code.indexOf('\n', offset);
    const before = code.slice(start, offset);
    const after = code.slice(offset + name.length);
    const lineText = text.slice(start, end < 0 ? undefined : end).trim().slice(0, 180);
    let kind, rank;
    if (/^\s*#\s*define\s+$/.test(before)) { kind = '宏'; rank = 0; }
    else if (/\b(?:class|struct|union|enum|namespace|using)\s+$/.test(before)) { kind = '类型'; rank = 0; }
    else if (/\btypedef\b/.test(before) && /^\s*;/.test(after)) { kind = '类型'; rank = 0; }
    else if (/^\s*\(/.test(after)) {
      const prefix = before.trim();
      if (/\b(?:return|co_return|if|while|for|switch|catch|throw|delete|new)\b/.test(prefix) || /[=(,]$/.test(prefix)) continue;
      let depth = 0, close = -1;
      for (let i = offset + name.length; i < Math.min(code.length, offset + 900); i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')' && --depth === 0) { close = i; break; }
      }
      if (close < 0) continue;
      const tail = code.slice(close + 1, Math.min(code.length, close + 350));
      const body = tail.search(/[;{]/);
      if (body < 0) continue;
      if (tail[body] === '{') { kind = '函数定义'; rank = 1; }
      else if (prefix && !prefix.includes('(')) { kind = '函数声明'; rank = 3; }
    } else if (/\b(?:extern|static|inline|constexpr|const|volatile|unsigned|signed|long|short|auto|[A-Za-z_]\w*)\s+(?:[*&]\s*)?$/.test(before) && /^\s*(?:=|;|\[)/.test(after)) {
      kind = '变量'; rank = 2;
    }
    if (kind) matches.push({ path: file, line: lineAt(code, offset), column: offset - start + 1, kind, rank, qualifiedName: qualifiedAt(code, offset, name), preview: lineText });
  }
  return matches;
}

function qualifiedAt(code, offset, name) {
  const stack = []; let boundary = 0;
  for (let i = 0; i < offset; i++) {
    if (code[i] === '{') {
      const prefix = code.slice(boundary, i);
      const scope = prefix.match(/\b(?:namespace|class|struct|union)\s+([A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*)[^;{}]*$/);
      stack.push(scope ? scope[1].replace(/\s/g, '') : ''); boundary = i + 1;
    } else if (code[i] === '}') { stack.pop(); boundary = i + 1; }
    else if (code[i] === ';') boundary = i + 1;
  }
  const explicit = code.slice(0, offset).match(/(?:::)?(?:[A-Za-z_]\w*\s*::\s*)+$/)?.[0]?.replace(/\s/g, '') || '';
  const enclosing = stack.filter(Boolean).join('::');
  if (explicit.startsWith('::')) return explicit.slice(2) + name;
  if (enclosing && explicit.startsWith(enclosing + '::')) return explicit + name;
  return (enclosing ? enclosing + '::' : '') + explicit + name;
}

export async function findDefinitions(workspace, name, overrides = {}) {
  if (!/^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(name)) throw new Error('Select a C/C++ identifier');
  const qualified = name.replace(/^::/, ''), absolute = name.startsWith('::');
  const leaf = qualified.split('::').at(-1);
  if (!workspace.root) throw new Error('Open a folder first');
  const files = [];
  const visit = async relative => {
    if (files.length >= MAX_FILES) return;
    const directory = path.join(workspace.root, relative);
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (OMIT.has(item.name) || item.isSymbolicLink()) continue;
      const rel = path.join(relative, item.name).replaceAll('\\', '/');
      const full = path.join(workspace.root, rel);
      if (item.isDirectory()) await visit(rel);
      else if (item.isFile() && SOURCE.test(item.name)) files.push({ rel, full });
      if (files.length >= MAX_FILES) break;
    }
  };
  await visit('');
  const groups = [];
  for (let start = 0; start < files.length; start += 24) {
    groups.push(...await Promise.all(files.slice(start, start + 24).map(async ({ rel, full }) => {
      let source = overrides[rel];
      if (typeof source !== 'string') {
        if ((await stat(full)).size > MAX_BYTES) return [];
        source = await readFile(full, 'utf8');
      }
      return source.length > MAX_BYTES || !source.includes(leaf) ? [] : definitionsInText(source, leaf, rel);
    })));
  }
  let results = groups.flat();
  if (qualified.includes('::') || absolute) {
    const exact = results.filter(item => item.qualifiedName === qualified);
    results = exact.length || absolute ? exact : results.filter(item => item.qualifiedName.endsWith('::' + qualified));
  }
  return results.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path) || a.line - b.line).slice(0, 50);
}
