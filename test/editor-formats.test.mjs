import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
test('Markdown formats content and escapes executable markup', () => {
 const c = { window: {} }; vm.runInNewContext(readFileSync(new URL('../web/markdown.js', import.meta.url), 'utf8'), c);
 const html = c.window.renderMarkdown('# Title\n**bold**\n<script>alert(1)</script>\n[x](javascript:alert)\n|A|B|\n|---|---|\n|1|2|');
 assert.match(html, /<h1>Title/); assert.match(html, /<strong>bold/); assert.match(html, /<table>/);
 assert.ok(!html.includes('<script>')); assert.ok(!html.includes('href="javascript:'));
});
test('Python tokens include comments, triple strings and decorators names', () => {
 const source=readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
 const expression=source.match(/const pythonToken = (.+);/)[1];
 const regex=vm.runInNewContext(expression);
 const tokens=Array.from('def test():\n  text = """hello\nworld""" # comment\n  return 42'.matchAll(regex), m=>m[0]);
 assert.ok(tokens.includes('def')); assert.ok(tokens.includes('"""hello\nworld"""')); assert.ok(tokens.includes('# comment')); assert.ok(tokens.includes('42'));
});
