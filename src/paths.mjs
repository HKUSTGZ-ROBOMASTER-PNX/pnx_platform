import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendName = process.platform === 'win32' ? 'pnx-dap.exe' : 'pnx-dap';
export const BACKEND = existsSync(path.join(ROOT, 'bin', backendName))
  ? path.join(ROOT, 'bin', backendName)
  : path.join(ROOT, 'native', 'target', 'release', backendName);
