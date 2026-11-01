// Per-job transcript (issue #123). Jobs run headless, so the provider's stream is the only record of what an agent did.
// Each adapter maps its stream to one schema (`adapter.transcript(line, state)` returns entries); this module redacts them
// BEFORE anything is written, caps the size, keeps the file mode 600 for 7 days, and reads it back for the dashboard.
// The classification-only event log (core.event) is unchanged. Nothing here calls a model or the network.
import fs from 'node:fs';
import path from 'node:path';

export const TRANSCRIPT_RETENTION_MS = 7 * 86400000;
export const TRANSCRIPT_CAP_BYTES = 4 * 1024 * 1024;     // per job; evidence entries may use the reserve below
export const EVIDENCE_RESERVE_BYTES = 64 * 1024;
export const ENTRY_TEXT_MAX = 8000;
export const ENTRY_DETAIL_MAX = 4000;
export const KINDS = ['assistant', 'tool_call', 'tool_result', 'user', 'system', 'log', 'usage', 'truncated'];
const SECRET_NAME = /(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|private[_-]?key|credential|authorization|auth|cookie|session[_-]?id|bearer)/i;

export const transcriptDir = root => path.join(root, 'transcripts');
export const transcriptFile = (root, id) => path.join(transcriptDir(root), `${id}.jsonl`);
export const validJobId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

// Values of environment variables whose NAME looks secret, plus caller-supplied values (seeded canaries in tests), as exact strings.
export function secretValues(env = process.env, extra = []) {
  const out = new Set();
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 6) out.add(v);
  for (const v of extra) if (typeof v === 'string' && v.length >= 4) out.add(v);
  return [...out].sort((a, b) => b.length - a.length);
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Redaction: exact secret values first, then secret shapes, OpenBao paths and tokens, and credential-looking assignments.
export function redactText(value, secrets = []) {
  let s = String(value ?? '');
  for (const v of secrets) s = s.replace(new RegExp(escapeRe(v), 'g'), '[redacted]');
  return s
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:bao|vault|openbao):\/\/\S+/gi, '[redacted openbao path]')
    .replace(/\/v1\/(?:secret|kv|auth|sys|transit|database|pki|cubbyhole|identity|devtest)[\w./-]*/gi, '[redacted openbao path]')
    .replace(/\b(?:secret|kv)\/(?:data|metadata)\/[\w./-]+/gi, '[redacted openbao path]')
    .replace(/\b(?:BAO|VAULT|OPENBAO)_(?:TOKEN|ADDR|NAMESPACE|ROLE_ID|SECRET_ID)\b\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|\S+)/g, '[redacted openbao setting]')
    .replace(/\b(?:hv[sbr]\.|s\.)[A-Za-z0-9_-]{20,}/g, '[redacted openbao token]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted jwt]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-ant-|sk-|xox[abprs]-|glpat-|npm_)[\w-]{8,}/g, '[redacted token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted token]')
    .replace(/\b[Bb]earer\s+[\w.~+/=-]{8,}/g, 'Bearer [redacted]')
    .replace(/("[\w-]*(?:token|secret|passw(?:or)?d|passwd|api[_-]?key|private[_-]?key|credential|authorization|cookie)[\w-]*"\s*:\s*)"(?:[^"\\]|\\.)*"/gi, '$1"[redacted]"')
    .replace(/\b([A-Za-z][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE)[A-Za-z0-9_]*)\s*=\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s"']+)/g, '$1=[redacted]')
    .replace(/\b(?!0{40}\b)(?![0-9a-f]{40}\b)(?![0-9a-f]{64}\b)[A-Za-z0-9+/_-]{40,}={0,2}(?![\w-])/g, '[redacted token]');
}
const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters not recorded]` : s);

// Build the stored form: redacted, bounded, only known fields. `secrets` is the list from secretValues().
export function sanitizeEntry(entry, secrets = []) {
  const kind = KINDS.includes(entry?.kind) ? entry.kind : 'log';
  const out = { kind, text: clip(redactText(entry?.text ?? '', secrets), ENTRY_TEXT_MAX) };
  if (typeof entry?.tool === 'string') out.tool = redactText(entry.tool, secrets).slice(0, 80);
  if (typeof entry?.detail === 'string' && entry.detail) out.detail = clip(redactText(entry.detail, secrets), ENTRY_DETAIL_MAX);
  if (typeof entry?.stream === 'string') out.stream = entry.stream === 'stderr' ? 'stderr' : 'stdout';
  if (entry?.error === true) out.error = true;
  if (entry?.tokens) {
    const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    out.tokens = { in: n(entry.tokens.in), out: n(entry.tokens.out) };
  }
  if (entry?.evidence && typeof entry.evidence.event === 'string')
    out.evidence = { event: entry.evidence.event.replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 48), line: clip(redactText(entry.evidence.line ?? '', secrets), 2000) };
  return out;
}

export class TranscriptWriter {
  constructor(root, jobId, { capBytes = TRANSCRIPT_CAP_BYTES, reserveBytes = EVIDENCE_RESERVE_BYTES, secrets = secretValues(), clock = { now: () => Date.now() } } = {}) {
    if (!validJobId(jobId)) throw new Error('invalid job id for transcript');
    Object.assign(this, { root, jobId, capBytes, reserveBytes, secrets, clock, file: transcriptFile(root, jobId), seq: 0, size: 0, full: false, closed: false });
    fs.mkdirSync(transcriptDir(root), { recursive: true, mode: 0o700 });
    // Later attempts of the same job append: continue the sequence and the size budget.
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      this.size = Buffer.byteLength(text);
      for (const line of text.split('\n')) { try { const e = JSON.parse(line); if (Number.isSafeInteger(e?.seq)) this.seq = Math.max(this.seq, e.seq); if (e?.kind === 'truncated') this.full = true; } catch { /* partial line */ } }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  append(entry) {
    if (this.closed) return null;
    const clean = sanitizeEntry(entry, this.secrets);
    const make = e => JSON.stringify({ v: 1, seq: this.seq + 1, at: this.clock.now(), ...e }) + '\n';
    let line = make(clean);
    const bytes = Buffer.byteLength(line);
    const limit = clean.evidence ? this.capBytes + this.reserveBytes : this.capBytes;
    if (this.full && !clean.evidence) return null;
    if (this.size + bytes > limit) {
      // Truncate cleanly: whole entries only, then one marker. Evidence may still use the reserve.
      if (!this.full) {
        this.full = true;
        const marker = make({ kind: 'truncated', text: `Transcript size cap reached (${Math.round(this.capBytes / 1024)} KiB); later output is not recorded, except the lines that triggered a classified event.` });
        this.write(marker);
      }
      if (!clean.evidence || this.size + bytes > limit) return null;
      line = make(clean);
    }
    this.write(line);
    return JSON.parse(line);
  }
  write(line) {
    fs.appendFileSync(this.file, line, { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* best effort on exotic filesystems */ }
    this.size += Buffer.byteLength(line); this.seq++;
  }
}

// Delete transcripts older than the retention period. Returns the ids removed. Never touches anything but <id>.jsonl files.
export function pruneTranscripts(root, now = Date.now(), retentionMs = TRANSCRIPT_RETENTION_MS) {
  const dir = transcriptDir(root), removed = [];
  let names; try { names = fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return removed; throw error; }
  for (const name of names) {
    const m = /^([a-f0-9]{32})\.jsonl$/.exec(name); if (!m) continue;
    const file = path.join(dir, name);
    try { if (now - fs.statSync(file).mtimeMs > retentionMs) { fs.unlinkSync(file); removed.push(m[1]); } } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return removed;
}
export const transcriptExists = (root, id) => validJobId(id) && fs.existsSync(transcriptFile(root, id));

// Read whole entries starting at a byte offset; a trailing partial line is left for the next read.
export function readTranscript(root, id, { offset = 0, after = 0 } = {}) {
  if (!validJobId(id)) return { entries: [], offset: 0 };
  let fd;
  try { fd = fs.openSync(transcriptFile(root, id), 'r'); } catch (error) { if (error.code === 'ENOENT') return { entries: [], offset: 0, missing: true }; throw error; }
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { entries: [], offset };
    const buf = Buffer.alloc(size - offset); fs.readSync(fd, buf, 0, buf.length, offset);
    const end = buf.lastIndexOf(10) + 1;
    const entries = [];
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (Number.isSafeInteger(e?.seq) && e.seq > after) entries.push(e); } catch { /* a damaged line is skipped */ }
    }
    return { entries, offset: offset + end };
  } finally { fs.closeSync(fd); }
}

// Shared helpers for adapters: one-line summary of a tool input and the first lines of an output.
export const oneLine = (s, max = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };
export function summarizeInput(input) {
  if (input == null) return '';
  if (typeof input === 'string') return oneLine(input);
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt']) if (typeof input[k] === 'string') return oneLine(input[k]);
  return oneLine(JSON.stringify(input));
}
