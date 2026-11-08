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

// A name is secret-named when it contains a long credential word anywhere (any case, camelCase or snake_case), has a short
// credential word as a whole segment (DB_PASS, HA_PW, X_AUTH; not BYPASS, GIT_AUTHOR_NAME or PWD alone), or ends in `_key`/`Key`
// after another segment (MY_SERVICE_KEY, apiKey). One definition for `NAME=value`, `name: value`, `--flag value`, JSON fields
// and the environment values below, so the forms cannot drift apart.
const LONG_SECRET_WORD = /passw(?:or)?d|passphrase|secret|token|api_?key|private_?key|access_?key|credential|cookie|session_?id|authorization|bearer/;
const SHORT_SECRET_SEGMENT = new Set(['pass', 'pwd', 'pw', 'auth']);
export function isSecretName(name) {
  const bare = String(name ?? '').replace(/^-+/, '');
  if (!bare || /^(?:old)?pwd$/i.test(bare)) return false;   // the shell's working directory
  const segments = bare.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/).filter(Boolean);
  if (LONG_SECRET_WORD.test(segments.join('_'))) return true;
  if (segments.some(s => SHORT_SECRET_SEGMENT.has(s))) return true;
  return segments.length > 1 && segments[segments.length - 1] === 'key';
}

export const transcriptDir = root => path.join(root, 'transcripts');
export const transcriptFile = (root, id) => path.join(transcriptDir(root), `${id}.jsonl`);
export const validJobId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

// Values of environment variables whose NAME looks secret, plus caller-supplied values (seeded canaries in tests), as exact strings.
export function secretValues(env = process.env, extra = []) {
  const out = new Set();
  for (const [k, v] of Object.entries(env)) if (isSecretName(k) && typeof v === 'string' && v.length >= 6) out.add(v);
  for (const v of extra) if (typeof v === 'string' && v.length >= 4) out.add(v);
  return [...out].sort((a, b) => b.length - a.length);
}
// `bao|vault kv get` / `read` print a Key/Value table: every value row after the header is a secret, whatever its key is called.
const KV_TABLE = /(^[ \t]*Key[ \t]+Value[ \t]*\r?\n[ \t]*-{2,}[ \t]+-{2,}[ \t]*\r?\n)((?:[ \t]*\S+[ \t]+[^\r\n]*(?:\r?\n|$))+)/gm;
// A tool call whose output is a secret with no shape to match: an OpenBao/Vault CLI read or login, an OpenBao HTTP API call (path
// or token header), a delivered secret file (/secrets/, /run/secrets/, D-022), a credentials file, or printing a secret-named
// variable. Its result is dropped whole by the writer.
const SECRET_READ = [
  /\b(?:bao|vault|openbao)\b[^\n]*?(?:\bkv\s+get\b|\bread\b|\btoken\s+(?:lookup|create)\b|\blogin\b|\s-field\b)/i,
  /\/v1\/(?:secret|kv|auth|sys|cubbyhole|identity|transit|database|pki|devtest)\b/i,
  /\bX-(?:Vault|Bao)-Token\b|\$\{?(?:BAO|VAULT|OPENBAO)_TOKEN\b/i,
  /(?:^|[\s'"=:(<])(?:\/var)?(?:\/run)?\/secrets\//,
  /(?:^|[\s'"\/=<])(?:\.env(?:\.[\w-]+)?|secrets\.ya?ml|\.netrc|\.git-credentials|credentials(?:\.json)?|[\w.-]+\.(?:token|secret))(?=$|[\s'"|;&)>])/,
];
export function isSecretRead(value) {
  const text = String(value ?? '');
  if (SECRET_READ.some(re => re.test(text))) return true;
  for (const m of text.matchAll(/\bprintenv\b([^\n|;&]*)/g)) if (m[1].trim().split(/\s+/).some(isSecretName)) return true;
  for (const m of text.matchAll(/\b(?:echo|printf)\b[^\n|;&]*/g)) for (const v of m[0].matchAll(/\$\{?([A-Za-z_]\w*)/g)) if (isSecretName(v[1])) return true;
  return false;
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Secret-named pairs, one scanner for every form: NAME=value, name = value, export name=value, ?access_token=value, name: value
// (YAML, HTTP headers such as Cookie, Set-Cookie, X-Api-Key), "name": "value", \"name\":\"value\" (escaped JSON in a raw stream
// line) and --flag value / --flag=value. A key is found once, then its value is consumed by form; the name test is isSecretName.
// Linear: a key cannot start inside another word, and the value is read with sticky expressions from the end of the separator.
const PAIR_KEY = /(?<![\w.-])(\\?["']?)(-{0,2}[A-Za-z_][\w.-]*)\1([ \t]*[=:][ \t]*|[ \t]+)/g;
const QUOTED = [[/\\"(?:[^\\\n]|\\(?!"))*\\"/y, '\\"[redacted]\\"'], [/"(?:[^"\\\n]|\\.)*"/y, '"[redacted]"'], [/'[^'\n]*'/y, "'[redacted]'"]];
const sticky = (re, s, i) => { re.lastIndex = i; const m = re.exec(s); return m ? m[0] : ''; };
function redactPairs(s) {
  let out = '', last = 0, m;
  PAIR_KEY.lastIndex = 0;
  while ((m = PAIR_KEY.exec(s))) {
    const [whole, quote, key, sep] = m, at = m.index + whole.length;
    const flag = key.startsWith('-'), colon = sep.includes(':'), eq = sep.includes('=');
    if ((!colon && !eq && !flag) || !isSecretName(key) || s[at] === '=' || s.startsWith('[redacted', at)) continue;
    let value = '', replacement = '[redacted]';
    for (const [re, rep] of QUOTED) if ((value = sticky(re, s, at))) { replacement = rep; break; }
    if (!value) {
      const before = s[m.index - 1];
      if (flag && !colon && !eq) value = sticky(/(?!-)[^\s"'`]+/y, s, at);       // --flag value
      else if (colon && quote) value = sticky(/[^\s,}\]]+/y, s, at);             // "name": 123 in JSON
      else if (colon && (before === '"' || before === "'")) value = sticky(before === '"' ? /[^\r\n"]+/y : /[^\r\n']+/y, s, at); // -H 'X-Api-Key: v'
      else if (colon) value = sticky(/[^\r\n]*[^\s]/y, s, at);                   // name: value: the rest of the line
      else value = sticky(/[^\s"'`]+/y, s, at);                                 // NAME=value
    }
    if (!value || (/tokens$/i.test(key) && /^\d[\d,._]*$/.test(value))) continue; // input_tokens: 1234 is a count
    out += s.slice(last, at) + replacement; last = at + value.length; PAIR_KEY.lastIndex = last;
  }
  return out + s.slice(last);
}
// A long base64/url-safe run is redacted as a token, but not a path (/mnt/user/..., ./x, ~/x), a Git SHA, or an identifier made of
// letters only or digits only; a random token mixes letters and digits.
const LONG_RUN = /(?<![A-Za-z0-9+/_=-])(?![0-9a-f]{40}\b)(?![0-9a-f]{64}\b)[A-Za-z0-9+/_-]{40,}={0,2}(?![\w-])/g;
const isPath = run => run.startsWith('/') && !/[+=]/.test(run) && run.split('/').every(p => p.length < 40);
const longRun = run => (isPath(run) || !/\d/.test(run) || !/[A-Za-z]/.test(run) ? run : '[redacted token]');

// Redaction: exact secret values first (also in their JSON-escaped form, as they appear in a raw stream line), then secret shapes,
// OpenBao paths and tokens, credential headers and secret-named pairs.
export function redactText(value, secrets = []) {
  let s = String(value ?? '');
  for (const v of secrets) for (const form of new Set([v, JSON.stringify(v).slice(1, -1)])) s = s.replace(new RegExp(escapeRe(form), 'g'), '[redacted]');
  s = s
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(?:bao|vault|openbao):\/\/\S+/gi, '[redacted openbao path]')
    .replace(/\/v1\/(?:secret|kv|auth|sys|transit|database|pki|cubbyhole|identity|devtest)[\w./-]*/gi, '[redacted openbao path]')
    .replace(/\b(?:secret|kv)\/(?:data|metadata)\/[\w./-]+/gi, '[redacted openbao path]')
    .replace(/\b(?:BAO|VAULT|OPENBAO)_(?:TOKEN|ADDR|NAMESPACE|ROLE_ID|SECRET_ID)\b\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|\S+)/g, '[redacted openbao setting]')
    .replace(/\b(?:hv[sbr]\.|s\.)[A-Za-z0-9_-]{20,}/g, '[redacted openbao token]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[redacted jwt]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-ant-|sk-|xox[abprs]-|glpat-|npm_)[\w-]{8,}/g, '[redacted token]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted token]')
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1[redacted]@')
    .replace(/\b((?:proxy-)?authorization["']?\s*[:=]\s*)(?:Digest\s+[^\r\n]*|[^\s"'\r\n]+(?:[ \t]+[^\s"'\r\n]+)?)/gi, '$1[redacted]')
    .replace(/\b[Bb]earer\s+[\w.~+/=-]{8,}/g, 'Bearer [redacted]')
    .replace(KV_TABLE, (_m, head, rows) => head + rows.replace(/^([ \t]*\S+[ \t]+)[^\r\n]*/gm, '$1[redacted]'))
    .replace(/\b(mysql\w*|mariadb[\w-]*)\b([^\n]{0,400}?[ \t])-p(?=[^\s-])[^\s'"]+/gi, '$1$2-p[redacted]')                // mysql -pVALUE
    .replace(/((?:^|[ \t])(?:-u|--user)(?:[ \t]+|=)["']?)([^\s:"'@]+):[^\s"'@]+/g, '$1$2:[redacted]');           // curl -u user:VALUE
  return redactPairs(s).replace(LONG_RUN, longRun);
}
const clip = (s, max) => (s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters not recorded]` : s);
// Redact only what can be stored: cut well past the limit first (dropping a partial word at the cut, so no half secret is left
// for the patterns to miss), redact, then clip. Bounds the work per field whatever the input length.
function redactClip(value, max, secrets) {
  const s = String(value ?? ''), cut = max + 1024;
  if (s.length <= cut) return clip(redactText(s, secrets), max);
  const r = redactText(s.slice(0, cut).replace(/\S*$/, ''), secrets);
  return `${r.slice(0, max)}… [${s.length - Math.min(r.length, max)} more characters not recorded]`;
}

// Build the stored form: redacted, bounded, only known fields. `secrets` is the list from secretValues().
export function sanitizeEntry(entry, secrets = []) {
  const kind = KINDS.includes(entry?.kind) ? entry.kind : 'log';
  const out = { kind, text: redactClip(entry?.text ?? '', ENTRY_TEXT_MAX, secrets) };
  if (typeof entry?.callId === 'string' && entry.callId) out.callId = entry.callId.replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 80);   // issue #1084: pairs a result with its call
  if (typeof entry?.tool === 'string') out.tool = redactText(entry.tool, secrets).slice(0, 80);
  if (typeof entry?.detail === 'string' && entry.detail) out.detail = redactClip(entry.detail, ENTRY_DETAIL_MAX, secrets);
  if (typeof entry?.stream === 'string') out.stream = entry.stream === 'stderr' ? 'stderr' : 'stdout';
  if (entry?.error === true) out.error = true;
  if (entry?.tokens) {
    const n = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    out.tokens = { in: n(entry.tokens.in), out: n(entry.tokens.out) };
  }
  if (entry?.evidence && typeof entry.evidence.event === 'string')
    out.evidence = { event: entry.evidence.event.replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 48), line: redactClip(entry.evidence.line ?? '', 2000, secrets) };
  return out;
}

export class TranscriptWriter {
  constructor(root, jobId, { capBytes = TRANSCRIPT_CAP_BYTES, reserveBytes = EVIDENCE_RESERVE_BYTES, secrets = secretValues(), clock = { now: () => Date.now() } } = {}) {
    if (!validJobId(jobId)) throw new Error('invalid job id for transcript');
    Object.assign(this, { root, jobId, capBytes, reserveBytes, secrets, clock, file: transcriptFile(root, jobId), seq: 0, size: 0, full: false, closed: false, calls: new Map() });
    fs.mkdirSync(transcriptDir(root), { recursive: true, mode: 0o700 });
    // Later attempts of the same job append: continue the sequence and the size budget.
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      this.size = Buffer.byteLength(text);
      for (const line of text.split('\n')) { try { const e = JSON.parse(line); if (Number.isSafeInteger(e?.seq)) this.seq = Math.max(this.seq, e.seq); if (e?.kind === 'truncated') this.full = true; } catch { /* partial line */ } }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // The output of a secret read has no shape to match, so a result is dropped whole when its call was a secret read. Calls and
  // results are paired by id (Claude tool_use_id, Codex item id), so parallel and out-of-order results stay correct. Fail closed: a
  // result whose id was never seen as a call, or that has no id, is redacted too (this includes the result of an id-less call).
  // The id is stored (sanitised) so a later reader can pair results with calls.
  guardSecretRead(entry) {
    // The evidence line is the raw stream line of the same result, so it is blanked too.
    const hidden = '[redacted: output of a secret read]';
    const redacted = e => ({ ...e, text: hidden, detail: undefined, evidence: e.evidence ? { ...e.evidence, line: hidden } : undefined });
    if (entry?.kind === 'tool_call') {
      const reads = isSecretRead(`${entry.text ?? ''}\n${entry.detail ?? ''}`);
      if (typeof entry.callId === 'string' && entry.callId) {
        this.calls.set(entry.callId, reads);
        if (this.calls.size > 20000) this.calls.delete(this.calls.keys().next().value);
      }
    } else if (entry?.kind === 'tool_result') {
      const known = typeof entry.callId === 'string' && this.calls.has(entry.callId);
      if (!known) return redacted(entry);
      if (this.calls.get(entry.callId) === true) return redacted(entry);
    }
    return entry;
  }
  append(entry) {
    if (this.closed) return null;
    entry = this.guardSecretRead(entry);
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
