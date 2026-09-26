// Local, non-executing Markdown preview. Raw HTML is displayed as text.
(function () {
  const esc = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function inline(source) {
    const saved = [];
    const hold = html => `\u0000${saved.push(html)-1}\u0000`;
    let text = esc(source).replace(/`([^`]+)`/g, (_, value) => hold(`<code>${value}</code>`));
    text = text.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => /^https?:\/\//i.test(url) ? hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`) : label);
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/~~(.+?)~~/g, '<del>$1</del>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return text.replace(/\u0000(\d+)\u0000/g, (_, i) => saved[Number(i)]);
  }
  window.renderMarkdown = source => {
    const lines = source.replace(/\r\n?/g, '\n').split('\n'); let out = '', list = '';
    const close = () => { if (list) { out += `</${list}>`; list = ''; } };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]; let match;
      if ((match = line.match(/^\s*(`{3,}|~{3,})(.*)$/))) {
        close(); const fence = match[1], code = [];
        while (++i < lines.length && !new RegExp(`^\\s*${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) code.push(lines[i]);
        out += `<pre><code>${esc(code.join('\n'))}</code></pre>`;
      } else if ((match = line.match(/^(#{1,6})\s+(.+?)\s*#*$/))) { close(); out += `<h${match[1].length}>${inline(match[2])}</h${match[1].length}>`; }
      else if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { close(); out += '<hr>'; }
      else if ((match = line.match(/^\s*(?:([-+*])|\d+\.)\s+(.+)$/))) { const tag = match[1] ? 'ul' : 'ol'; if (list !== tag) { close(); list = tag; out += `<${tag}>`; } out += `<li>${inline(match[2])}</li>`; }
      else if (/^>\s?/.test(line)) { close(); out += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; }
      else if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[i+1] || '')) {
        close(); const cells = row => row.trim().replace(/^\||\|$/g, '').split('|');
        out += '<table><thead><tr>' + cells(line).map(c => `<th>${inline(c.trim())}</th>`).join('') + '</tr></thead><tbody>'; i++;
        while (i+1 < lines.length && lines[i+1].includes('|') && lines[i+1].trim()) out += '<tr>' + cells(lines[++i]).map(c => `<td>${inline(c.trim())}</td>`).join('') + '</tr>';
        out += '</tbody></table>';
      } else { close(); if (line.trim()) out += `<p>${inline(line)}</p>`; }
    }
    close(); return out;
  };
})();
