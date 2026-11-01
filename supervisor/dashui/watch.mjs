// Rendering of a job transcript (issue #123). Pure functions, no Node or DOM APIs: the server renders a finished transcript
// with them and the browser appends live entries with the SAME functions, so a replay is identical to the live view.
// Every value goes through esc(); the transcript is already redacted when written.
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const clock = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(11, 19) : '');
const firstLine = s => String(s ?? '').split('\n').find(l => l.trim()) || '';
const evidenceBlock = e => (e.evidence ? `<p class="ev"><span class="badge sev-action">Classifier: ${esc(e.evidence.event)}</span> triggered by <mark>${esc(e.evidence.line)}</mark></p>` : '');

export function renderEntry(e) {
  const cls = `tr tr-${esc(e.kind)}${e.evidence ? ' tr-evidence' : ''}${e.error ? ' tr-error' : ''}`, at = `<time>${esc(clock(e.at))}</time>`;
  const attrs = `data-seq="${Number(e.seq)}"`;
  switch (e.kind) {
    case 'tool_call':
      return `<details class="${cls}" ${attrs}><summary>${at}<b>${esc(e.tool || 'tool')}</b> ${esc(e.text)}</summary>${e.detail ? `<pre>${esc(e.detail)}</pre>` : ''}${evidenceBlock(e)}</details>`;
    case 'tool_result':
      return `<details class="${cls}" ${attrs}><summary>${at}result${e.error ? ' (error)' : ''}: ${esc(firstLine(e.text).slice(0, 160))}</summary><pre>${esc(e.text)}</pre>${evidenceBlock(e)}</details>`;
    case 'usage':
      return `<div class="${cls}" ${attrs}>${at}<span class="sub">tokens +${Number(e.tokens?.in) || 0} in, +${Number(e.tokens?.out) || 0} out</span></div>`;
    case 'assistant':
      return `<div class="${cls}" ${attrs}>${at}<span class="who">Assistant</span><div class="txt">${esc(e.text)}</div>${evidenceBlock(e)}</div>`;
    default:
      return `<div class="${cls}" ${attrs}>${at}<span class="who">${esc(e.kind === 'user' ? 'Prompt' : e.kind === 'truncated' ? 'Notice' : e.stream === 'stderr' ? 'stderr' : 'Provider')}</span><div class="txt">${esc(e.text)}</div>${evidenceBlock(e)}</div>`;
  }
}
export const renderEntries = entries => entries.map(renderEntry).join('');
// Running totals shown beside the transcript: assistant messages, tool calls, tokens in and out.
export function totals(entries) {
  const t = { messages: 0, tools: 0, tokensIn: 0, tokensOut: 0, evidence: 0 };
  for (const e of entries) {
    if (e.kind === 'assistant') t.messages++;
    if (e.kind === 'tool_call') t.tools++;
    if (e.evidence) t.evidence++;
    if (e.tokens) { t.tokensIn += e.tokens.in || 0; t.tokensOut += e.tokens.out || 0; }
  }
  return t;
}
export const fmtElapsed = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
export const renderTotals = t => `${t.messages} messages · ${t.tools} tool calls · ${t.tokensIn.toLocaleString('en-GB')} tokens in · ${t.tokensOut.toLocaleString('en-GB')} out`;
