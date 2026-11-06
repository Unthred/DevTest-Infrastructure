// Foreman inbox (issue #124, decision D-031 proposed). The overseer, through the foreman-mcp account, writes proposals into
// <inbox>/items/ (the only place that account can write). Foreman is the only writer of everything else: <inbox>/status/<id>.json (what
// became of each item, readable by the overseer) and <inbox>/audit.jsonl. Every item is untrusted data: it is shape-checked, size
// limited, scanned for secret-shaped text and attribution text, and counted against a pending cap before it can reach a card. Nothing
// here runs a job or posts anything; approval is a recorded state that the team tick acts on. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactLong } from './redact.mjs';

export const KINDS = ['prompt', 'issue_draft', 'action'];
// Issue #629: named actions for cases that needed a terminal. Each is a fixed name with one target of a fixed shape (a pull request or issue
// number, or the 8-character job id the dashboard shows); the item carries no command, path or free-form argument.
export const ACTIONS = {
  new_review_attempt: { target: 'pr', noun: 'pull request', will: "Give one more review attempt at the same head of this pull request (use it when attempts were spent by Foreman's own faults). Nothing is merged or approved; the new review decides." },
  reopen: { target: 'issue', noun: 'issue', will: 'Clear the "implemented" mark of this issue so Foreman can start it again. Refused while a pull request, a live job or saved work for it exists.' },
  close_job: { target: 'job', noun: 'job', will: 'Close this stopped job of a pull request that a newer head has overtaken. Unpushed work is saved to a branch on the remote first; the job is closed only once nothing local is unsaved.' },
  stop_job: { target: 'job', noun: 'job', will: 'Stop this running or paused job.' },
  resume_job: { target: 'job', noun: 'job', will: 'Resume this paused, blocked or failed job once, with a fresh bounded round.' },
};
const TARGET_RE = { pr: /^[1-9]\d{0,8}$/, issue: /^[1-9]\d{0,8}$/, job: /^[a-f0-9]{8}$/ };
export const LIMITS = { title: 200, prompt: 8000, body: 8000, itemBytes: 32 * 1024, pending: 10, keepDays: 14, resultChars: 4000, reasonChars: 300 };
export const ID_RE = /^[a-f0-9]{32}$/;
const FIELDS = { prompt: ['kind', 'title', 'prompt', 'why'], issue_draft: ['kind', 'title', 'body', 'why'], action: ['kind', 'title', 'action', 'target', 'reason'] };
// Decision D-035 (proposed): what may run without a click. A code constant, not configuration: nothing in an item, in team.local.json or from
// the overseer can add to it. `prompt` is never here (it runs on Tower with wide access); close_job, stop_job and anything that pauses work,
// restarts a service, retries an install or runs anything else always wait for a click. The numbers are the daily limits (a rolling 24 h).
export const AUTO_ACTIONS = Object.freeze({ new_review_attempt: 5, reopen: 5, resume_job: 5 });
export const AUTO_DRAFT_LIMIT = 10;
export const AUTO_WINDOW_MS = 24 * 3600000;
// The switch and the draft limit live in team.local.json: { inbox: { dir, auto: false, auto_draft_limit: 10 } }. Anything but `false` means on.
export const autoSettings = (cfg, hold = null) => ({ enabled: cfg?.auto !== false, draftLimit: Number.isInteger(cfg?.auto_draft_limit) ? cfg.auto_draft_limit : AUTO_DRAFT_LIMIT, hold });
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

const flat = t => String(t).replace(/\r/g, '').replace(/\t/g, ' ').trim();
export const displayChanges = text => redactLong(flat(text), flat(text).length + 16, ' [cut]') !== flat(text);

// Returns { ok:true, item } with only the known fields, or { ok:false, reason } (a short sentence safe to show; it never quotes the text).
export function validateItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'the item is not a JSON object' };
  if (!KINDS.includes(raw.kind)) return { ok: false, reason: `unknown kind (accepted: ${KINDS.join(', ')})` };
  const allowed = FIELDS[raw.kind], extra = Object.keys(raw).filter(k => !allowed.includes(k));
  if (extra.length) return { ok: false, reason: `unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 3).map(k => String(k).replace(/[^\w-]/g, '?').slice(0, 20)).join(', ')}` };
  const bodyKey = raw.kind === 'prompt' ? 'prompt' : raw.kind === 'action' ? 'reason' : 'body', max = { title: LIMITS.title, [bodyKey]: bodyKey === 'reason' ? LIMITS.reasonChars : LIMITS[bodyKey], why: LIMITS.title * 2, action: 30, target: 12 };
  for (const k of allowed.filter(k => k !== 'kind')) {
    const v = raw[k];
    if (v === undefined && k === 'why') continue;
    if (typeof v !== 'string' || !v.trim()) return { ok: false, reason: `${k} must be a non-empty string` };
    if (v.length > max[k]) return { ok: false, reason: `${k} is longer than ${max[k]} characters` };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return { ok: false, reason: `${k} contains control characters` };
    if (secretShaped(v)) return { ok: false, reason: `${k} contains secret-shaped text` };
    if (attributionShaped(v)) return { ok: false, reason: `${k} contains AI attribution text, which this project does not allow` };
    // The card shows redacted text, so anything the display redactor would change (e-mail addresses, digests, short key=value values)
    // is refused: the card must show exactly what the job receives.
    if (displayChanges(v)) return { ok: false, reason: `${k} contains text the dashboard would mask (an e-mail address, a hex digest, a key=value pair or user@host); describe it without the literal value` };
  }
  if (/[\r\n]/.test(raw.title)) return { ok: false, reason: 'title must be one line' };
  if (raw.kind === 'action') {
    const spec = Object.hasOwn(ACTIONS, raw.action) ? ACTIONS[raw.action] : null;
    if (!spec) return { ok: false, reason: `unknown action (accepted: ${Object.keys(ACTIONS).join(', ')})` };
    if (!TARGET_RE[spec.target].test(raw.target)) return { ok: false, reason: `target must be ${spec.target === 'job' ? 'the 8-character job id' : spec.target === 'pr' ? 'a pull request number' : 'an issue number'}` };
  }
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
// Automatic handling is counted from the status files (each records autoAt and autoKey), so the daily limits survive a restart.
export function autoUse(inboxDir, now = Date.now()) {
  const used = {};
  for (const s of allStatuses(inboxDir)) if (Number.isFinite(s.autoAt) && now - s.autoAt < AUTO_WINDOW_MS && s.autoKey) used[s.autoKey] = (used[s.autoKey] || 0) + 1;
  return used;
}
// null: not eligible (always a card, no remark). { allow:true, key }: runs without a click. { allow:false, note }: eligible but held, so a card that says why.
function autoDecision(item, used, auto) {
  if (!auto?.enabled) return null;
  let key, limit, label;
  if (item.kind === 'issue_draft') { key = 'issue_draft'; limit = auto.draftLimit; label = 'issue drafts'; }
  else if (item.kind === 'action' && Object.hasOwn(AUTO_ACTIONS, item.action)) { key = item.action; limit = AUTO_ACTIONS[key]; label = `${key} actions`; }
  else return null;
  if (auto.hold) return { allow: false, note: `not run automatically: ${auto.hold}; it needs a click` };
  if ((used[key] || 0) >= limit) return { allow: false, note: `not run automatically: the daily limit of ${limit} automatic ${label} is used up; it needs a click` };
  used[key] = (used[key] || 0) + 1;
  return { allow: true, key };
}
export function scan(inboxDir, now = Date.now(), auto = null) {
  const d = dirs(inboxDir);
  fs.mkdirSync(d.status, { recursive: true, mode: 0o755 });
  let names = [];
  try { names = fs.readdirSync(d.items); } catch { return { picked: 0 }; }
  let picked = 0;
  let pending = allStatuses(inboxDir).filter(s => s.state === 'pending').length;
  const used = auto?.enabled ? autoUse(inboxDir, now) : {};
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
    const ad = autoDecision(v.item, used, auto);
    if (ad?.allow) {   // D-035: no click; every check above and loadItem's re-check at use still apply, and the audit event differs from a human approval
      setStatus(inboxDir, id, { state: 'approved', kind: v.item.kind, hash, createdAt: now, decidedAt: now, decidedBy: 'auto', autoAt: now, autoKey: ad.key }, now);
      audit(inboxDir, { id, event: 'auto_approved', kind: v.item.kind, hash, limit_key: ad.key }, now); picked++; continue;
    }
    if (pending >= LIMITS.pending) { setStatus(inboxDir, id, { state: 'refused', reason: `${LIMITS.pending} items are already waiting for approval; decide some first`, kind: v.item.kind, hash, createdAt: now }, now); audit(inboxDir, { id, event: 'refused', kind: v.item.kind, hash, reason: 'pending cap' }, now); picked++; continue; }
    setStatus(inboxDir, id, { state: 'pending', kind: v.item.kind, hash, createdAt: now, ...(ad?.note ? { autoNote: ad.note } : {}) }, now);
    audit(inboxDir, { id, event: 'proposed', kind: v.item.kind, hash, ...(ad?.note ? { held: ad.note } : {}) }, now);
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
      will: (it.kind === 'action' ? `${ACTIONS[it.action].will} Target: ${ACTIONS[it.action].noun} ${it.target}.` : it.kind === 'prompt' ? 'Start one supervised Foreman job on an implementer model with this prompt. It runs on Tower with wide access, so it always needs a click. It cannot merge, approve, write a review verdict or widen its own limits.' : 'Post this as a new GitHub issue from the homeowner account, once, with secrets redacted.') + (s.autoNote ? ` (${s.autoNote[0].toUpperCase()}${s.autoNote.slice(1)}.)` : ''),
      text: clip(it.kind === 'prompt' ? it.prompt : it.kind === 'action' ? `${it.action} ${it.target}\nReason: ${it.reason}` : it.body, LIMITS.prompt) };
  });
}

// Issue #641: a failed item (an approved prompt whose job stopped, a failed action or post) has no GitHub notice, so the dashboard shows it as
// one Needs you line for FAILED_SHOW_MS after it failed. Text is redacted and bounded again for display; no item content is shown.
export const FAILED_SHOW_MS = 3 * 86400000;
export function failedCards(inboxDir, now = Date.now()) {
  return allStatuses(inboxDir).filter(s => s.state === 'failed' && Number.isFinite(s.updatedAt) && now - s.updatedAt >= 0 && now - s.updatedAt <= FAILED_SHOW_MS)
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).map(s => {
      const clip = t => redactLong(String(t ?? '').replace(/\s+/g, ' '), 200, ' [cut]').trim();
      return { id: s.id, kind: s.kind || null, job: /^[a-f0-9]{8}$/.test(s.job || '') ? s.job : null, why: clip(s.reason || s.result || 'no reason recorded') };
    });
}

// The two decisions. Only a pending item can be decided, once; the hash must still match. Returns { ok, reason? }.
// `expect` (Approve all, D-035): the 12-character hash that was on screen. A mismatch, or an item that no longer loads, changes nothing: it stays waiting.
export function decide(inboxDir, id, decision, now = Date.now(), expect = null) {
  if (!['approve', 'reject'].includes(decision)) return { ok: false, reason: 'unknown decision' };
  const s = statusOf(inboxDir, id);
  if (!s) return { ok: false, reason: 'unknown item' };
  if (s.state !== 'pending') return { ok: false, reason: `the item is already ${s.state}` };
  if (expect !== null) {
    if (typeof expect !== 'string' || !expect || s.hash.slice(0, 12) !== expect) return { ok: false, reason: 'the item is not the one that was on screen' };
    if (!loadItem(inboxDir, id).ok) return { ok: false, reason: 'the item cannot be approved as shown' };
  }
  if (decision === 'approve') {
    const l = loadItem(inboxDir, id);
    if (!l.ok) { setStatus(inboxDir, id, { state: 'refused', reason: l.reason }, now); audit(inboxDir, { id, event: 'refused', kind: s.kind, hash: s.hash, reason: l.reason }, now); return { ok: false, reason: l.reason }; }
  }
  setStatus(inboxDir, id, decision === 'approve' ? { state: 'approved', decidedAt: now, decidedBy: 'homeowner' } : { state: 'rejected', decidedAt: now, result: 'rejected by the homeowner; nothing was done' }, now);
  audit(inboxDir, { id, event: decision === 'approve' ? 'approved' : 'rejected', kind: s.kind, hash: s.hash, ...(expect !== null ? { via: 'approve_all' } : {}) }, now);
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
  const cur = statusOf(inboxDir, id);
  audit(inboxDir, { id, event: clean.state || 'update', kind: cur?.kind, hash: cur?.hash, ...(cur?.decidedBy === 'auto' ? { by: 'auto' } : {}) }, now);
}
// A job needs an issue number for its lease; an inbox job has none, so it gets a unique number far above any real issue (never looked up).
export const placeholderIssue = id => 900000000 + parseInt(String(id).slice(0, 6), 16);
export const marker = id => `<!-- devtest-inbox v1 ${id} -->`;

// D-035: what ran without a click in the last 24 hours, against the daily limits. Display only; it adds nothing to Needs you. Names are the ones
// GitHub and the dashboard use (pull request, issue, job); no item text beyond a redacted, bounded title.
export function autoRecent(inboxDir, auto, now = Date.now()) {
  const clip = t => redactLong(String(t ?? '').replace(/\s+/g, ' '), 80, ' [cut]').trim();
  const used = autoUse(inboxDir, now);
  const rows = allStatuses(inboxDir).filter(s => Number.isFinite(s.autoAt) && now - s.autoAt < AUTO_WINDOW_MS).sort((a, b) => b.autoAt - a.autoAt).map(s => {
    const l = loadItem(inboxDir, s.id), it = l.ok ? l.item : null;
    const what = it?.kind === 'action' ? `${s.autoKey} on ${ACTIONS[it.action].noun} ${it.target}` : it ? `issue draft: ${clip(it.title)}` : s.autoKey;
    return { id: s.id, what, at: s.autoAt, state: s.state, result: s.result ? clip(s.result) : (s.reason ? clip(s.reason) : null), issue: Number.isInteger(s.issue) ? s.issue : null };
  });
  return { enabled: !!auto?.enabled, window: 'last 24 hours', drafts: { used: used.issue_draft || 0, limit: auto?.draftLimit ?? AUTO_DRAFT_LIMIT }, actions: Object.entries(AUTO_ACTIONS).map(([name, limit]) => ({ name, used: used[name] || 0, limit })), rows };
}
