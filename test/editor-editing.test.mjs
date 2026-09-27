import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const window = {};
runInNewContext(readFileSync(new URL('../web/editor-editing.js', import.meta.url), 'utf8'), { window });
const edit = window.editCodeSelection;

test('Tab inserts spaces at the cursor and selected lines can be indented and outdented', () => {
  assert.deepEqual({ ...edit('ab', 1, 1, 'indent') }, { text: 'a    b', start: 5, end: 5 });
  const source = 'one\ntwo\nthree';
  const indented = edit(source, 0, 8, 'indent');
  assert.equal(indented.text, '    one\n    two\nthree');
  assert.equal(indented.end, 15);
  assert.equal(edit(indented.text, 0, 15, 'outdent').text, source);
  assert.equal(edit('  a', 2, 2, 'outdent').text, 'a');
});

test('Ctrl+/ toggles whole C lines and selected blocks without including a trailing line', () => {
  const source = '  first\n  second\nthird';
  const commented = edit(source, 3, 17, 'comment', 'main.cpp');
  assert.equal(commented.text, '  // first\n  // second\nthird');
  assert.equal(edit(commented.text, commented.start, commented.end, 'comment', 'main.cpp').text, source);
  assert.equal(edit('value\nnext', 0, 6, 'comment', 'main.c').text, '// value\nnext');
  assert.equal(edit('  value', 4, 4, 'comment', 'main.c').text, '  // value');
});

test('line comments use the file syntax and preserve blank lines and CRLF', () => {
  const source = 'a\r\n\r\nb';
  assert.equal(edit(source, 0, source.length, 'comment', 'main.py').text, '# a\r\n\r\n# b');
  assert.equal(edit('set(X 1)', 0, 0, 'comment', 'CMakeLists.txt').text, '# set(X 1)');
});
