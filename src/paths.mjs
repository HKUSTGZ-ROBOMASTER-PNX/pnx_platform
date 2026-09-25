import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TEMPLATE = process.env.PNX_TEMPLATE_ROOT ? path.resolve(process.env.PNX_TEMPLATE_ROOT) : path.resolve(ROOT, '..', 'pnx_template');
export const CORTEX = path.resolve(ROOT, '..', 'cortex-kit');
const backendName = process.platform === 'win32' ? 'cortex-kit-dap.exe' : 'cortex-kit-dap';
export const BACKEND = existsSync(path.join(ROOT, 'bin', backendName))
  ? path.join(ROOT, 'bin', backendName)
  : path.join(CORTEX, 'extension', 'bin', backendName);
export const BOARDS = {
  h723_mc02: { chip: 'STM32H723VG', presets: ['h723-debug', 'h723-release'] },
  f407_c_board: { chip: 'STM32F407IG', presets: ['f407-debug', 'f407-release'] },
};

export function boardPaths(board, root = TEMPLATE) {
  if (!Object.hasOwn(BOARDS, board)) throw new Error(`Unknown board: ${board}`);
  const base = path.join(root, 'configs', 'boards', board);
  return { params: path.join(base, 'params.json'), robot: path.join(base, 'robot.json') };
}

export function presetBoard(preset) {
  for (const [board, spec] of Object.entries(BOARDS)) if (spec.presets.includes(preset)) return board;
  throw new Error(`Unknown preset: ${preset}`);
}
