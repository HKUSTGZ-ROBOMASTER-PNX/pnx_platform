import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const manifest = { id: 'pnx', name: 'PnX Framework', apiVersion: 1, capabilities: ['configuration', 'board-detection', 'diagnostics'] };
export const detect = root => !!root && existsSync(path.join(root, 'CMakePresets.json')) && existsSync(path.join(root, 'configs', 'boards'));
export const BOARDS = {
  h723_mc02: { chip: 'STM32H723VG', presets: ['h723-debug', 'h723-release', 'h723-diagnose'] },
  f407_c_board: { chip: 'STM32F407IG', presets: ['f407-debug', 'f407-release', 'f407-diagnose'] },
};

export function boardPaths(board, root) {
  if (!Object.hasOwn(BOARDS, board)) throw new Error(`Unknown board: ${board}`);
  if (!root) throw new Error('Open a PnX project folder first');
  const base = path.join(root, 'configs', 'boards', board);
  return { params: path.join(base, 'params.json'), robot: path.join(base, 'robot.json') };
}

export function presetBoard(preset) {
  for (const [board, spec] of Object.entries(BOARDS)) if (spec.presets.includes(preset)) return board;
  throw new Error(`Unknown preset: ${preset}`);
}

export function resolveProjectTarget(root, preset, buildDirectory) {
  const board = presetBoard(preset);
  const expectedFamily = board === 'h723_mc02' ? 'stm32h7' : 'stm32f4';
  const buildDir = buildDirectory(preset);
  const kind = preset.endsWith('-diagnose') ? 'diagnose' : 'app';
  const elf = path.join(buildDir, kind === 'diagnose' ? 'pnx_diagnose.elf' : 'pnx_embedded.elf');
  const manifestFile = path.join(buildDir, 'pnx-artifact.json');
  if (existsSync(manifestFile)) {
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
    const inputs = {
      ioc: path.join(root, 'boards', board, `${board}.ioc`),
      board: path.join(root, 'boards', board, 'board.json'),
      params: path.join(root, 'configs', 'boards', board, 'params.json'),
      robot: path.join(root, 'configs', 'boards', board, 'robot.json'),
      defaults: path.join(root, 'configs', 'defaults.json'),
      bspManifest: path.join(root, 'pnx_bsp', 'bsp', 'target.cmake'),
    };
    if (manifest.formatVersion !== 1 || manifest.board !== board || manifest.mcuFamily !== expectedFamily || manifest.firmwareKind !== kind ||
        (manifest.preset && manifest.preset !== preset) ||
        manifest.elf?.file !== path.basename(elf) || !existsSync(elf) || manifest.elf.sha256 !== sha(elf) ||
        Object.entries(inputs).some(([key, file]) => !existsSync(file) || manifest.inputs?.[key] !== sha(file))) {
      throw new Error('PnX 构建产物与当前配置或 ELF 不一致，请重新配置并编译');
    }
  } else if (kind === 'diagnose') {
    throw new Error('缺少诊断固件产物身份文件，请先编译诊断 preset');
  }
  return { board, chip: BOARDS[board].chip, elf, firmwareKind: kind };
}
