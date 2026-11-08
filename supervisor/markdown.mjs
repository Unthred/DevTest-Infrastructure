// A small, safe Markdown renderer for the dashboard (issue #884: an issue draft's body is shown as Markdown when its row is expanded).
// Everything is HTML-escaped first; only a fixed set of tags is produced from the text, never from it. Supported: headings (# to ######),
// paragraphs, bullet and numbered lists, block quotes, fenced code, inline code, bold, italic, and http(s) links. A link never carries
// markup out of the escaped text, and its target must start with http:// or https://. Anything else stays plain text. Pure: no I/O.
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Inline: the input is already escaped. Code spans are lifted out first so their content is not formatted.
const emphasis = t => t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>');
function inline(escaped) {
  const kept = [];   // finished pieces (code, links) are set aside so no later rule can reach inside a tag or an href
  const keep = html => `\u0000${kept.push(html) - 1}\u0000`;
  let t = escaped.replace(/`([^`\n]+)`/g, (m, c) => keep(`<code>${c}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (m, label, url) => keep(`<a href="${url}" rel="noopener noreferrer" target="_blank">${emphasis(label)}</a>`));
  const back = x => x.replace(/\u0000(\d+)\u0000/g, (m, i) => kept[Number(i)]);
  return back(back(emphasis(t)));   // twice: a link label can hold a code span
}

export function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  const out = [];
  let i = 0;
  const isBlank = l => !l.trim();
  const startsBlock = l => /^\s{0,3}(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m;
    if (/^\s{0,3}```/.test(line)) {
      const code = []; i++;
      while (i < lines.length && !/^\s{0,3}```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code"><code>${esc(code.join('\n'))}</code></pre>`);
    } else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      out.push(`<h${m[1].length + 2} class="md-h">${inline(esc(m[2]))}</h${m[1].length + 2}>`); i++;   // h3 to h8 -> kept below the card's own headings
    } else if (/^\s{0,3}>/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) q.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${inline(esc(q.join('\n'))).replace(/\n/g, '<br>')}</blockquote>`);
    } else if (/^\s{0,3}[-*+]\s+/.test(line) || /^\s{0,3}\d+[.)]\s+/.test(line)) {
      const ordered = /^\s{0,3}\d+[.)]\s+/.test(line), re = ordered ? /^\s{0,3}\d+[.)]\s+/ : /^\s{0,3}[-*+]\s+/, items = [];
      while (i < lines.length && re.test(lines[i])) {
        let item = lines[i++].replace(re, '');
        while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i]) && /^\s{2,}/.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(`<li>${inline(esc(item))}</li>`);
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
    } else {
      const p = [];
      while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) p.push(lines[i++]);
      if (!p.length) { p.push(lines[i++]); }
      out.push(`<p>${inline(esc(p.join('\n'))).replace(/\n/g, '<br>')}</p>`);
    }
  }
  return out.join('');
}
