// Foreman inbox (issue #124, decision D-031 proposed). The overseer, through the foreman-mcp account, writes proposals into
// <inbox>/items/ (the only place that account can write). Foreman is the only writer of everything else: <inbox>/status/<id>.json (what
// became of each item, readable by the overseer) and <inbox>/audit.jsonl. Every item is untrusted data: it is shape-checked, size
// limited, scanned for secret-shaped text and attribution text, and counted against a pending cap before it can reach a card. Nothing
// here runs a job or posts anything; approval is a recorded state that the team tick acts on. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactLong } from './redact.mjs';
import { secretShaped, secretShapedInFile, secretShapedReason, maskedReason } from './inbox-refusal.mjs';
import { validateHostValue, HOST_KEYS } from './hostvalue.mjs';
import { dependencyRefusal, parseDependsOn } from './dependencies.mjs';
import { matchesInboxSearch } from '../foreman-mcp/inbox-search.mjs';
import { afterFormatRefusal, afterLabels, resolveAfter } from '../foreman-mcp/draft-after.mjs';
import { referenceText } from '../foreman-mcp/inbox-reference.mjs';
import { assignNumber, hasNumber, unnumberedOldestFirst } from './inboxnumber.mjs';

export const KINDS = ['prompt', 'issue_draft', 'action', 'control'];
// Issue #855: kinds only Foreman raises itself (raiseHostValue). The overseer cannot submit one: scan() validates files without `internal`.
export const INTERNAL_KINDS = ['host_value'];
// Issue #629: named actions for cases that needed a terminal. Each is a fixed name with one target of a fixed shape (a pull request or issue
// number, or the 8-character job id the dashboard shows); the item carries no command, path or free-form argument.
// Issue #1179: the release of an agent parked after an infrastructure fault.
const RELEASE_WILL = 'Release this agent from its infrastructure-fault park, for a cause you judge benign. A real fault parks it again. Refused when it is not parked.';
const SUPERSEDE_WILL = 'Close it with a comment naming the superseding items (superseded_by), after saving a pull request branch under saved/ (issue #1337). '
  + 'An issue is closed as not planned. Refused when it is not open, a superseding item does not exist, or a job is running on it; nothing is merged or approved.';
// Issue #1339: one more fix job on the current head of a stopped pull request. The model is optional and at most 30 characters; the MCP server
// keeps a copy of the limit (foreman-mcp/inbox.mjs) and a test compares them.
const EXTRA_FIX_WILL = 'Allow exactly one more fix or CI fix job on the current head of this pull request, past the fix limit and the churn stop, '
  + 'written by the agent that owns the branch (D-011); then the limits apply again. Refused unless the head has a CHANGES verdict or red CI, '
  + 'while a fix job has not ended, or when this head already had its round. Nothing is merged or approved.';
export const EXTRA_FIX_MODEL_MAX = 30;
export const ACTIONS = {
  new_review_attempt: { target: 'pr', noun: 'pull request', will: "Give one more review attempt at the same head of this pull request (use it when attempts were spent by Foreman's own faults). Nothing is merged or approved; the new review decides." },
  clear_retry_cap: { target: 'pr', noun: 'pull request', will: 'Clear the retry cap Foreman put on this pull request (a rebase, fix or review that failed twice for the same cause), so it is planned again. Refused when no cap is in place. Nothing is merged or approved.' },
  reopen: { target: 'issue', noun: 'issue', will: 'Clear the "implemented" mark of this issue so Foreman can start it again. Refused while a pull request, a live job or saved work for it exists.' },
  close_job: { target: 'job', noun: 'job', will: 'Close this stopped job of a pull request that a newer head has overtaken. Unpushed work is saved to a branch on the remote first; the job is closed only once nothing local is unsaved.' },
  stop_job: { target: 'job', noun: 'job', will: 'Stop this running or paused job.' },
  resume_job: { target: 'job', noun: 'job', will: 'Resume this paused, blocked or failed job once, with a fresh bounded round.' },
  clear_latch: { target: 'latch', noun: 'upgrade', will: 'Clear the upgrade latch so the next tick may install merged work under the usual rules (issue #1160). Refused when no latch is set or an install is running. Nothing is merged or approved.' },
  unpark: { target: 'pr', noun: 'issue or pull request', will: 'Remove the parked label from this issue or pull request so the planner may take it again (issue #1115). Refused when it is not parked.' },
  approve_split: { target: 'pr', noun: 'pull request', will: 'File the split of this parked pull request as the proposed smaller items, once, and link them to it. The pull request stays parked until every item has merged (issues #1338, #1340).' },
  reject_split: { target: 'pr', noun: 'pull request', will: 'Reject the proposed split of this parked pull request. Nothing is filed and the pull request stays parked (issue #1338).' },
  release_agent: { target: 'agent', noun: 'agent', will: RELEASE_WILL },
  resume_breaker: { target: 'breaker', noun: 'breaker scope', will: 'Resume this tripped circuit breaker scope exactly as `team breaker resume` does, recorded with who and why (issue #1332). Refused when the scope is not halted. Nothing is merged or approved.' },
  close_superseded: { target: 'pr', noun: 'pull request or issue', will: SUPERSEDE_WILL },
  extra_fix_round: { target: 'pr', noun: 'pull request', will: EXTRA_FIX_WILL },
};
// Issue #1332: the one breaker scope shape: @global, all, or a halt key (the breaker writes causes up to 120 characters). The decision table and
// inbox validation import it; the MCP server cannot import from the supervisor, so foreman-mcp/inbox.mjs keeps a copy and a test compares them.
export const BREAKER_SCOPE = /^(?:@global|all|[A-Za-z0-9_.:-]{1,160})$/;
export const BREAKER_SCOPE_MAX = 160;
const BREAKER_SCOPE_REFUSAL = 'target must be @global, all or a halt key of letters, digits and _ . : - (at most 160 characters)';
// Issue #1337: close_superseded names one to five issue or pull request numbers, separated by commas, in at most 60 characters. The MCP server
// keeps a copy (foreman-mcp/inbox.mjs) and a test compares them.
export const SUPERSEDED_BY = /^\d{1,9}(?:\s*,\s*\d{1,9}){0,4}$/;
export const SUPERSEDED_BY_MAX = 60;
const SUPERSEDED_BY_REFUSAL = 'superseded_by must be one to five issue or pull request numbers separated by commas';
// Issue #1337: superseded_by belongs to close_superseded (a named action, never a control), where it is required.
function supersededRefusal(raw) {
  if (raw.action !== 'close_superseded') return raw.superseded_by === undefined ? null : 'superseded_by is only accepted with close_superseded';
  return raw.kind === 'action' && SUPERSEDED_BY.test(raw.superseded_by) ? null : SUPERSEDED_BY_REFUSAL;
}
// Issue #1339: model belongs to extra_fix_round only, where it is optional.
const mayBeAbsent = (k, action) => ['why', 'effect', 'after', 'model'].includes(k) || (k === 'superseded_by' && action !== 'close_superseded');
const modelRefusal = raw => (raw.model === undefined || raw.action === 'extra_fix_round' ? null : 'model is only accepted with extra_fix_round');
const targetMax = raw => (raw.action === 'resume_breaker' ? BREAKER_SCOPE_MAX : 12);
// Issue #1115: the holding direction. A `control` item runs without a click (it only holds work back or stops a job; it never releases, merges
// or approves anything). Two fixed names, one target each.
export const CONTROLS = { park: { target: 'pr' }, stop_job: { target: 'job' } };
const TARGET_RE = { latch: /^latch$/, breaker: BREAKER_SCOPE, pr: /^[1-9]\d{0,8}$/, issue: /^[1-9]\d{0,8}$/, job: /^[a-f0-9]{8}$/, agent: /^[a-z][a-z0-9_-]{0,11}$/ };
// title/prompt/body/reasonChars are characters; itemBytes is the item file size; pending is the cap of items waiting; keepDays is how long a final status is kept; resultChars caps a stored result.
export const LIMITS = { title: 200, prompt: 8000, body: 8000, itemBytes: 32 * 1024, pending: 30, keepDays: 14, resultChars: 4000, reasonChars: 300 };
export const ID_RE = /^[a-f0-9]{32}$/;
// Issue #1238: a prompt may declare that it only reads or only reports. Such a prompt never changes queue order or config, so it never holds
// implement picks. An absent effect means it may change them.
export const PROMPT_EFFECTS = ['read_only', 'report_only'];
const FIELDS = { prompt: ['kind', 'title', 'prompt', 'why'], issue_draft: ['kind', 'title', 'body', 'why'], action: ['kind', 'title', 'action', 'target', 'reason'], host_value: ['kind', 'title', 'key', 'value', 'why'] };
FIELDS.prompt.push('effect');
FIELDS.issue_draft.push('after');   // issue #1259
FIELDS.action.push('superseded_by');   // issue #1337: required for close_superseded, refused for every other action
FIELDS.action.push('model');   // issue #1339: optional, extra_fix_round only
FIELDS.control = FIELDS.action;
const LIVE = ['pending', 'approved', 'running', 'posting'];   // states that are not final
// Issue #943: once an item is final its item file is no longer needed (the hash is only checked while it is live), so it is removed at once; the
// status record keeps the history. A rejected item keeps its file until the undo window has passed, because Undo returns it to pending.
const FINAL_NOW = ['done', 'failed', 'refused'];
export const limitsFile = inboxDir => path.join(dirs(inboxDir).status, 'limits.json');

export const dirs = inboxDir => ({ items: path.join(inboxDir, 'items'), status: path.join(inboxDir, 'status'), audit: path.join(inboxDir, 'audit.jsonl') });
export const hashOf = item => crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex');

// Credential-shaped text is checked by supervisor/inbox-refusal.mjs (issue #1372), which names each rule. An AI attribution line is forbidden too.
const ATTRIBUTION_RULES = [
  /\bgenerated (?:with|by)\b[^\n]{0,60}\b(?:claude|codex|gpt|openai|anthropic|copilot|gemini|ai)\b/i,
  /\bco-authored-by:/i,
  /\bnoreply@anthropic\.com\b/i,
  /\bclaude\.ai\/code\b/i,
];
export { secretShaped, secretShapedInFile };
export const attributionShaped = text => ATTRIBUTION_RULES.some(re => re.test(String(text ?? '')));

const flat = t => String(t).replace(/\r/g, '').replace(/\t/g, ' ').trim();
export const displayChanges = text => redactLong(flat(text), flat(text).length + 16, ' [cut]') !== flat(text);

// Returns { ok:true, item } with only the known fields, or { ok:false, reason } (a short sentence safe to show; it never quotes the text).
export function validateItem(raw, { internal = false } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'the item is not a JSON object' };
  if (!KINDS.includes(raw.kind) && !(internal && INTERNAL_KINDS.includes(raw.kind))) return { ok: false, reason: `unknown kind (accepted: ${KINDS.join(', ')})` };
  const named = raw.kind === 'action' || raw.kind === 'control';
  const allowed = FIELDS[raw.kind], extra = Object.keys(raw).filter(k => !allowed.includes(k));
  if (extra.length) return { ok: false, reason: `unknown field${extra.length > 1 ? 's' : ''}: ${extra.slice(0, 3).map(k => String(k).replace(/[^\w-]/g, '?').slice(0, 20)).join(', ')}` };
  const bodyKey = raw.kind === 'prompt' ? 'prompt' : named ? 'reason' : 'body';
  const max = { title: LIMITS.title, [bodyKey]: bodyKey === 'reason' ? LIMITS.reasonChars : LIMITS[bodyKey], why: LIMITS.title * 2, action: 30,
    target: targetMax(raw), key: 60, value: 300, superseded_by: SUPERSEDED_BY_MAX, model: EXTRA_FIX_MODEL_MAX };
  for (const k of allowed.filter(k => k !== 'kind')) {
    const v = raw[k];
    if (v === undefined && mayBeAbsent(k, raw.action)) continue;
    if (k === 'after') { const bad = afterFormatRefusal(v); if (bad) return { ok: false, reason: bad }; continue; }   // issue #1259
    if (typeof v !== 'string' || !v.trim()) return { ok: false, reason: `${k} must be a non-empty string` };
    if (k === 'effect' && !PROMPT_EFFECTS.includes(v)) return { ok: false, reason: `effect must be one of ${PROMPT_EFFECTS.join(', ')}` };
    if (v.length > max[k]) return { ok: false, reason: `${k} is longer than ${max[k]} characters` };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return { ok: false, reason: `${k} contains control characters` };
    if (raw.kind === 'host_value' && k === 'value') continue;   // checked against its key's exact shape below; the card must show it as it is
    if (secretShaped(v)) return { ok: false, reason: secretShapedReason(k, v) };
    if (attributionShaped(v)) return { ok: false, reason: `${k} contains AI attribution text, which this project does not allow` };
    // The card shows redacted text, so anything the display redactor would change (e-mail addresses, digests, short key=value values)
    // is refused: the card must show exactly what the job receives.
    if (displayChanges(v) && !(raw.kind === 'host_value' && k === 'key')) return { ok: false, reason: maskedReason(k, v) };
  }
  if (/[\r\n]/.test(raw.title)) return { ok: false, reason: 'title must be one line' };
  if (raw.kind === 'issue_draft') {
    const parsed = parseDependsOn(raw.body);
    if (parsed.malformed) return { ok: false, reason: dependencyRefusal(parsed) };
  }
  if (named) {
    const table = raw.kind === 'control' ? CONTROLS : ACTIONS, spec = Object.hasOwn(table, raw.action) ? table[raw.action] : null;
    if (!spec) return { ok: false, reason: `unknown action (accepted: ${Object.keys(table).join(', ')})` };
    if (spec.target === 'latch' && raw.target !== 'latch') return { ok: false, reason: 'target must be latch' };   // issue #1160
    if (spec.target === 'agent' && !TARGET_RE.agent.test(raw.target)) return { ok: false, reason: 'target must be an agent name' };   // issue #1179
    if (spec.target === 'breaker' && !BREAKER_SCOPE.test(raw.target)) return { ok: false, reason: BREAKER_SCOPE_REFUSAL };   // issue #1332
    const bad = supersededRefusal(raw) || modelRefusal(raw);
    if (bad) return { ok: false, reason: bad };
    if (!TARGET_RE[spec.target].test(raw.target)) return { ok: false, reason: `target must be ${spec.target === 'job' ? 'the 8-character job id' : spec.target === 'pr' ? 'a pull request number' : 'an issue number'}` };
  }
  if (raw.kind === 'host_value') {
    if (!validateHostValue(raw.key, raw.value)) return { ok: false, reason: `key must be one of ${Object.keys(HOST_KEYS).join(', ')} with a value of the right shape` };
  }
  return { ok: true, item: Object.fromEntries(allowed.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])) };
}

// Issue #856: a per-item lock (an exclusive lock file, stale after 10 s) so the dashboard's Undo and the tick's claim never interleave.
// A held lock makes the caller back off: Undo is refused with "try again", the tick leaves the item for the next pass.
function withLock(inboxDir, id, fn) {
  const lock = path.join(dirs(inboxDir).status, `${id}.lock`);
  let fd = null;
  for (let i = 0; i < 2 && fd === null; i++) {
    try { fd = fs.openSync(lock, 'wx'); }
    catch { try { if (Date.now() - fs.statSync(lock).mtimeMs > 10000) fs.unlinkSync(lock); else break; } catch { /* gone or unreadable */ } }
  }
  if (fd === null) return { locked: true };
  try { return { locked: false, value: fn() }; } finally { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch { /* already removed */ } }
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
  const number = hasNumber(cur) ? cur.number : assignNumber(inboxDir, id);   // issue #1414: given once, when the item is first recorded
  writeAtomic(file, { ...cur, ...patch, id, number, updatedAt: now });
  if (FINAL_NOW.includes(patch.state)) { try { fs.unlinkSync(path.join(dirs(inboxDir).items, `${id}.json`)); } catch { /* already gone */ } }
  return { ...cur, ...patch, id, number };
}
const numberFields = s => ({ number: s.number ?? null, reference: referenceText(s.number, s.issue) });   // issue #1414
// Issue #1414: items recorded before numbers existed get theirs once, oldest first; a second run finds none left. updatedAt is kept, so
// the fourteen-day clean-up is not restarted. An item whose lock is held is left for the next pass.
function numberExisting(inboxDir) {
  for (const s of unnumberedOldestFirst(allStatuses(inboxDir))) withLock(inboxDir, s.id, () => setStatus(inboxDir, s.id, {}, s.updatedAt));
}

// Picks up new item files. A file is read only if it is a regular file (never a symlink), small, and has a well-formed name; an item
// that fails any check is recorded as refused with a reason and never becomes a card. At most maxPending (default LIMITS.pending) items wait at once.
// Items finished more than keepDays ago are removed from both directories.
export function scan(inboxDir, now = Date.now(), { maxPending = LIMITS.pending } = {}) {
  const d = dirs(inboxDir);
  fs.mkdirSync(d.status, { recursive: true, mode: 0o755 });
  // The MCP server reads this to refuse at submit time exactly what pickup would refuse (it cannot write status/, so it only reads).
  try { if (readJson(limitsFile(inboxDir))?.pending !== maxPending) writeAtomic(limitsFile(inboxDir), { pending: maxPending }); } catch { /* the MCP server then uses its default */ }
  numberExisting(inboxDir);
  sweepFinished(inboxDir, now);
  let names = [];
  try { names = fs.readdirSync(d.items); } catch { return { picked: 0 }; }
  let picked = 0, controls = 0;
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
    const chain = v.item.after ? resolveAfter(inboxDir, id, v.item.after) : { ok: true };   // issue #1259: the named drafts must be known issue drafts
    if (!chain.ok) { setStatus(inboxDir, id, { state: 'refused', reason: chain.reason, kind: v.item.kind, hash, createdAt: now }, now); audit(inboxDir, { id, event: 'refused', kind: v.item.kind, hash, reason: chain.reason }, now); picked++; continue; }
    if (v.item.kind === 'control') {   // issue #1115: no card and no pending slot; the tick runs it and records who, why and the result
      setStatus(inboxDir, id, { state: 'approved', kind: 'control', hash, createdAt: now, title: v.item.title, control: { action: v.item.action, target: v.item.target, reason: v.item.reason, by: 'overseer' } }, now);
      audit(inboxDir, { id, event: 'control', kind: 'control', hash }, now); picked++; controls++; continue;
    }
    if (pending >= maxPending) { setStatus(inboxDir, id, { state: 'refused', reason: `${maxPending} items are already waiting for approval; decide some first`, kind: v.item.kind, hash, createdAt: now }, now); audit(inboxDir, { id, event: 'refused', kind: v.item.kind, hash, reason: 'pending cap' }, now); picked++; continue; }
    setStatus(inboxDir, id, { state: 'pending', kind: v.item.kind, hash, createdAt: now, title: redactLong(v.item.title, LIMITS.title, ' [cut]').trim() }, now);
    audit(inboxDir, { id, event: 'proposed', kind: v.item.kind, hash }, now);
    pending++; picked++;
  }
  prune(inboxDir, now);
  return { picked, controls };
}
function sweepFinished(inboxDir, now) {
  for (const s of allStatuses(inboxDir)) {
    if (!FINAL_NOW.includes(s.state) && !(s.state === 'rejected' && !(now - (s.decidedAt || 0) <= UNDO_MS))) continue;
    try { fs.unlinkSync(path.join(dirs(inboxDir).items, `${s.id}.json`)); } catch { /* none */ }
  }
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
  const v = validateItem(raw, { internal: INTERNAL_KINDS.includes(s.kind) });
  return v.ok ? { ok: true, item: v.item, status: s } : { ok: false, reason: v.reason };
}

// Issue #1238: what the card tells the homeowner about the order guard before they approve.
const promptWill = it => 'Start one supervised Foreman job on an implementer model with this prompt. It cannot merge, approve, write a review verdict or widen its own limits.' + effectNote(it);
const effectNote = it => (PROMPT_EFFECTS.includes(it.effect)
  ? ` The proposer declares it ${it.effect === 'read_only' ? 'read only' : 'report only'}: it does not hold new implement work back while it waits.`
  : ' It may change queue order or config, so new implement work waits for it.');

const chainNote = (inboxDir, it) => (it.after ? ` It waits for the earlier drafts: ${afterLabels(inboxDir, it.after).join('; ')}; their issue numbers are written into its prerequisite line.` : '');
const actionText = it => `${it.action} ${it.target}${it.superseded_by ? ` (superseded by ${it.superseded_by})` : ''}\nReason: ${it.reason}`;
// Cards for the dashboard: pending items with exactly what will happen. Text is redacted again for display (defence in depth).
export function pendingCards(inboxDir, { query = '', kind = '', state = '' } = {}) {
  return allStatuses(inboxDir).filter(s => s.state === 'pending').sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map(s => {
    const l = loadItem(inboxDir, s.id);
    if (!l.ok) return { id: s.id, ...numberFields(s), kind: s.kind, state: s.state, createdAt: s.createdAt ?? null, title: s.title ?? null, hash: s.hash?.slice(0, 12) ?? '', broken: l.reason };
    const it = l.item, clip = (t, n) => redactLong(String(t ?? '').replace(/\r/g, ''), n, ' [cut]').trim();
    return { id: s.id, ...numberFields(s),
      kind: it.kind, state: s.state, createdAt: s.createdAt ?? null, title: clip(it.title, LIMITS.title), why: it.why ? clip(it.why, 400) : null, hash: s.hash.slice(0, 12), body: it.body, prompt: it.prompt, reason: it.reason, target: it.target,
      waitsFor: it.after ? afterLabels(inboxDir, it.after) : undefined,
      will: it.kind === 'host_value' ? `Back up team.local.json, add this value to ${it.key}, check that the file still parses and the configuration is valid. Nothing else changes; no restart is needed.` : it.kind === 'action' ? `${ACTIONS[it.action].will} Target: ${ACTIONS[it.action].noun} ${it.target}.` : it.kind === 'prompt' ? promptWill(it) : 'Post this as a new GitHub issue from the homeowner account, once, with secrets redacted.' + chainNote(inboxDir, it),
      text: it.kind === 'host_value' ? `${it.key} += ${it.value}` : clip(it.kind === 'prompt' ? it.prompt : it.kind === 'action' ? actionText(it) : it.body, LIMITS.prompt) };
  }).filter(card => (!kind || card.kind === kind) && (!state || card.state === state) && matchesInboxSearch(card, query));
}

// Issue #943: items Foreman refused after pickup (a full queue, a failed check) have no GitHub notice either. They are grouped by reason into one
// Needs you line each ("N overseer proposals were refused: reason"), for FAILED_SHOW_MS after the latest refusal. No item content is shown.
export function refusedGroups(inboxDir, now = Date.now()) {
  const groups = new Map();
  for (const s of allStatuses(inboxDir)) {
    if (s.state !== 'refused' || !Number.isFinite(s.updatedAt) || now - s.updatedAt < 0 || now - s.updatedAt > FAILED_SHOW_MS) continue;
    const reason = redactLong(String(s.reason || 'no reason recorded').replace(/\s+/g, ' '), 200, ' [cut]').trim(), g = groups.get(reason) || { reason, count: 0, newest: 0 };
    g.count++; g.newest = Math.max(g.newest, s.updatedAt); groups.set(reason, g);
  }
  return [...groups.values()].sort((a, b) => a.newest - b.newest);
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

// The two decisions. Only a pending item can be decided, once; the hash must still match. Returns { ok, reason?, state?, decidedAt?, undoUntil? }.
// Issue #856: the status keeps the decision and the item's title, so the dashboard can show "Approved 06:20" beside it, and an undo
// window (UNDO_MS) lets a wrong click be taken back while nothing has acted on it.
export const UNDO_MS = 30000;
const titleOf = (inboxDir, id) => { const l = loadItem(inboxDir, id); return l.ok ? redactLong(String(l.item.title ?? '').replace(/\s+/g, ' '), LIMITS.title, ' [cut]').trim() : null; };
export function decide(inboxDir, id, decision, now = Date.now()) {
  if (!['approve', 'reject'].includes(decision)) return { ok: false, reason: 'unknown decision' };
  const s = statusOf(inboxDir, id);
  if (!s) return { ok: false, reason: 'unknown item' };
  if (s.state !== 'pending') return { ok: false, reason: `the item is already ${s.state}` };
  if (decision === 'approve') {
    const l = loadItem(inboxDir, id);
    if (!l.ok) { setStatus(inboxDir, id, { state: 'refused', reason: l.reason }, now); audit(inboxDir, { id, event: 'refused', kind: s.kind, hash: s.hash, reason: l.reason }, now); return { ok: false, reason: l.reason }; }
  }
  const state = decision === 'approve' ? 'approved' : 'rejected';
  setStatus(inboxDir, id, { state, decision, decidedAt: now, title: titleOf(inboxDir, id), ...(decision === 'reject' ? { result: 'rejected by the homeowner; nothing was done' } : {}) }, now);
  audit(inboxDir, { id, event: state, kind: s.kind, hash: s.hash }, now);
  return { ok: true, state, decidedAt: now, undoUntil: now + UNDO_MS };
}
// Issue #856: take a decision back. Allowed only inside UNDO_MS of the decision and only while the state is still the one the click wrote
// (approved or rejected): once the tick has started the job or posted the issue the state has moved on and nothing can be taken back.
// The item returns to pending as it was; the decision fields are removed.
export function undo(inboxDir, id, now = Date.now()) {
  if (!ID_RE.test(String(id))) return { ok: false, reason: 'unknown item' };
  const r = withLock(inboxDir, id, () => {
    const file = path.join(dirs(inboxDir).status, `${id}.json`), s = readJson(file);
    if (!s) return { ok: false, reason: 'unknown item' };
    if (!['approved', 'rejected'].includes(s.state) || !s.decision) return { ok: false, reason: s.state === 'pending' ? 'the item is already pending' : `the item is already ${s.state}; it was acted on and cannot be undone` };
    if (!Number.isFinite(s.decidedAt) || now < s.decidedAt || now - s.decidedAt > UNDO_MS) return { ok: false, reason: 'the undo window has passed' };
    const { decision, decidedAt, title, result, ...rest } = s;
    writeAtomic(file, { ...rest, state: 'pending', id, updatedAt: now });
    audit(inboxDir, { id, event: 'undone', kind: s.kind, hash: s.hash }, now);
    return { ok: true, state: 'pending' };
  });
  return r.locked ? { ok: false, reason: 'the item is being acted on; try again in a moment' } : r.value;
}
// Issue #856: the tick takes an item before any effect. Under the same lock as undo() it re-reads the on-disk state and moves
// `from` to patch.state only if the state is still `from`; false means an Undo (or another writer) won and the effect must not happen.
export function claim(inboxDir, id, from, patch, now = Date.now()) {
  if (!ID_RE.test(String(id))) return false;
  const r = withLock(inboxDir, id, () => {
    if (statusOf(inboxDir, id)?.state !== from) return false;
    finish(inboxDir, id, patch, now);
    return true;
  });
  return !r.locked && r.value === true;
}
// Issue #856: items decided today (the server's calendar day), newest first, for the collapsed "Decided today" list. `undoUntil` is set
// only while an undo is still possible. Nothing beyond the title kept at decision time is shown.
export function decidedCards(inboxDir, now = Date.now()) {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  return allStatuses(inboxDir).filter(s => s.decision && Number.isFinite(s.decidedAt) && s.decidedAt >= day.getTime() && s.decidedAt <= now + 60000)
    .sort((x, y) => y.decidedAt - x.decidedAt).map(s => ({ id: s.id, kind: s.kind || null, title: s.title || null, issue: Number.isSafeInteger(s.issue) && s.issue > 0 && s.issue < 900000000 ? s.issue : null, decision: s.decision, state: s.state || null, decidedAt: s.decidedAt,
      undoUntil: ['approved', 'rejected'].includes(s.state) && now - s.decidedAt <= UNDO_MS ? s.decidedAt + UNDO_MS : null,
      // issue #971: a prompt shows queued (approved), then running in the inbox lane, with the time it waited (so far, or until it started)
      lane: s.kind === 'prompt' && s.decision === 'approve' ? 'inbox' : null, waitedMs: s.kind === 'prompt' && s.decision === 'approve' ? (Number.isFinite(s.waitedMs) ? s.waitedMs : s.state === 'approved' ? Math.max(0, now - s.decidedAt) : null) : null }));
}
export function approvedItems(inboxDir, kind) {
  return allStatuses(inboxDir).filter(s => s.state === 'approved' && s.kind === kind).sort((a, b) => (a.decidedAt || 0) - (b.decidedAt || 0));
}
// Foreman's own transitions (running, posting, done, failed). `result` is redacted and bounded because the overseer reads it.
export function finish(inboxDir, id, patch, now = Date.now()) {
  const clean = { ...patch };
  if (clean.result !== undefined) clean.result = redactLong(String(clean.result), LIMITS.resultChars, ' [cut]');
  if (clean.reason != null) clean.reason = redactLong(String(clean.reason), LIMITS.reasonChars, ' [cut]');
  setStatus(inboxDir, id, clean, now);
  audit(inboxDir, { id, event: clean.state || 'update', kind: statusOf(inboxDir, id)?.kind, hash: statusOf(inboxDir, id)?.hash }, now);
}
// Issue #1122: a path that finds the item unusable records a failure only when no other path owns it. An item already running, done or failed
// belongs to the path that claimed it, and a second "failed" would overwrite its real outcome.  A pending or rejected item (undone after the
// planner picked it) stays as the homeowner left it.
export function failUnlessClaimed(inboxDir, id, reason, now = Date.now()) {
  if (['running', 'done', 'failed', 'pending', 'rejected'].includes(statusOf(inboxDir, id)?.state)) return false;
  finish(inboxDir, id, { state: 'failed', reason, result: 'nothing was done' }, now);
  return true;
}
// A job needs an issue number for its lease; an inbox job has none, so it gets a unique number far above any real issue (never looked up).
export const placeholderIssue = id => 900000000 + parseInt(String(id).slice(0, 6), 16);
// Issue #855: Foreman raises ONE pending item for a host-specific value it observed. The id is derived from the key and value, so a repeat
// (the next tick, a second refused request from the same origin) finds the status already there and raises nothing, whatever its state.
export function raiseHostValue(inboxDir, { key, value, why }, now = Date.now()) {
  const item = { kind: 'host_value', title: `Add ${value} to ${key} in team.local.json`.slice(0, LIMITS.title), key, value, ...(why ? { why } : {}) };
  const v = validateItem(item, { internal: true });
  if (!v.ok) return { raised: false, reason: v.reason };
  const id = crypto.createHash('sha256').update(`host_value\0${key}\0${value}`).digest('hex').slice(0, 32);
  if (statusOf(inboxDir, id)) return { raised: false, id, reason: 'already raised' };
  const d = dirs(inboxDir);
  fs.mkdirSync(d.items, { recursive: true, mode: 0o755 }); fs.mkdirSync(d.status, { recursive: true, mode: 0o755 });
  const file = path.join(d.items, `${id}.json`);
  try { fs.writeFileSync(file, JSON.stringify(v.item, null, 1) + '\n', { mode: 0o644, flag: 'wx' }); } catch { return { raised: false, id, reason: 'item file exists' }; }
  setStatus(inboxDir, id, { state: 'pending', kind: 'host_value', hash: hashOf(v.item), createdAt: now, title: v.item.title }, now);
  audit(inboxDir, { id, event: 'proposed', kind: 'host_value', hash: hashOf(v.item) }, now);
  return { raised: true, id };
}
export const marker = id => `<!-- devtest-inbox v1 ${id} -->`;
