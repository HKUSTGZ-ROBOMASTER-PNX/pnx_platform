import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { detectProjectTarget } from './target-detection.mjs';
import { plugins, defaultPlugins } from './plugins/registry.mjs';

export class ProjectSettings {
  constructor(directory) { this.directory = directory; }
  file(root) {
    if (!root) throw new Error('Open a project folder first');
    return path.join(this.directory, createHash('sha256').update(path.resolve(root)).digest('hex') + '.json');
  }
  load(root) {
    const defaults = { version: 1, plugins: defaultPlugins(root), target: { chip: '', elf: '', buildBeforeDebug: false }, build: { executable: '', args: [] } };
    const settings = !root || !existsSync(this.file(root)) ? defaults : this.validate(JSON.parse(readFileSync(this.file(root), 'utf8')));
    if (!settings.plugins.pnx) {
      const found=detectProjectTarget(root);
      settings.target.chip ||= found.chip; settings.target.elf ||= found.elf;
    }
    return settings;
  }
  validate(input) {
    if (!input || typeof input !== 'object') throw new Error('Invalid project settings');
    const target = input.target || {}, build = input.build || {};
    for (const value of [target.chip || '', target.elf || '', build.executable || '']) if (typeof value !== 'string' || value.length > 4096 || /[\0\r\n]/.test(value)) throw new Error('Invalid target or command field');
    if (!Array.isArray(build.args || []) || (build.args || []).length > 128 || (build.args || []).some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Build arguments must be an array of strings');
    return { version: 1, plugins: Object.fromEntries(plugins.map(plugin => [plugin.manifest.id, input.plugins?.[plugin.manifest.id] === true])), target: { chip: (target.chip || '').trim(), elf: (target.elf || '').trim(), buildBeforeDebug: target.buildBeforeDebug === true }, build: { executable: (build.executable || '').trim(), args: build.args || [] } };
  }
  save(root, input) {
    const value = this.validate(input), file = this.file(root);
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(value, null, 2)); renameSync(file + '.tmp', file);
    return value;
  }
}

export function resolveTarget(root, settings, preset, buildDirectory) {
  if (!root) throw new Error('Open a project folder first');
  const plugin = plugins.find(item => settings.plugins[item.manifest.id] && item.detect(root) && item.resolveProjectTarget);
  if (settings.target.chip && settings.target.elf) {
    // Explicit artifacts work without a build preset. Plugin defaults are optional.
    let defaults = {};
    if (plugin && preset) defaults = plugin.resolveProjectTarget(root, preset, buildDirectory);
    return { ...defaults, chip: settings.target.chip, elf: path.resolve(root, settings.target.elf) };
  }
  if (plugin) return plugin.resolveProjectTarget(root, preset, buildDirectory);
  throw new Error('请在目标与插件设置中填写芯片型号及 ELF 路径');
}
