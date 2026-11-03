// Anything shown on the page or handed to a job that originates from an error message or free text passes through this.
// Input is capped before any pattern runs: the e-mail rule is quadratic on long unbroken strings (issue #159).
export const MAX_SCAN = 2000;
export const KEY = '(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential)s?';
// Auth scheme words that may precede a credential; the key rule consumes the scheme and the credential together.
const SCHEME = '(?:bearer|basic|token|digest)';
export function redact(value, max = 200) {
  return String(value ?? '').slice(0, MAX_SCAN)
    .replace(new RegExp(`("${KEY}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), '$1"[secret]"')
    .replace(new RegExp(`\\b(${KEY})(\\s*[=:]\\s*)(?!\\[)(?:${SCHEME}\\s+)?[^\\s,;&"']+`, 'gi'), '$1$2[secret]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[userinfo]@')
    .replace(/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/g, '[jwt]')
    .replace(/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/g, '[aws-key]')
    .replace(/\bhv[sbr]\.[\w-]{8,}/g, '[token]')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)[\w-]{8,}/g, '[token]')
    .replace(/\b[Bb]earer\s+[\w.~+/=-]{8,}/g, 'Bearer [token]')
    .replace(/\b(?!0{40}\b)(?![0-9a-f]{40}\b)[A-Za-z0-9_-]{40,}\b/g, '[token]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}
// Long free text (a requirements file) redacted without losing its tail: redact() reads only MAX_SCAN characters, so the text is
// scanned in pieces of at most MAX_SCAN (split at line ends, then at spaces) and rejoined with its line ends. When the result would pass
// `max`, it is cut on a piece boundary (a line end, or a word boundary inside a line longer than MAX_SCAN) and `marker` is appended, so a cut is always visible and never mid-sentence.
export function redactLong(value, max, marker = '') {
  // Each piece is {text, glue}: glue is true when the piece continues the previous one on the same line (rejoined without a newline).
  // A piece must not end inside a secret: a bare or quoted key (with or without its separator), an unfinished bearer, or an open quoted value.
  const tail = new RegExp(`(?:["']?\\b${KEY}["']?\\s*[=:]?\\s*(?:${SCHEME}\\s*)?|\\b${SCHEME}\\s*|"${KEY}"\\s*:\\s*"(?:[^"\\\\]|\\\\.)*)$`, 'i');
  const pieces = [];
  for (const line of String(value ?? '').split(/\r?\n/)) {
    let rest = line, glue = false;
    while (rest.length > MAX_SCAN) {
      let at = rest.lastIndexOf(' ', MAX_SCAN); if (at < 1) at = MAX_SCAN;
      // Never split inside a key/value run: move the split before a trailing "password:" so the key and its value stay in one piece.
      const m = tail.exec(rest.slice(0, at));
      if (m && m.index > 0) at = m.index;
      pieces.push({ text: rest.slice(0, at), glue }); rest = rest.slice(at); glue = true;
    }
    pieces.push({ text: rest, glue });
  }
  const out = []; let used = 0, cut = false;
  for (const p of pieces) {
    const clean = redact(p.text, MAX_SCAN * 4); // replacements can be longer than the text they replace; never slice a piece here
    const add = clean.length + (out.length && !p.glue ? 1 : 0);
    if (used + add > max) { cut = true; break; }
    out.push(out.length ? (p.glue ? '' : '\n') + clean : clean); used += add;
  }
  return cut ? `${out.join('')}\n${marker}` : out.join('');
}
// Host addresses: IPv4 with an optional port (a longer dotted number such as 1.2.3.4.5 is not an address) and IPv6.
export const redactAddresses = s => String(s ?? '')
  .replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\d]|\.\d)/g, '[ip]')
  .replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}(?::[0-9a-f]{1,4}){1,6}(?![\w:])|(?<![\w:]):(?::[0-9a-f]{1,4}){1,7}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}:(?![\w:])/gi, '[ip]');
