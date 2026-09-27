// Textarea editing commands. Keep this independent of the DOM so selections can be tested.
window.editCodeSelection = function editCodeSelection(text, start, end, command, path = '') {
  const selected = start !== end;
  const first = text.lastIndexOf('\n', start - 1) + 1;
  const lastPosition = selected && text[end - 1] === '\n' ? end - 1 : end;
  const last = text.indexOf('\n', lastPosition);
  const limit = last < 0 ? text.length : last;

  if (command === 'indent' && !selected) {
    return { text: text.slice(0, start) + '    ' + text.slice(end), start: start + 4, end: start + 4 };
  }

  const extension = path.split('.').at(-1).toLowerCase();
  const marker = ['py', 'sh', 'bash', 'yml', 'yaml', 'toml', 'cmake'].includes(extension) || /(?:^|\/)CMakeLists\.txt$/i.test(path)
    ? '#' : ['sql'].includes(extension) ? '--' : '//';
  const lines = text.slice(first, limit).split('\n');
  const allCommented = command === 'comment' && lines.filter(line => line.trim()).every(line => line.trimStart().startsWith(marker));
  let cursorDelta = 0;
  const changed = lines.map((line, index) => {
    const offset = line.match(/^[ \t]*/)[0].length;
    let next = line;
    if (command === 'indent') next = '    ' + line;
    else if (command === 'outdent') {
      const count = line.startsWith('\t') ? 1 : Math.min(4, line.match(/^ */)[0].length);
      next = line.slice(count);
    } else if (command === 'comment' && (line.trim() || !selected)) {
      if (allCommented) {
        const rest = line.slice(offset + marker.length);
        next = line.slice(0, offset) + (rest.startsWith(' ') ? rest.slice(1) : rest);
      } else next = line.slice(0, offset) + marker + ' ' + line.slice(offset);
    }
    if (index === 0) cursorDelta = next.length - line.length;
    return next;
  });
  const replacement = changed.join('\n');
  const updated = text.slice(0, first) + replacement + text.slice(limit);
  if (selected) return { text: updated, start: first, end: first + replacement.length };
  const cursor = Math.max(first, Math.min(first + changed[0].length, start + cursorDelta));
  return { text: updated, start: cursor, end: cursor };
};
