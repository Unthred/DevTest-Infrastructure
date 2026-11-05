// Foreman inbox (issue #124, decision D-031 proposed). The overseer, through the foreman-mcp account, writes proposals into
// <inbox>/items/ (the only place that account can write). Foreman is the only writer of everything else: <inbox>/status/<id>.json (what
// became of each item, readable by the overseer) and <inbox>/audit.jsonl. Every item is untrusted data: it is shape-checked, size
// limited, scanned for secret-shaped text and attribution text, and counted against a pending cap before it can reach a card. Nothing
// here runs a job or posts anything; approval is a recorded state that the team tick acts on. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactLong } from './redact.mjs';

export const KINDS = ['prompt', 'issue_draft'];
export const LIMITS = { title: 200, prompt: 8000, body: 8000, itemBytes: 32 * 1024, pending: 10, keepDays: 14, resultChars: 4000, reasonChars: 300 };
export const ID_RE = /^[a-f0-9]{32}$/;
const FIELDS = { prompt: ['kind', 'title', 'prompt', 'why'], issue_draft: ['kind', 'title', 'body', 'why'] };
const LIVE = ['pending', 'approved', 'running', 'posting'];   // states that are not final

export const dirs = inboxDir => ({ items: path.join(inboxDir, 'items'), status: path.join(inboxDir, 'status'), audit: path.join(inboxDir, 'audit.jsonl') });
export const hashOf = item => crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');

// Text that looks like a credential, or an AI attribution line the project forbids. Matching is on the raw text, so it cannot be hidden by
// a case change. The list is deliberately broad: a refused item costs the overseer one rewrite.
const SECRET_RULES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-)[A-Za-z0-9_-]{8,}/,
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/,
  /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/,
  /\bhv[sbr]\.[\w-]{8,}/,
  /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
  /\b(?:pass(?:word|wd)?|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential)s?["']?\s*[:=]\s*["']?(?!\[)[^\s"',;&]{6,}/i,
  /\b(?![0-9a-f]{40}\b)(?![0-9a-f]{64}\b)[A-Za-z0-9_-]{40,}\b/,
];
const ATTRIBUTION_RULES = [
  /\bgenerated (?:with|by)\b[^\n]{0,60}\b(?:claude|codex|gpt|openai|anthropic|copilot|gemini|ai)\b/i,
  /\bco-authored-by:/i,
  /\bnoreply@anthropic\.com\b/i,
  /\bclaude\.ai\/code\b/i,
];
export const secretShaped = text => SECRET_RULES.some(re => re.test(String(text ?? '')));
export const attributionShaped = text => ATTRIBUTION_RULES.some(re => re.test(String(text ?? '')));

// Returns { ok:true, item } with only the known fields, or { ok:false, reason } (a short sentence safe to show; it never quotes the text).
export function validateItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'the item is not a JSON object' };
  if (!KINDS.includes(raw.kind)) return { ok: false, reason: `unknown kind (accepted: ${KINDS.join(', ')})` };
  const allowed = FIELDS[raw.kind], extra = Object.keys(raw).filter(k => !allowed.includes(k));
  if (extra.length) return { ok: false, reason: `unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 3).map(k => String(k).replace(/[^\w-]/g, '?').slice(0, 20)).join(', ')}` };
  const bodyKey = raw.kind === 'prompt' ? 'prompt' : 'body', max = { title: LIMITS.title, [bodyKey]: LIMITS[bodyKey], why: LIMITS.title * 2 };
  for (const k of allowed.filter(k => k !== 'kind')) {
    const v = raw[k];
    if (v === undefined && k === 'why') continue;
    if (typeof v !== 'string' || !v.trim()) return { ok: false, reason: `${k} must be a non-empty string` };
    if (v.length > max[k]) return { ok: false, reason: `${k} is longer than ${max[k]} characters` };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return { ok: false, reason: `${k} contains control characters` };
    if (secretShaped(v)) return { ok: false, reason: `${k} contains secret-shaped text` };
    if (attributionShaped(v)) return { ok: false, reason: `${k} contains AI attribution text, which this project does not allow` };
  }
  if (/[\r\n]/.test(raw.title)) return { ok: false, reason: 'title must be one line' };
  return { ok: true, item: Object.fromEntries(allowed.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])) };
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function writeAtomic(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1) + '\n', { mode: 0o644, flag: 'wx' });
  fs.renameSync(temp, file);
}
// Time, id, kind, event and a hash of the content; never the content.
export function audit(inboxDir, entry, now = Date.now()) {
  try { fs.appendFileSync(dirs(inboxDir).audit, JSON.stringify({ at: new Date(now).toISOString(), ...entry }) + '\n', { mode: 0o644 }); } catch { /* the audit log must not stop the tick; the status file is the record */ }
}
export const statusOf = (inboxDir, id) => (ID_RE.test(String(id)) ? readJson(path.join(dirs(inboxDir).status, `${id}.json`)) : null);
function setStatus(inboxDir, id, patch, now) {
  const file = path.join(dirs(inboxDir).status, `${id}.json`), cur = readJson(file) || {};
  writeAtomic(file, { ...cur, ...patch, id, updatedAt: now });
  return { ...cur, ...patch, id };
}

// Picks up new item files. A file is read only if it is a regular file (never a symlink), small, and has a well-formed name; an item
// that fails any check is recorded as refused with a reason and never becomes a card. At most LIMITS.pending items wait at once.
// Items finished more than keepDays ago are removed from both directories.
export function scan(inboxDir, now = Date.now()) {
  const d = dirs(inboxDir);
  fs.mkdirSync(d.status, { recursive: true, mode: 0o755 });
  let names = [];
  try { names = fs.readdirSync(d.items); } catch { return { picked: 0 }; }
  let picked = 0;
  let pending = allStatuses(inboxDir).filter(s => s.state === 'pending').length;
  for (const name of names.sort()) {
    const m = /^([a-f0-9]{32})\.json$/.exec(name);
    if (!m || statusOf(inboxDir, m[1])) continue;
    const id = m[1], file = path.join(d.items, name);
    let st; try { st = fs.lstatSync(file); } catch { continue; }
    const refuse = reason => { setStatus(inboxDir, id, { state: 'refused', reason, createdAt: now }, now); audit(inboxDir, { id, event: 'refused', reason }, now); picked++; };
    if (!st.isFile()) { refuse('not a regular file'); continue; }
    if (st.size > LIMITS.itemBytes) { refuse(`file larger than ${LIMITS.itemBytes} bytes`); continue; }
    let raw; try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { refuse('not valid JSON'); continue; }
    const v = validateItem(raw), hash = hashOf(raw);
    if (!v.ok) { setStatus(inboxDir, id, { state: 'refused', reason: v.reason, kind: KINDS.includes(raw?.kind) ? raw.kind : null, hash, createdAt: now }, now); audit(inboxDir, { id, event: 'refused', kind: KINDS.includes(raw?.kind) ? raw.kind : null, hash, reason: v.reason }, now); picked++; continue; }
    if (pending >= LIMITS.pending) { setStatus(inboxDir, id, { state: 'refused', reason: `${LIMITS.pending} items are already waiting for approval; decide some first`, kind: v.item.kind, hash, createdAt: now }, now); audit(inboxDir, { id, event: 'refused', kind: v.item.kind, hash, reason: 'pending cap' }, now); picked++; continue; }
    setStatus(inboxDir, id, { state: 'pending', kind: v.item.kind, hash, createdAt: now }, now);
    audit(inboxDir, { id, event: 'proposed', kind: v.item.kind, hash }, now);
    pending++; picked++;
  }
  prune(inboxDir, now);
  return { picked };
}
function prune(inboxDir, now) {
  const d = dirs(inboxDir);
  for (const s of allStatuses(inboxDir)) {
    if (LIVE.includes(s.state) || !(now - (s.updatedAt || 0) > LIMITS.keepDays * 86400000)) continue;
    for (const f of [path.join(d.items, `${s.id}.json`), path.join(d.status, `${s.id}.json`)]) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  }
}
export function allStatuses(inboxDir) {
  try { return fs.readdirSync(dirs(inboxDir).status).filter(n => /^[a-f0-9]{32}\.json$/.test(n)).map(n => readJson(path.join(dirs(inboxDir).status, n))).filter(s => s && ID_RE.test(s.id || '')); } catch { return []; }
}
// The item as it is on disk, re-validated at the moment of use; its hash must still equal the one recorded when it was picked up, so
// an edit after the card was shown (the file is owned by the proposing account) can never be approved or run.
export function loadItem(inboxDir, id) {
  const s = statusOf(inboxDir, id);
  if (!s) return { ok: false, reason: 'unknown item' };
  const file = path.join(dirs(inboxDir).items, `${id}.json`);
  let st; try { st = fs.lstatSync(file); } catch { return { ok: false, reason: 'the item file is gone' }; }
  if (!st.isFile() || st.size > LIMITS.itemBytes) return { ok: false, reason: 'the item file is not usable' };
  const raw = readJson(file);
  if (!raw || hashOf(raw) !== s.hash) return { ok: false, reason: 'the item file changed after it was picked up' };
  const v = validateItem(raw);
  return v.ok ? { ok: true, item: v.item, status: s } : { ok: false, reason: v.reason };
}

// Cards for the dashboard: pending items with exactly what will happen. Text is redacted again for display (defence in depth).
export function pendingCards(inboxDir) {
  return allStatuses(inboxDir).filter(s => s.state === 'pending').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(s => {
    const l = loadItem(inboxDir, s.id);
    if (!l.ok) return { id: s.id, kind: s.kind, broken: l.reason };
    const it = l.item, clip = (t, n) => redactLong(String(t ?? '').replace(/\r/g, ''), n, ' [cut]').trim();
    return { id: s.id, kind: it.kind, title: clip(it.title, LIMITS.title), why: it.why ? clip(it.why, 400) : null, hash: s.hash.slice(0, 12),
      will: it.kind === 'prompt' ? 'Start one supervised Foreman job on an implementer model with this prompt. It cannot merge, approve, write a review verdict or widen its own limits.' : 'Post this as a new GitHub issue from the homeowner account, once, with secrets redacted.',
      text: clip(it.kind === 'prompt' ? it.prompt : it.body, LIMITS.prompt) };
  });
}

// The two decisions. Only a pending item can be decided, once; the hash must still match. Returns { ok, reason? }.
export function decide(inboxDir, id, decision, now = Date.now()) {
  if (!['approve', 'reject'].includes(decision)) return { ok: false, reason: 'unknown decision' };
  const s = statusOf(inboxDir, id);
  if (!s) return { ok: false, reason: 'unknown item' };
  if (s.state !== 'pending') return { ok: false, reason: `the item is already ${s.state}` };
  if (decision === 'approve') {
    const l = loadItem(inboxDir, id);
    if (!l.ok) { setStatus(inboxDir, id, { state: 'refused', reason: l.reason }, now); audit(inboxDir, { id, event: 'refused', kind: s.kind, hash: s.hash, reason: l.reason }, now); return { ok: false, reason: l.reason }; }
  }
  setStatus(inboxDir, id, decision === 'approve' ? { state: 'approved', decidedAt: now } : { state: 'rejected', decidedAt: now, result: 'rejected by the homeowner; nothing was done' }, now);
  audit(inboxDir, { id, event: decision === 'approve' ? 'approved' : 'rejected', kind: s.kind, hash: s.hash }, now);
  return { ok: true };
}
export function approvedItems(inboxDir, kind) {
  return allStatuses(inboxDir).filter(s => s.state === 'approved' && s.kind === kind).sort((a, b) => (a.decidedAt || 0) - (b.decidedAt || 0));
}
// Foreman's own transitions (running, posting, done, failed). `result` is redacted and bounded because the overseer reads it.
export function finish(inboxDir, id, patch, now = Date.now()) {
  const clean = { ...patch };
  if (clean.result !== undefined) clean.result = redactLong(String(clean.result), LIMITS.resultChars, ' [cut]');
  if (clean.reason !== undefined) clean.reason = redactLong(String(clean.reason), LIMITS.reasonChars, ' [cut]');
  setStatus(inboxDir, id, clean, now);
  audit(inboxDir, { id, event: clean.state || 'update', kind: statusOf(inboxDir, id)?.kind, hash: statusOf(inboxDir, id)?.hash }, now);
}
// A job needs an issue number for its lease; an inbox job has none, so it gets a unique number far above any real issue (never looked up).
export const placeholderIssue = id => 900000000 + parseInt(String(id).slice(0, 6), 16);
export const marker = id => `<!-- devtest-inbox v1 ${id} -->`;
