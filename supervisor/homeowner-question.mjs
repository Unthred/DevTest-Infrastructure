// Issue #414: the one question an issue puts to the homeowner, read from a line that starts with a marker such as
// "Decision first:", "Homeowner question:" or "Question:". Returns { question, yes, no } or null. `yes` and `no` are the
// stated effects of each answer ("Yes: ... No: ...") and null when the issue does not state them. Pure; the text is redacted by the caller.
const MARK = /^[\s>*_#-]*(?:homeowner question|question for the homeowner|decision first|decision needed|decision for the homeowner|question)\s*[.:]\s*(.+)$/i;
export function homeownerQuestion(body) {
  for (const raw of String(body || '').split('\n')) {
    const m = MARK.exec(raw.replace(/\*\*|__/g, ''));
    if (!m) continue;
    const text = m[1].trim(), y = /\bYes:\s*/.exec(text), n = /\bNo:\s*/.exec(text);
    const head = text.slice(0, Math.min(...[y?.index, n?.index].filter(Number.isInteger), text.length)).trim();
    const q = /^[^?]*\?/.exec(head)?.[0].trim();
    if (!q || q.length < 12) continue;
    const effect = (a, b) => { if (!a) return null; const from = a.index + a[0].length, to = b && b.index > a.index ? b.index : text.length; return text.slice(from, to).trim().slice(0, 200) || null; };
    return { question: q.slice(0, 280), yes: effect(y, n), no: effect(n, y) };
  }
  return null;
}
