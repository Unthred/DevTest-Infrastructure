// Issue #995: scheduler robustness. Pure helpers (no network, no model) for five guards:
//  1. job liveness: a running job with no transcript, output or progress growth for `job_idle_minutes` is cancelled and requeued;
//  2. a cheap deterministic precheck before a rebase agent starts (git dry-run merge plus the GitHub mergeable test);
//  3. a retry cap: at most `max_same_cause_attempts` attempts per PR per job type for the same failure cause, then a Needs you item;
//  4. honest status for an approved overseer prompt (a "nothing changed" or failed result is failed, not done);
//  5. recovery re-arm: when a halt or breaker clears, items in backoff get a fresh next-try time.
import fs from 'node:fs';
import path from 'node:path';

export const IDLE_DEFAULT_MINUTES = 45;
export const SAME_CAUSE_DEFAULT = 2;
const KEEP_MS = 14 * 86400000;

export const idleLimitMs = limits => (Number.isFinite(limits?.job_idle_minutes) ? limits.job_idle_minutes : IDLE_DEFAULT_MINUTES) * 60000;
export const sameCauseCap = limits => (Number.isSafeInteger(limits?.max_same_cause_attempts) ? limits.max_same_cause_attempts : SAME_CAUSE_DEFAULT);
export function validateRobustLimits(L) {
  const bad = k => { throw new Error(`invalid team limit: ${k}`); };
  if ('job_idle_minutes' in L && !(typeof L.job_idle_minutes === 'number' && L.job_idle_minutes >= 1 && L.job_idle_minutes <= 1440)) bad('job_idle_minutes');
  if ('max_same_cause_attempts' in L && !(Number.isSafeInteger(L.max_same_cause_attempts) && L.max_same_cause_attempts >= 1 && L.max_same_cause_attempts <= 8)) bad('max_same_cause_attempts');
}

// ---- 1. liveness ----
// Last sign of life of a job record: the newest of its progress stamp, its transcript file's mtime and its own update stamp.
export function lastActivityAt(job, transcriptMtime = null) {
  const c = [job?.lastProgress, job?.updatedAt, job?.createdAt, transcriptMtime].filter(Number.isFinite);
  return c.length ? Math.max(...c) : null;
}
export function transcriptMtime(file) { try { return fs.statSync(file).mtimeMs; } catch { return null; } }
// running: [{ id, lastActivityAt }]. Returns the ids idle for longer than limitMs. A job with no known activity time is never cancelled.
export function idleJobs({ running, now, limitMs }) {
  return running.filter(r => Number.isFinite(r.lastActivityAt) && now - r.lastActivityAt > limitMs).map(r => ({ id: r.id, idleMs: now - r.lastActivityAt, lastActivityAt: r.lastActivityAt }));
}

// ---- 3. retry cap ----
// state.sameCause[`${type}:${subject}`] = { cause, count, head, at, raised }. A different cause, or a new head, starts again at 1.
const keyOf = (type, subject) => `${type}:${subject}`;
export function noteFailure(s, { type, subject, cause, head = null }, now) {
  const m = (s.sameCause ||= {}), k = keyOf(type, subject), c = String(cause || 'unknown').slice(0, 60);
  const prev = m[k];
  m[k] = prev && prev.cause === c && (prev.head ?? null) === (head ?? null) ? { ...prev, count: prev.count + 1, at: now } : { cause: c, count: 1, head: head ?? null, at: now, raised: false };
  for (const [key, v] of Object.entries(m)) if (now - (v.at || 0) > KEEP_MS) delete m[key];
  return m[k];
}
export function capped(s, { type, subject, head = null }, cap) {
  const r = s.sameCause?.[keyOf(type, subject)];
  return !!r && r.count >= cap && (r.head ?? null) === (head ?? null);
}
// A success on the subject clears its record.
export function noteSuccessFor(s, { type, subject }) { if (s.sameCause) delete s.sameCause[keyOf(type, subject)]; }
export function cappedItems(s, cap) {
  return Object.entries(s.sameCause || {}).filter(([, v]) => v.count >= cap).map(([k, v]) => {
    const i = k.indexOf(':');
    return { id: `retrycap-${k.replace(/[^A-Za-z0-9]/g, '-')}`, type: k.slice(0, i), subject: k.slice(i + 1), cause: v.cause, attempts: v.count, head: v.head, since: v.at };
  });
}
// Drop the actions whose (type, PR or issue, head) reached the cap. Returns { kept, stopped }.
export function filterCapped(s, actions, cap) {
  const kept = [], stopped = [];
  for (const a of actions) {
    const subject = a.pr ?? a.issue;
    if (a.type !== 'merge' && subject != null && capped(s, { type: a.type, subject, head: a.head ?? null }, cap)) stopped.push(a); else kept.push(a);
  }
  return { kept, stopped };
}

// ---- 2. rebase precheck ----
// probe: { conflicts: boolean } from a git dry-run merge (null when it could not run); pull: GitHub's view of the PR.
// The agent is needed unless the merge is clean, GitHub reports the PR mergeable and it is not behind its base. Anything unknown means needed.
export function rebaseNeeded({ probe, pull }) {
  if (!probe || typeof probe.conflicts !== 'boolean') return { needed: true, why: 'the dry-run merge could not run' };
  if (probe.conflicts) return { needed: true, why: 'the dry-run merge conflicts' };
  if (!pull) return { needed: true, why: 'the pull request could not be read' };
  if (pull.mergeable !== 'MERGEABLE') return { needed: true, why: `GitHub reports the pull request ${String(pull.mergeable || 'unknown').toLowerCase()}` };
  if (pull.mergeStateStatus === 'BEHIND') return { needed: true, why: 'the branch is behind its base' };
  return { needed: false, why: 'the dry-run merge is clean and GitHub reports the pull request mergeable and up to date' };
}

// ---- 4. honest inbox result ----
// The prompt asks for a first line `STATUS: done|failed|nothing_changed`. Without it, an obvious "nothing changed" statement still fails.
export function inboxOutcome(summary) {
  const text = String(summary || '').trim();
  if (!text) return { ok: false, why: 'it left no summary', code: 'no_summary' };
  const m = /^status:\s*([a-z_ -]+)/i.exec(text);
  if (m) {
    const v = m[1].trim().toLowerCase().replace(/[ -]+/g, '_');
    if (v === 'done') return { ok: true };
    if (v === 'nothing_changed') return { ok: false, why: 'the agent reported that it changed nothing', code: 'nothing_changed' };
    return { ok: false, why: 'the agent reported that it did not achieve the task', code: 'failed' };
  }
  const notAchieved = /^(nothing (was )?(changed|done)|no changes?( were)? made|failed|could not|unable to)\b/i.test(text);
  if (notAchieved) {
    const code = /^(nothing|no change)/i.test(text) ? 'nothing_changed' : 'failed';
    return { ok: false, why: 'the summary says the task was not achieved', code };
  }
  return { ok: true };
}

// ---- 5. re-arm ----
export const rearmFile = root => path.join(root, 'team', 'rearm.json');
export function haltScopes(b) { return [...Object.keys(b?.halts || {}), ...(b?.global ? ['@global'] : [])].sort(); }
// Scopes that were held last tick and are not now: the halt cleared (by success or a person).
export const clearedScopes = (prev, now) => (prev || []).filter(x => !now.includes(x));
export function writeRearm(root, at, scopes) {
  fs.mkdirSync(path.dirname(rearmFile(root)), { recursive: true, mode: 0o700 });
  const f = rearmFile(root), tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ at, scopes }) + '\n', { mode: 0o600 }); fs.renameSync(tmp, f);
}
export function readRearm(root) { try { const r = JSON.parse(fs.readFileSync(rearmFile(root), 'utf8')); return Number.isFinite(r?.at) ? r : null; } catch { return null; } }
// Apply a re-arm to the upgrader's state: no install or fetch waits for a backoff that was earned before the recovery. Returns what changed.
export function rearmUpgradeState(s, mark, now) {
  if (!mark || mark.at <= (s.rearmedAt || 0)) return [];
  const out = [];
  if (s.fetchRetryAt) { delete s.fetchRetryAt; delete s.fetchFailures; out.push('GitHub fetch backoff'); }
  if (s.install?.result === 'transient' && Number.isFinite(s.install.nextAttemptAt)) { s.install = { ...s.install, nextAttemptAt: now }; out.push('install retry'); }
  // An install left 'blocked' by a pre-check is latched for its commit with no retry time; the recovery lifts the latch so it is tried again now.
  if (s.install?.result === 'blocked' && s.install.sha && s.prechecked?.[s.install.sha] !== undefined) { delete s.prechecked[s.install.sha]; delete s.lastUpgradeAt; s.install = { ...s.install, result: 'transient', nextAttemptAt: now, reason: `re-armed after a recovery; was: ${s.install.reason}` }; out.push('blocked install'); }
  for (const [sha, v] of Object.entries(s.prechecked || {})) if (v && typeof v === 'object' && v.environmental) { delete s.prechecked[sha]; out.push('install pre-check wait'); }
  s.rearmedAt = mark.at;
  return out;
}
