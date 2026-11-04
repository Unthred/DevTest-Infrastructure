// Issue #549: a circuit breaker for work that spends usage and produces nothing. Pure functions over the job records and the
// breaker state kept in the Foreman state file (so a restart keeps a halt). Nothing here kills a job, loosens a review gate or
// clears itself: a halt ends only by an explicit resume from the homeowner (see resume()).
import fs from 'node:fs';
import { typeOfKind } from './models.mjs';

export const BREAKER_DEFAULTS = Object.freeze({
  enabled: true,
  window_hours: 6,          // waste older than this no longer counts toward a trip
  same_cause_jobs: 3,       // this many wasted jobs of one cause inside the window trips that cause
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
    if (!allowanceStop) cause = `${job.status}:${String(why).slice(0, 48)}`;
  }
  if (!cause) return null;
  return {
    job: String(id || job.id), at: Number.isFinite(job.updatedAt) ? job.updatedAt : 0, type, cause: `${type}:${cause}`.slice(0, 120),
    agent: entry.agent ?? null, pr: entry.pr ?? null, issue: entry.issue ?? null, model: job.model ?? entry.model ?? null,
    inputTokens: num(usage.inputTokens), outputTokens: num(usage.outputTokens), tokens, cost: num(usage.costUsdEstimate),
  };
}

export const emptyState = () => ({ waste: {}, halts: {}, global: null, clearedAt: {}, error: null });
export function normalize(s) {
  s ||= {};
  s.waste ||= {}; s.halts ||= {}; s.clearedAt ||= {}; if (s.global === undefined) s.global = null; if (s.error === undefined) s.error = null;
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

const sum = (list, k) => list.reduce((n, x) => n + x[k], 0);
const figures = list => ({ jobs: list.length, tokens: sum(list, 'tokens'), inputTokens: sum(list, 'inputTokens'), outputTokens: sum(list, 'outputTokens'), cost: sum(list, 'cost'),
  prs: [...new Set(list.map(x => x.pr).filter(n => n != null))].sort((a, b) => a - b), issues: [...new Set(list.map(x => x.issue).filter(n => n != null))].sort((a, b) => a - b),
  types: [...new Set(list.map(x => x.type))].sort(), jobIds: list.map(x => x.job) });
const clearedFor = (s, cause) => Math.max(s.clearedAt['*'] || 0, s.clearedAt[cause] || 0);

// Trip any limit that is reached. Existing halts are never removed here; only their figures are refreshed from the waste still on file.
export function evaluate(s, limits, now) {
  normalize(s);
  const trips = [];
  if (!limits.enabled) return trips;
  const window = limits.window_hours * 3600000;
  const live = Object.values(s.waste).filter(w => now - w.at <= window && w.at > clearedFor(s, w.cause));
  const byCause = new Map();
  for (const w of live) { if (!byCause.has(w.cause)) byCause.set(w.cause, []); byCause.get(w.cause).push(w); }
  // $5 of waste of any kind: when all live waste together reaches the cost limit, every cause that contributed is halted in its own scope.
  const byTotal = sum(live, 'cost') >= limits.cause_cost_usd;
  for (const [cause, list] of byCause) {
    const f = figures(list), byCount = list.length >= limits.same_cause_jobs, byCost = f.cost >= limits.cause_cost_usd;
    const held = s.halts[cause];
    if (held) { s.halts[cause] = { ...held, ...f }; continue; }
    if (!byCount && !byCost && !byTotal) continue;
    s.halts[cause] = { cause, since: now, trippedBy: byCount ? 'count' : 'cost', ...f };
    trips.push({ scope: cause, trippedBy: s.halts[cause].trippedBy });
  }
  const globalList = live.filter(w => w.at > (s.clearedAt['@global'] || 0));
  const gf = figures(globalList);
  if (s.global) s.global = { ...s.global, ...gf, causes: [...new Set(globalList.map(w => w.cause))] };
  else if (gf.cost >= limits.global_cost_usd) { s.global = { since: now, trippedBy: 'cost', ...gf, causes: [...new Set(globalList.map(w => w.cause))] }; trips.push({ scope: '@global', trippedBy: 'cost' }); }
  return trips;
}

// Does a halt stop this action? Merges are not jobs and always go ahead. Returns the halt or null.
export function blocks(s, limits, act) {
  if (!limits.enabled || !s) return null;
  const type = typeOfKind(act.type || '');
  if (type === 'merge') return null;
  if (s.global) return { ...s.global, cause: '@global', scope: 'all new jobs' };
  const fixable = ['implement', 'continue'].includes(type) && (limits.fix_issues || []).includes(act.issue);
  if (fixable) return null;
  for (const h of Object.values(s.halts || {})) if ((h.types || []).includes(type)) return h;
  return null;
}
export const filterActions = (s, limits, actions) => {
  const kept = [], stopped = [];
  for (const a of actions) { const h = blocks(s, limits, a); if (h) stopped.push({ action: a, cause: h.cause }); else kept.push(a); }
  return { kept, stopped };
};

// Clear one cause, the global halt, or everything. Only the homeowner's CLI calls this (see cli.mjs). Waste on file before now no
// longer counts, so a cleared scope does not trip again from the same old jobs.
export function resume(s, scope, now) {
  normalize(s);
  const cleared = [];
  if (scope === 'all') {
    for (const c of Object.keys(s.halts)) cleared.push(c);
    if (s.global) cleared.push('@global');
    s.halts = {}; s.global = null; s.clearedAt = { '*': now, '@global': now };
  } else if (scope === '@global' || scope === 'global') {
    if (s.global) cleared.push('@global');
    s.global = null; s.clearedAt['@global'] = now;
  } else if (s.halts[scope]) {
    delete s.halts[scope]; s.clearedAt[scope] = now; cleared.push(scope);
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
export const COST_LABEL = 'usage equivalent (the CLI\'s own estimate; plan usage is not a cash charge)';
export function haltView(s, running = []) {
  normalize(s);
  const entries = [...(s.global ? [{ ...s.global, cause: '@global' }] : []), ...Object.values(s.halts)].sort((a, b) => a.since - b.since);
  if (!entries.length) return null;
  const top = entries[0], scope = top.cause === '@global' ? 'every new job (merges and the install path continue)' : `new ${top.types.join('/')} jobs`;
  const fmt = n => `$${n.toFixed(2)}`;
  return {
    halted: true, count: entries.length, cause: top.cause, since: top.since, scope, jobs: top.jobs, tokens: top.tokens, cost: top.cost, costLabel: COST_LABEL, prs: top.prs, trippedBy: top.trippedBy,
    running: running.map(r => ({ ...r })),
    text: `Work halted: ${top.cause === '@global' ? 'wasted usage across causes reached the higher limit' : `cause ${top.cause}`}. ${top.jobs} wasted job${top.jobs === 1 ? '' : 's'}, ${top.tokens.toLocaleString('en-GB')} tokens, ${fmt(top.cost)} ${COST_LABEL}.${top.prs.length ? ` Affected: ${top.prs.map(n => '#' + n).join(', ')}.` : ''} Stopped: ${scope}.`,
    running_text: running.length ? `Still running: ${running.map(r => `${r.type} ${r.ref ?? ''}`.trim()).join(', ')}.` : 'Nothing is still running.',
    action: `Fix the cause, then run: ai-supervisor team breaker resume ${top.cause === '@global' ? 'global' : top.cause} (or "all"). It stays halted across restarts until you do.`,
    entries: entries.map(e => ({ cause: e.cause, since: e.since, jobs: e.jobs, tokens: e.tokens, cost: e.cost, prs: e.prs, types: e.types, trippedBy: e.trippedBy })),
  };
}

// Issue #549: only a person at a terminal may resume, and never a process that descends from a supervised job. The supervisor marks
// every job's environment (JOB_MARKER); a pty from `script` still inherits it, and the check also walks the parent chain reading each
// ancestor's environment so `env -u` does not help. (An agent with full access could still edit the state file by hand; that is a
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
