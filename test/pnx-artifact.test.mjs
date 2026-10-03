import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveProjectTarget } from '../src/plugins/pnx/project.mjs';

test('PnX target rejects stale ELF and configuration inputs', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pnx-artifact-'));
  const put = (name, data) => {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, data);
    return createHash('sha256').update(data).digest('hex');
  };
  try {
    const inputs = {
      ioc: put('boards/h723_mc02/h723_mc02.ioc', 'ioc'),
      board: put('boards/h723_mc02/board.json', '{}'),
      params: put('configs/boards/h723_mc02/params.json', '{}'),
      robot: put('configs/boards/h723_mc02/robot.json', '{}'),
      defaults: put('configs/defaults.json', '{}'),
      bspManifest: put('pnx_bsp/bsp/target.cmake', 'family'),
    };
    const build = path.join(root, 'build', 'h723-diagnose');
    const elfHash = put('build/h723-diagnose/pnx_diagnose.elf', 'firmware');
    const manifest = { formatVersion: 1, board: 'h723_mc02', mcuFamily: 'stm32h7', firmwareKind: 'diagnose', preset: 'h723-diagnose',
      elf: { file: 'pnx_diagnose.elf', sha256: elfHash }, inputs };
    const manifestFile = path.join(build, 'pnx-artifact.json');
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const target = () => resolveProjectTarget(root, 'h723-diagnose', () => build);
    assert.equal(target().firmwareKind, 'diagnose');
    put('configs/boards/h723_mc02/params.json', '{"changed":true}');
    assert.throws(target, /不一致/);
    put('configs/boards/h723_mc02/params.json', '{}');
    put('build/h723-diagnose/pnx_diagnose.elf', 'different firmware');
    assert.throws(target, /不一致/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
