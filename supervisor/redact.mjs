// Anything shown on the page or handed to a job that originates from an error message or free text passes through this.
// Input is capped before any pattern runs: the e-mail rule is quadratic on long unbroken strings (issue #159).
export const MAX_SCAN = 2000;
const KEY = '(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential)s?';
export function redact(value, max = 200) {
  return String(value ?? '').slice(0, MAX_SCAN)
    .replace(new RegExp(`("${KEY}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'), '$1"[secret]"')
    .replace(new RegExp(`\\b(${KEY})(\\s*[=:]\\s*)(?!\\[)(?:bearer\\s+)?[^\\s,;&"']+`, 'gi'), '$1$2[secret]')
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
// Host addresses: IPv4 with an optional port (a longer dotted number such as 1.2.3.4.5 is not an address) and IPv6.
export const redactAddresses = s => String(s ?? '')
  .replace(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\d]|\.\d)/g, '[ip]')
  .replace(/(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,6}(?::[0-9a-f]{1,4}){1,6}(?![\w:])|(?<![\w:]):(?::[0-9a-f]{1,4}){1,7}(?![\w:])|(?<![\w:])(?:[0-9a-f]{1,4}:){1,7}:(?![\w:])/gi, '[ip]');
