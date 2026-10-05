import { existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const WATCH_FILE = 'pnx-watch.json';
export function validateWatchConfig(value) {
  const fail = () => { throw new Error('无效的 PnX 变量查看配置（需要 version: 1）'); };
  const text = v => typeof v === 'string' && v.length > 0 && v.length <= 1024;
  if (value?.format !== 'pnx-watch' || value.version !== 1) fail();
  if (!Array.isArray(value.groups) || !value.groups.length || value.groups.length > 256 ||
      !Array.isArray(value.plots) || !value.plots.length || value.plots.length > 1024 ||
      !Array.isArray(value.variables) || value.variables.length > 100000) fail();
  const groups = value.groups.map(g => { if (!text(g.id) || !text(g.name)) fail(); return {id:g.id,name:g.name}; });
  const groupIds = new Set(groups.map(g => g.id));
  if (groupIds.size !== groups.length) fail();
  const plots = value.plots.map(p => {
    if (!text(p.id) || p.id === 'watch-only' || !text(p.name) || !groupIds.has(p.groupId) || !Number.isFinite(p.seconds) || p.seconds < .1 || p.seconds > 120) fail();
    return {id:p.id,name:p.name,groupId:p.groupId,seconds:p.seconds};
  });
  const plotIds = new Set(plots.map(p => p.id));
  if (plotIds.size !== plots.length || !groupIds.has(value.activeGroup) || ![1,2,3].includes(value.columns) || !Number.isFinite(value.seconds) || value.seconds < .1 || value.seconds > 120 || !Number.isFinite(value.rate) || value.rate < 1 || value.rate > 100000) fail();
  const variables = value.variables.map(v => {
    if (!text(v.expression) || (v.plotId !== 'watch-only' && !plotIds.has(v.plotId)) ||
        (v.color !== undefined && (typeof v.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(v.color)))) fail();
    return {...(v.color === undefined ? {} : {color:v.color.toLowerCase()}),expression:v.expression,plotId:v.plotId};
  });
  if (new Set(variables.map(v => v.expression)).size !== variables.length) fail();
  let capture;
  if (value.capture !== undefined) {
    if (!Array.isArray(value.capture?.excluded) || value.capture.excluded.length > 100000 || value.capture.excluded.some(v => !text(v)) ||
        !['sample_index','elapsed_s','timestamp_ns'].includes(value.capture.timeColumn)) fail();
    if (value.capture.sampleExcluded !== undefined && (!Array.isArray(value.capture.sampleExcluded) || value.capture.sampleExcluded.length > 100000 || value.capture.sampleExcluded.some(v => !text(v)))) fail();
    capture = {excluded:[...new Set(value.capture.excluded)],timeColumn:value.capture.timeColumn,...(value.capture.sampleExcluded ? {sampleExcluded:[...new Set(value.capture.sampleExcluded)]} : {})};
  }
  return {format:'pnx-watch',version:1,groups,plots,variables,activeGroup:value.activeGroup,columns:value.columns,seconds:value.seconds,rate:value.rate,...(capture ? {capture} : {})};
}
export function loadWatchConfig(workspace) {
  if (!workspace.root) throw new Error('请先打开工程文件夹');
  if (!existsSync(path.join(workspace.root, WATCH_FILE))) return null;
  return validateWatchConfig(JSON.parse(workspace.read(WATCH_FILE).text));
}
export function saveWatchConfig(workspace, value) {
  if (!workspace.root) throw new Error('请先打开工程文件夹');
  const config = validateWatchConfig(value);
  const target = path.join(workspace.root, WATCH_FILE);
  if (existsSync(target)) workspace.resolve(WATCH_FILE);
  const text = JSON.stringify(config, null, 2) + '\n';
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('查看配置超过 2 MiB');
  const temp = path.join(workspace.root, `.pnx-watch-${randomBytes(8).toString('hex')}.tmp`);
  try { writeFileSync(temp,text,{flag:'wx'}); renameSync(temp,target); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
  return {path:target,config};
}
