import path from 'node:path';
import { existsSync, realpathSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

const OMIT = new Set(['.git', 'node_modules', 'target', 'build', 'dist', '.cache']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export class Workspace {
  constructor(initialRoot) { this.root = initialRoot && existsSync(initialRoot) ? realpathSync(initialRoot) : null; }
  open(folder) {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose an absolute folder path');
    const root = realpathSync(folder);
    if (!statSync(root).isDirectory()) throw new Error('Selected path is not a folder');
    this.root = root;
    return { root, isPnx: existsSync(path.join(root, 'CMakePresets.json')) && existsSync(path.join(root, 'configs', 'boards')) };
  }
  resolve(relative = '') {
    if (!this.root) throw new Error('Open a folder first');
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid relative path');
    const candidate = path.resolve(this.root, relative);
    const actual = realpathSync(candidate);
    if (actual !== this.root && !actual.startsWith(this.root + path.sep)) throw new Error('Path escapes the open folder');
    return actual;
  }
  list(relative = '') {
    const directory = this.resolve(relative);
    if (!statSync(directory).isDirectory()) throw new Error('Not a folder');
    return readdirSync(directory, { withFileTypes: true })
      .filter(item => !OMIT.has(item.name))
      .map(item => {
        const rel = path.join(relative, item.name).replaceAll('\\', '/');
        try { const full = this.resolve(rel); return { name: item.name, path: rel, directory: statSync(full).isDirectory() }; }
        catch { return null; }
      }).filter(Boolean)
      .sort((a,b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  }
  read(relative) {
    const file = this.resolve(relative);
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Only text files up to 2 MiB can be opened');
    const bytes = readFileSync(file);
    if (bytes.includes(0)) throw new Error('Binary file cannot be edited here');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('This file is not UTF-8 text'); }
    return { path: relative, text, hash: hash(bytes) };
  }
  save(relative, text, expectedHash) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Editor content exceeds 2 MiB');
    const file = this.resolve(relative);
    if (hash(readFileSync(file)) !== expectedHash) throw new Error('File changed on disk; reload it before saving');
    const temp = path.join(path.dirname(file), `.pnx-save-${randomBytes(8).toString('hex')}.tmp`);
    writeFileSync(temp, text, { flag: 'wx' });
    try { renameSync(temp, file); } catch (error) { throw error; }
    return { hash: hash(Buffer.from(text)) };
  }
}
