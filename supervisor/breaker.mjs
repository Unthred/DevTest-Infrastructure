// Issue #549: a circuit breaker for work that spends usage and produces nothing. Pure functions over the job records and the
// breaker state kept in the Foreman state file (so a restart keeps a halt). Nothing here kills a job or loosens a review gate.
// A halt ends in two ways only (issue #626): a later job of the halted type succeeds (succeeded()), or the homeowner resumes it (resume(),
// from the terminal or the dashboard's Resume button).
import { formatCost } from './money.mjs';
import fs from 'node:fs';
import { typeOfKind } from './models.mjs';

export const BREAKER_DEFAULTS = Object.freeze({
  enabled: true,
  window_hours: 6,          // waste older than this no longer counts toward a trip
  same_cause_jobs: 3,       // this many wasted jobs of one cause on the SAME pull request (or issue) inside the window trips that cause
  cause_cost_usd: 5,        // or this much usage-equivalent waste of one cause
  global_cost_usd: 15,      // this much waste across causes stops every new job (the install path and merges are not jobs)
  fix_issues: [],           // issue numbers whose implement/continue job may still start while its job type is halted
});
const KEYS = Object.keys(BREAKER_DEFAULTS);
const KEEP_MS = 7 * 24 * 3600000;   // waste records kept for the dashboard view
const KEEP_MAX = 1000;

export function validateBreakerConfig(b) {
  if (b === undefined) return { ...BREAKER_DEFAULTS, fix_issues: [] };
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).some(k => !KEYS.includes(k))) throw new Error('invalid team config: breaker');
  const out = { ...BREAKER_DEFAULTS, ...b };
  if (typeof out.enabled !== 'boolean') throw new Error('invalid team config: breaker.enabled');
  for (const k of ['window_hours', 'cause_cost_usd', 'global_cost_usd']) if (!(Number.isFinite(out[k]) && out[k] > 0 && out[k] <= 100000)) throw new Error(`invalid team config: breaker.${k}`);
  if (!(Number.isSafeInteger(out.same_cause_jobs) && out.same_cause_jobs >= 1 && out.same_cause_jobs <= 1000)) throw new Error('invalid team config: breaker.same_cause_jobs');
  if (!Array.isArray(out.fix_issues) || !out.fix_issues.every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('invalid team config: breaker.fix_issues');
  if (out.global_cost_usd < out.cause_cost_usd) throw new Error('invalid team config: breaker.global_cost_usd must not be below breaker.cause_cost_usd');
  return out;
}

// A stable code for a verdict that failed validation. It is derived from which rule refused it, never from the figures or names the
// message carries, so the same rule is the same cause when a PR number, SHA or claim text changes.
const VERDICT_RULES = [
  [/^no verdict file/, 'no-verdict-file'], [/^unreadable verdict file/, 'unreadable-verdict-file'], [/^invalid ticket/, 'invalid-ticket'],
  [/not an object/, 'not-an-object'], [/unknown field/, 'unknown-field'], [/different PR/, 'wrong-pr'], [/different head/, 'wrong-head'],
  [/must be PASS or CHANGES/, 'bad-verdict'], [/^findings must/, 'bad-findings'], [/^commandsRun/, 'bad-commands-run'],
  [/^CHANGES needs/, 'changes-without-blocking'], [/^PASS cannot have a blocking/, 'pass-with-blocking'],
  [/^requirements must/, 'bad-requirements'], [/^descriptionClaims must/, 'bad-claims'], [/immaterial/, 'immaterial-claim'],
  [/^PASS cannot have an unmet/, 'pass-with-unmet'],
];
export function verdictErrorCode(error) {
  const text = String(error || '');
  return (VERDICT_RULES.find(([re]) => re.test(text)) || [null, 'other'])[1];
}

const num = v => (Number.isFinite(v) && v >= 0 ? v : 0);
const NOT_WASTE = new Set(['usage_limit', 'rate_limit']);   // the provider's own allowance, handled by D-019; not a repeating fault

// Is this finished job a wasted one? `entry` is the Foreman's record of it, `job` the supervisor's record. `verdictRecorded` says a
// usable verdict from this job is on file; `refusal` is a stable code when ingestion threw the result away. Returns a waste record or null.
export function wasteOf({ id, entry, job, verdictRecorded = false, refusal = null }) {
  if (!entry || !job || !['completed', 'failed', 'blocked'].includes(job.status)) return null;
  const type = typeOfKind(entry.kind || job.kind || '');
  if (type === 'merge') return null;
  const usage = job.usage || {};
  const tokens = num(usage.inputTokens) + num(usage.outputTokens);
  if (!tokens && !num(usage.costUsdEstimate)) return null;   // spent nothing: nothing was wasted
  let cause = null;
  if (refusal) cause = `refused:${refusal}`;
  else if (job.status === 'completed') {
    // A review that completed with no usable verdict is waste; completed repair or implement work met its post-condition (it pushed).
    if (type === 'review' && !verdictRecorded) cause = `no-verdict:${job.incompleteReason?.cause || 'postcondition_not_met'}`;
  } else if (!(type === 'review' && verdictRecorded)) {
    // The cause is why the job stopped, never the session-resume decision (that is set on every attempt and says nothing about the stop).
    const why = job.incompleteReason?.cause || job.lastEvent || job.status;
    const allowanceStop = NOT_WASTE.has(String(why)) || NOT_WASTE.has(String(job.lastEvent)) || (num(job.usageLimitHits) > 0 && why === 'retry_exhausted');
    // retry_exhausted after usage-limit waits is the allowance, but only when no other specific stop reason is recorded: a job that hit the limit once and later failed for an unrelated cause is real waste.
    if (!allowanceStop) cause = `${job.status}:${String(why).slice(0, 48)}`;
  }
  if (!cause) return null;
  return {
    job: String(id || job.id), at: Number.isFinite(job.updatedAt) ? job.updatedAt : 0, created: Number.isFinite(job.createdAt) ? job.createdAt : null, type, cause: `${type}:${cause}`.slice(0, 120),
    agent: entry.agent ?? null, pr: entry.pr ?? null, issue: entry.issue ?? null, model: job.model ?? entry.model ?? null,
    inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens), tokens, cost: num(usage.costUsdEstimate),
  };
}

export const emptyState = () => ({ waste: {}, successes: {}, halts: {}, global: null, clearedAt: {}, error: null, history: [] });
// Issue #625: one history entry per trip (kept after the halt is cleared) so the overseer can read cause, jobs, cost, when it
// tripped and when it cleared. Figures follow the halt while it is held and stop at the clear. Never holds job content.
const HISTORY_MAX = 100;
const histFields = h => ({ trippedBy: h.trippedBy, jobs: h.jobs, tokens: h.tokens, cost: h.cost, prs: h.prs, issues: h.issues, types: h.types, jobIds: (h.jobIds || []).slice(0, 10) });
const openHistory = (s, scope, since) => (s.history || []).find(t => t.scope === scope && t.since === since && t.clearedAt == null);
function noteTrip(s, scope, h) {
  s.history ||= [];
  const open = openHistory(s, scope, h.since);
  if (open) Object.assign(open, histFields(h)); else s.history.push({ scope, since: h.since, clearedAt: null, ...histFields(h) });
  if (s.history.length > HISTORY_MAX) s.history = s.history.slice(-HISTORY_MAX);
}
function noteClear(s, scope, since, now) { const open = openHistory(s, scope, since); if (open) open.clearedAt = now; }
export function normalize(s) {
  s ||= {};
  s.waste ||= {}; s.successes ||= {}; s.halts ||= {}; s.clearedAt ||= {}; s.history ||= []; if (s.global === undefined) s.global = null; if (s.error === undefined) s.error = null;
  return s;
}
export function record(s, w, now) {
  normalize(s);
  if (!w || s.waste[w.job]) return false;
  s.waste[w.job] = w;
  const old = Object.values(s.waste).filter(x => now - x.at > KEEP_MS).map(x => x.job);
  for (const j of old) delete s.waste[j];
  const over = Object.values(s.waste).sort((a, b) => a.at - b.at).slice(0, Math.max(0, Object.keys(s.waste).length - KEEP_MAX));
  for (const x of over) delete s.waste[x.job];
  return true;
}

// Issue #865: a finished job that was not waste is kept (type, subject, when it began and ended) so that waste it came after can be
// recognised as superseded whenever the breaker is evaluated, including after a restart. Never holds job content.
export function noteSuccess(s, { job, type, pr = null, issue = null, created = null, at = 0 }, now) {
  normalize(s);
  if (!job || !type || type === 'merge' || s.successes[job]) return false;
  s.successes[job] = { job: String(job), type, pr, issue, created: Number.isFinite(created) ? created : null, at: Number.isFinite(at) ? at : 0 };
  for (const x of Object.values(s.successes)) if (now - (x.at || x.created || 0) > KEEP_MS) delete s.successes[x.job];
  const over = Object.values(s.successes).sort((a, b) => a.at - b.at).slice(0, Math.max(0, Object.keys(s.successes).length - KEEP_MAX));
  for (const x of over) delete s.successes[x.job];
  return true;
}
// Waste is superseded when a later job of the same type succeeded on the same pull request (or, with none, the same issue). "Later"
// means it began after the wasted job began; a record without a start time falls back to the success finishing after the waste did.
export function superseded(s, w) {
  const same = w.pr != null ? x => x.pr === w.pr : w.issue != null ? x => x.pr == null && x.issue === w.issue : null;
  if (!same) return false;
  return Object.values(s.successes || {}).some(x => x.type === w.type && x.job !== w.job && same(x) && (Number.isFinite(w.created) && Number.isFinite(x.created) ? x.created > w.created : x.at > w.at));
}

const sum = (list, k) => list.reduce((n, x) => n + x[k], 0);
const figures = list => ({ jobs: list.length, tokens: sum(list, 'tokens'), inputTokens: sum(list, 'inputTokens'), outputTokens: sum(list, 'outputTokens'), cost: sum(list, 'cost'),
  prs: [...new Set(list.map(x => x.pr).filter(n => n != null))].sort((a, b) => a - b), issues: [...new Set(list.map(x => x.issue).filter(n => n != null))].sort((a, b) => a - b),
  types: [...new Set(list.map(x => x.type))].sort(), jobIds: list.map(x => x.job) });
// Issue #626: repeated failure means the same pull request (or issue) failing again, not a few failures across unrelated ones.
// Waste with neither is counted together, since nothing tells them apart.
const subjectOf = w => w.pr != null ? `pr:${w.pr}` : w.issue != null ? `issue:${w.issue}` : 'none';
export function worstSubject(list) {
  const n = new Map();
  for (const w of list) n.set(subjectOf(w), (n.get(subjectOf(w)) || 0) + 1);
  return Math.max(0, ...n.values());
}
// The subjects a halt holds. A count trip holds only the subjects that repeated; a cost trip holds every subject that wasted. Work of the
// halted type on any other pull request or issue still runs, so a later success can clear the halt (a halt that stopped every job of
// the type could never be cleared by one). Waste with no subject holds the whole type.
const heldSubjects = (list, limit, byCount) => {
  const n = new Map();
  for (const w of list) n.set(subjectOf(w), (n.get(subjectOf(w)) || 0) + 1);
  return [...n].filter(([k, c]) => !byCount || c >= limit || k === 'none').map(([k]) => k).sort();
};
// An action's subjects: a continue job carries both its pull request and its issue, and waste may have been recorded under either (issue #737).
const actSubjects = a => { const l = []; if (a.pr != null) l.push(`pr:${a.pr}`); if (a.issue != null) l.push(`issue:${a.issue}`); return l.length ? l : ['none']; };
const clearedFor = (s, cause) => Math.max(s.clearedAt['*'] || 0, s.clearedAt[cause] || 0);

// Trip any limit that is reached. Existing halts are never removed here; only their figures are refreshed from the waste still on file.
export function evaluate(s, limits, now) {
  normalize(s);
  const trips = [];
  if (!limits.enabled) return trips;
  const window = limits.window_hours * 3600000;
  const inWindow = Object.values(s.waste).filter(w => now - w.at <= window && w.at > clearedFor(s, w.cause));
  const gone = new Set(inWindow.filter(w => superseded(s, w)).map(w => w.job));   // issue #865: a later same-type success on the same PR settles it
  const live = inWindow.filter(w => !gone.has(w.job));
  // A halt whose waste is all superseded ends by itself; one with other live waste, or with no waste left in the window, is untouched.
  for (const [cause, h] of Object.entries(s.halts)) {
    if (live.some(w => w.cause === cause) || !inWindow.some(w => w.cause === cause)) continue;
    noteClear(s, cause, h.since, now); delete s.halts[cause]; s.clearedAt[cause] = now;
    s.resumes = [...(s.resumes || []), { at: now, scope: 'superseded', cleared: [cause], by: 'success' }].slice(-50);
  }
  if (s.global && inWindow.length && !live.length) {
    noteClear(s, '@global', s.global.since, now); s.global = null; s.clearedAt['@global'] = now;
    s.resumes = [...(s.resumes || []), { at: now, scope: 'superseded', cleared: ['@global'], by: 'success' }].slice(-50);
  }
  const byCause = new Map();
  for (const w of live) { if (!byCause.has(w.cause)) byCause.set(w.cause, []); byCause.get(w.cause).push(w); }
  // $5 of waste of any kind: when all live waste together reaches the cost limit, every cause that contributed is halted in its own scope.
  const byTotal = sum(live, 'cost') >= limits.cause_cost_usd;
  for (const [cause, list] of byCause) {
    const f = figures(list), byCount = worstSubject(list) >= limits.same_cause_jobs, byCost = f.cost >= limits.cause_cost_usd;
    const held = s.halts[cause];
    if (held) {
      // A halt recorded before subjects existed (issue #737) keeps holding the whole type, as it did when it tripped; giving it an empty
      // list would hold nothing while the dashboard still said "Work halted".
      const subjects = Array.isArray(held.subjects) ? { subjects: [...new Set([...held.subjects, ...heldSubjects(list, limits.same_cause_jobs, held.trippedBy === 'count')])].sort() } : {};
      s.halts[cause] = { ...held, ...f, ...subjects }; noteTrip(s, cause, s.halts[cause]); continue;
    }
    if (!byCount && !byCost && !byTotal) continue;
    s.halts[cause] = { cause, since: now, trippedBy: byCount ? 'count' : byCost ? 'cost' : 'any-kind-cost', ...f, subjects: heldSubjects(list, limits.same_cause_jobs, byCount) };
    noteTrip(s, cause, s.halts[cause]);
    trips.push({ scope: cause, trippedBy: s.halts[cause].trippedBy });
  }
  const globalList = live.filter(w => w.at > (s.clearedAt['@global'] || 0));
  const gf = figures(globalList);
  if (s.global) { s.global = { ...s.global, ...gf, causes: [...new Set(globalList.map(w => w.cause))] }; noteTrip(s, '@global', s.global); }
  else if (gf.cost >= limits.global_cost_usd) { s.global = { since: now, trippedBy: 'cost', ...gf, causes: [...new Set(globalList.map(w => w.cause))] }; noteTrip(s, '@global', s.global); trips.push({ scope: '@global', trippedBy: 'cost' }); }
  return trips;
}

// Does a halt stop this action? Merges are not jobs and always go ahead. Returns the halt or null.
export function blocks(s, limits, act) {
  if (!limits.enabled || !s) return null;
  // Issue #1238: an approved overseer prompt (issue #124) is its own job type. A halt of implement jobs does not stop it; the global halt, a
  // halt whose cause lists the prompt type, or a prompt that is itself an implement job (act.implement) does.
  const type = typeOfKind(act.type === 'inbox' && act.implement ? 'implement' : act.type || '');
  if (type === 'merge') return null;
  if (s.global) return { ...s.global, cause: '@global', scope: 'all new jobs' };
  const fixable = ['implement', 'continue'].includes(type) && (limits.fix_issues || []).includes(act.issue);
  if (fixable) return null;
  const subjects = actSubjects(act);
  for (const h of Object.values(s.halts || {})) {
    if (!(h.types || []).includes(type)) continue;
    if (Array.isArray(h.subjects) && !h.subjects.includes('none') && !subjects.includes('none') && !subjects.some(x => h.subjects.includes(x))) continue;   // another pull request or issue may run, and its success clears this halt
    return h;
  }
  return null;
}
export const filterActions = (s, limits, actions) => {
  const kept = [], stopped = [];
  for (const a of actions) { const h = blocks(s, limits, a); if (h) stopped.push({ action: a, cause: h.cause }); else kept.push(a); }
  return { kept, stopped };
};

// Issue #626: a finished, successful job of a halted type ends the halt for that cause. Only a job created after the halt began counts,
// so a job already running when it tripped cannot clear it. The global halt is not cleared this way (it stops every type). Returns the
// causes cleared.
export function succeeded(s, { type, createdAt }, now) {
  normalize(s);
  if (!type || type === 'merge' || !Number.isFinite(createdAt)) return [];
  const cleared = [];
  for (const [cause, h] of Object.entries(s.halts)) {
    if (!(h.types || []).includes(type) || !(createdAt > h.since)) continue;
    noteClear(s, cause, h.since, now); delete s.halts[cause]; s.clearedAt[cause] = now; cleared.push(cause);
  }
  if (cleared.length) s.resumes = [...(s.resumes || []), { at: now, scope: `success:${type}`, cleared, by: 'success' }].slice(-50);
  return cleared;
}

// Clear one cause, the global halt, or everything. Reached from the homeowner's CLI (see cli.mjs) or from a Resume click on the dashboard
// (issue #626, applied by the tick). Waste on file before now no
// longer counts, so a cleared scope does not trip again from the same old jobs.
export function resume(s, scope, now) {
  normalize(s);
  const cleared = [];
  if (scope === 'all') {
    for (const [c, h] of Object.entries(s.halts)) { cleared.push(c); noteClear(s, c, h.since, now); }
    if (s.global) { cleared.push('@global'); noteClear(s, '@global', s.global.since, now); }
    s.halts = {}; s.global = null; s.clearedAt = { '*': now, '@global': now };
  } else if (scope === '@global' || scope === 'global') {
    if (s.global) { cleared.push('@global'); noteClear(s, '@global', s.global.since, now); }
    s.global = null; s.clearedAt['@global'] = now;
  } else if (s.halts[scope]) {
    noteClear(s, scope, s.halts[scope].since, now); delete s.halts[scope]; s.clearedAt[scope] = now; cleared.push(scope);
  }
  if (cleared.length) s.resumes = [...(s.resumes || []), { at: now, scope, cleared }].slice(-50);
  return cleared;
}

// Waste by cause over a range, for the dashboard and the replay: [{ cause, jobs, tokens, cost, halted }] largest cost first.
export function byCause(s, { since = 0, until = Infinity } = {}) {
  const groups = new Map();
  for (const w of Object.values(normalize(s).waste)) {
    if (!w || typeof w !== 'object') continue;   // the dashboard still renders when a record is corrupt; the tick reports it
    if (w.at < since || w.at > until) continue;
    if (!groups.has(w.cause)) groups.set(w.cause, []);
    groups.get(w.cause).push(w);
  }
  return [...groups].map(([cause, list]) => ({ cause, ...figures(list), jobIds: undefined, halted: !!s.halts[cause] })).sort((a, b) => b.cost - a.cost);
}

// What the Needs you item and the Overview say. `running` is the list of jobs still going: [{ id, type, ref }].
// Display text for each trippedBy value. 'cost' is a single cause's own waste, or (with scope @global) the higher cross-cause limit.
export const TRIPPED_BY_LABEL = {
  count: 'same cause repeated on one pull request',
  cost: 'cost limit',
  'any-kind-cost': 'cost of waste of any kind',
};
export const trippedByLabel = (v) => (v == null ? '' : Object.hasOwn(TRIPPED_BY_LABEL, v) ? TRIPPED_BY_LABEL[v] : String(v));
export const COST_LABEL = 'usage equivalent (the CLI\'s own estimate; plan usage is not a cash charge)';
export function haltView(s, running = []) {
  normalize(s);
  const entries = [...(s.global ? [{ ...s.global, cause: '@global' }] : []), ...Object.values(s.halts)].sort((a, b) => a.since - b.since);
  if (!entries.length) return null;
  const top = entries[0], scope = top.cause === '@global' ? 'every new job (merges and the install path continue)' : `new ${top.types.join('/')} jobs`;
  const fmt = n => formatCost(n);   // issue #1097
  return {
    halted: true, count: entries.length, cause: top.cause, since: top.since, scope, jobs: top.jobs, tokens: top.tokens, cost: top.cost, costLabel: COST_LABEL, prs: top.prs, trippedBy: top.trippedBy, trippedByLabel: trippedByLabel(top.trippedBy),
    running: running.map(r => ({ ...r })),
    text: `Work halted: ${top.cause === '@global' ? 'wasted usage across causes reached the higher limit' : `cause ${top.cause}`}. ${top.jobs} wasted job${top.jobs === 1 ? '' : 's'}, ${top.tokens.toLocaleString('en-GB')} tokens, ${fmt(top.cost)} ${COST_LABEL}.${top.prs.length ? ` Affected: ${top.prs.map(n => '#' + n).join(', ')}.` : ''} Stopped: ${scope}.`,
    running_text: running.length ? `Still running: ${running.map(r => `${r.type} ${r.ref ?? ''}`.trim()).join(', ')}.` : 'Nothing is still running.',
    action: `Fix the cause, then press Resume on the dashboard, or run: ai-supervisor team breaker resume ${top.cause === '@global' ? 'global' : top.cause} (or "all"). It clears itself when a later job of the halted type succeeds, and otherwise stays halted across restarts until you resume it.`,
    entries: entries.map(e => ({ cause: e.cause, since: e.since, jobs: e.jobs, tokens: e.tokens, cost: e.cost, prs: e.prs, types: e.types, trippedBy: e.trippedBy, trippedByLabel: trippedByLabel(e.trippedBy) })),
  };
}

// Issue #549: only a person at a terminal may resume, and never a process that descends from a supervised job. The supervisor marks
// every job's environment (JOB_MARKER); a pty from `script` still inherits it, and the check also walks the parent chain reading each
// ancestor's environment, which blocks `env -u` while an ancestor is alive. This is a guard against accident, not a security boundary: there is no supported route for a job, and a deliberately detached process (for example under setsid) is not caught. (An agent with full access could still edit the state file by hand; that is a
// breach of its instructions, not a supported route, and every resume is recorded in resumes[].)
export const JOB_MARKER = 'AI_SUPERVISOR_JOB';
export function underSupervisedJob({ env = process.env, pid = process.pid, readProc = p => fs.readFileSync(p, 'utf8') } = {}) {
  if (env[JOB_MARKER]) return true;
  let cur = pid;
  for (let i = 0; i < 64 && cur > 1; i++) {
    try {
      if (readProc(`/proc/${cur}/environ`).split('\0').some(e => e.startsWith(JOB_MARKER + '='))) return true;
      const stat = readProc(`/proc/${cur}/stat`);
      cur = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    } catch { break; }
  }
  return false;
}
export function resumeAllowed({ stdin = process.stdin, stdout = process.stdout, env = process.env, pid = process.pid, readProc } = {}) {
  return !!(stdin?.isTTY && stdout?.isTTY) && !underSupervisedJob({ env, pid, readProc });
}

// Replay finished job records through the same rules, in time order, to show when the breaker would have tripped and what it would
// have saved: the cost and tokens of the wasted jobs that were created after a trip and fall in the halted scope. Read-only.
// `entries` is the Foreman's per-job record map (kind, pr, issue, agent); `verdictJobs` the ids that left a usable verdict.
export function replay({ jobs, entries = {}, verdictJobs = new Set(), limits = BREAKER_DEFAULTS, from = 0, to = Infinity }) {
  const items = [];
  for (const job of jobs) {
    if (!job || job.unreadable || !(job.updatedAt >= from && job.updatedAt <= to)) continue;
    const w = wasteOf({ id: job.id, entry: entries[job.id] || { kind: job.kind, issue: job.issue ?? null, agent: job.provider ?? null, pr: job.postcondition?.pr ?? null }, job, verdictRecorded: verdictJobs.has(job.id) });
    if (w) items.push({ w, created: Number.isFinite(job.createdAt) ? job.createdAt : w.at });
  }
  items.sort((a, b) => a.w.at - b.w.at);
  const s = emptyState(), trips = [];
  for (const { w } of items) {
    record(s, w, w.at);
    for (const t of evaluate(s, limits, w.at)) trips.push({ ...t, at: w.at, halt: t.scope === '@global' ? s.global : s.halts[t.scope] });
  }
  const saved = trips.map(t => {
    const later = items.filter(i => i.created > t.at && (t.scope === '@global' || (t.halt.types.includes(i.w.type) && i.w.cause === t.scope)));
    return { scope: t.scope, at: t.at, trippedBy: t.trippedBy, jobsPrevented: later.length, tokensSaved: sum(later.map(i => i.w), 'tokens'), costSaved: sum(later.map(i => i.w), 'cost') };
  });
  const all = items.map(i => i.w);
  return { wasted: figures(all), trips: saved, byCause: byCause({ ...emptyState(), waste: Object.fromEntries(all.map(w => [w.job, w])) }) };
}
