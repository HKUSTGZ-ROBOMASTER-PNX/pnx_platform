import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/workspace.mjs';
import { definitionsInText, findDefinitions } from '../src/symbols.mjs';

test('definition scan skips calls and comments and ranks function bodies before declarations', () => {
  const source = [
    '// void drive() {}',
    'void drive();',
    'void drive() {',
    '  drive();',
    '}',
    '#define DRIVE_LIMIT 10',
    'struct Motor { int speed; };',
  ].join('\n');
  assert.deepEqual(definitionsInText(source, 'drive', 'motor.cpp').map(item => [item.line, item.kind]), [
    [2, '函数声明'], [3, '函数定义'],
  ]);
  assert.equal(definitionsInText(source, 'DRIVE_LIMIT', 'motor.cpp')[0].kind, '宏');
  assert.equal(definitionsInText(source, 'Motor', 'motor.cpp')[0].kind, '类型');
});

test('workspace lookup searches source files and uses unsaved editor text', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pnx-definitions-'));
  mkdirSync(path.join(root, 'build'));
  writeFileSync(path.join(root, 'main.cpp'), 'void app_start() {\n  drive();\n}\n');
  writeFileSync(path.join(root, 'motor.cpp'), 'void drive() {}\n');
  writeFileSync(path.join(root, 'build', 'generated.cpp'), 'void drive() {}\n');
  const found = await findDefinitions(new Workspace(root), 'drive', { 'motor.cpp': 'void drive() {\n  int speed = 0;\n}\n' });
  assert.equal(found.length, 1);
  assert.equal(found[0].path, 'motor.cpp');
  assert.equal(found[0].kind, '函数定义');
  assert.equal(found[0].preview, 'void drive() {');
});

test('qualified lookup keeps methods in their owning class and namespace', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pnx-qualified-'));
  writeFileSync(path.join(root, 'motor.cpp'), 'namespace pnx {\nclass Motor {\nvoid run();\n};\nvoid Motor::run() {}\n}\nnamespace other {\nvoid Motor::run() {}\n}\nvoid run() {}');
  const workspace = new Workspace(root);
  const found = await findDefinitions(workspace, 'pnx::Motor::run');
  assert.equal(found.length, 2);
  assert.ok(found.every(item => item.qualifiedName === 'pnx::Motor::run'));
  assert.equal(found[0].kind, '函数定义');
  assert.equal((await findDefinitions(workspace, 'Missing::run')).length, 0);
  assert.equal((await findDefinitions(workspace, '::run')).length, 1);
});
