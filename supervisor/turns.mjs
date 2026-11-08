// Issue #1057: turns per job. Every turn re-reads the whole first-turn prompt and tool set, so the number of turns, not the files read,
// drives a job's input tokens. This module counts turns from the provider stream, records the first turn's input size, and applies a
// per-kind turn budget (a reminder at 80%, a stop at 100%). Pure functions: no model call, no network, no write.
// A turn is one model response: a Claude assistant message id seen for the first time, or a Codex `turn.completed` line.
const count = v => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

// Defaults sit above the measured per-kind averages (review 16, fix 13, implement 19, rebase 25; 7 days, 8 Nov 2026) so a normal job is never cut.
// Override per kind with `turn_budget` in team.local.json; 0 or a missing kind means no budget for that kind.
export const DEFAULT_TURN_BUDGET = { review: 40, fix: 35, cifix: 35, implement: 60, rebase: 50 };
export const REMINDER_FRACTION = 0.8;

export function validateTurnBudget(b) {
  if (b === undefined) return;
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('invalid turn_budget');
  for (const [k, v] of Object.entries(b)) if (!/^[a-z][a-z0-9_-]{0,31}$/.test(k) || !Number.isSafeInteger(v) || v < 0 || v > 1000) throw new Error(`invalid turn_budget: ${k}`);
}
export const turnLimit = (config, kind) => {
  const table = { ...DEFAULT_TURN_BUDGET, ...(config?.turn_budget || {}) };
  const n = table[kind];
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

// Feed each stream line; returns { turn: true, firstInput } when the line starts a new turn, otherwise null.
export function turnFromLine(line, state) {
  if (typeof line !== 'string' || !line.startsWith('{')) return null;
  let o; try { o = JSON.parse(line); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  if (o.type === 'assistant' && o.message?.id) {
    const id = String(o.message.id);
    if ((state.seen ||= new Set()).has(id)) return null;
    state.seen.add(id);
    const u = o.message.usage || {};
    return { turn: true, input: count(u.input_tokens) + count(u.cache_creation_input_tokens) + count(u.cache_read_input_tokens) };
  }
  if (o.type === 'turn.completed') return { turn: true, input: count(o.usage?.input_tokens) };
  return null;
}

// Counts a turn on the job record and applies the budget. Returns 'remind' once at 80%, 'stop' at 100% and beyond, else null.
export function recordTurn(job, hit, limit) {
  if (!hit) return null;
  const t = job.turns = job.turns && typeof job.turns === 'object' ? job.turns : { count: 0, firstTurnInput: null };
  t.count = count(t.count) + 1;
  if (t.firstTurnInput === null || t.firstTurnInput === undefined) t.firstTurnInput = hit.input;   // the first turn of the first attempt; a resume does not overwrite it
  if (!limit) return null;
  if (t.count >= limit) { t.stopped = true; return 'stop'; }
  if (!t.reminded && t.count >= Math.ceil(limit * REMINDER_FRACTION)) { t.reminded = true; return 'remind'; }
  return null;
}

// Mean turns and first-turn input per job kind, for the Usage page and foreman_jobs. `jobs` are job records.
export function turnsByKind(jobs) {
  const out = {};
  for (const j of jobs || []) {
    if (!j?.turns || !Number.isSafeInteger(j.turns.count) || j.turns.count <= 0) continue;
    const k = String(j.kind || 'job'), a = out[k] ||= { jobs: 0, turns: 0, firstInput: 0, firstInputJobs: 0, stopped: 0 };
    a.jobs++; a.turns += j.turns.count; if (j.turns.stopped) a.stopped++;
    if (Number.isFinite(j.turns.firstTurnInput) && j.turns.firstTurnInput > 0) { a.firstInput += j.turns.firstTurnInput; a.firstInputJobs++; }
  }
  for (const a of Object.values(out)) { a.meanTurns = Math.round(a.turns / a.jobs * 10) / 10; a.meanFirstTurnInput = a.firstInputJobs ? Math.round(a.firstInput / a.firstInputJobs) : null; }
  return out;
}
