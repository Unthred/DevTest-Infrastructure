// Redaction of secret-shaped text, applied to every tool result and every logged argument (D-008). Pure; no I/O.
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted token]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{12,}/gi, '$1 [redacted]'],
  [/(\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1[redacted]@'],
  [/(["']?\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)["']?\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/gi, '$1[redacted]'],
  [/(--(?:password|token|secret|api-key)[= ])\S+/gi, '$1[redacted]'],
];
export function redact(text) {
  let out = String(text ?? '');
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}
// Applies redact() to every string inside a JSON-like value (keys are kept).
export function redactDeep(value, depth = 0) {
  if (depth > 12) return '[too deep]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /^(password|passwd|secret|token|apikey|api_key|authorization)$/i.test(k) ? '[redacted]' : redactDeep(v, depth + 1)]));
  return value;
}
