import path from 'node:path';
import { existsSync } from 'node:fs';
export const manifest = { id: 'pnx', name: 'PnX Framework', apiVersion: 1, capabilities: ['configuration', 'board-detection', 'diagnostics'] };
export const detect = root => !!root && existsSync(path.join(root, 'CMakePresets.json')) && existsSync(path.join(root, 'configs', 'boards'));
export const BOARDS = {
  h723_mc02: { chip: 'STM32H723VG', presets: ['h723-debug', 'h723-release'] },
  f407_c_board: { chip: 'STM32F407IG', presets: ['f407-debug', 'f407-release'] },
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
  return { board, chip: BOARDS[board].chip, elf: path.join(buildDirectory(preset), 'pnx_embedded.elf') };
}
