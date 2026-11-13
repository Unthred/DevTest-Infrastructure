// Issue #1253: the app bar model, GET /api/v1/appbar. The one small reply every client shows first: the system condition, the counts,
// the slots, the tick, one entry per configured agent with its two allowance windows and the age of its reading, the breaker and the version.
// The allowance figures are the view's own (appbaralloc.mjs), so the bar and this reply agree. No agent or provider name is in here:
// the entries follow the agent list the view was built from.
import { allowanceItems } from '../../appbaralloc.mjs';
import { TICK_INTERVAL_MS } from '../../dashboard.mjs';
import { classify } from '../attention.mjs';
import { systemCondition } from '../system-state.mjs';

export const name = 'appbar';
export const path = 'appbar';
export const schema = 'appbar.schema.json';

const WINDOW_SECONDS = { weekly: 7 * 24 * 3600, short: 5 * 3600 };
const AGENT_STATES = ['running', 'idle', 'paused', 'held', 'blocked'];

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const condition = (state, attention, reasonCode = null, reasonText = null, since = null) => (
  { state, attention, reason_code: reasonCode, reason_text: reasonText, since }
);

function windowOf(figure, seconds) {
  const known = figure.state === 'known';
  return {
    state: figure.state,
    used_fraction: known ? figure.used : null,
    level: known ? figure.level : null,
    resets_at: iso(figure.resetsAt),
    window_seconds: seconds,
    reason_code: known ? null : figure.code,
    reason_text: known ? null : figure.reason,
  };
}

// The reading is stale only when it is older than the limit (a reading exactly at the limit is current); a reading with no time is stale.
function readingOf(reading, now) {
  const readAt = Number.isFinite(reading?.observedAt) && reading.observedAt > 0 ? reading.observedAt : null;
  const age = readAt === null ? null : Math.max(0, Math.floor((now - readAt) / 1000));
  const max = Number.isFinite(reading?.maxAgeMinutes) ? reading.maxAgeMinutes * 60 : null;
  return { read_at: iso(readAt), age_seconds: age, stale: age === null || (max !== null && age > max), max_age_seconds: max };
}

export const heldOf = view => (Array.isArray(view.planned) ? view.planned : []).filter(p => p?.outcome === 'held');
const holdCode = held => (held.some(h => h.kind === 'unexplained') ? 'unrecorded' : String(held[0]?.kind ?? 'unrecorded'));

export function agentCondition(a, held) {
  const state = AGENT_STATES.includes(a.state) ? a.state : 'unknown';
  const text = a.idleReason?.text ?? null;
  if (state === 'idle' && held.length) return condition('idle', 'fault', holdCode(held), text);
  return condition(state, state === 'unknown' ? 'unknown' : 'none', null, text, state === 'idle' ? iso(a.lastActivityAt) : null);
}

function agentEntries(view, now, roles) {
  const held = heldOf(view);
  const byName = new Map((view.agents || []).map(a => [a.name, a]));
  return allowanceItems(view).map(item => {
    const a = byName.get(item.agent) || {};
    const own = held.filter(h => h.agent === item.agent);
    return {
      id: item.agent,
      display_name: item.agent,
      provider: a.provider ?? null,
      roles,
      condition: agentCondition(a, own),
      weekly: windowOf(item.weekly, WINDOW_SECONDS.weekly),
      short: windowOf(item.short, WINDOW_SECONDS.short),
      reading: readingOf(view.budget?.[item.agent]?.reading, now),
      running_jobs: (a.jobs || []).filter(j => j.status === 'running').length,
    };
  });
}

function tickOf(view) {
  const t = view.nextTick;
  const lastAt = t?.lastAt ?? view.tick?.at ?? null;
  const state = view.teamEnabled === false ? 'off' : t ? t.state : 'unknown';
  return { state, last_at: iso(lastAt), next_at: iso(t?.at), interval_seconds: TICK_INTERVAL_MS / 1000 };
}

// Jobs as the rule reads them: when each started and, once it has stopped, when it ended.
const jobTimes = view => (view.jobs || []).map(j => ({
  status: j.status,
  startedAt: j.startedAt,
  endedAt: j.status === 'running' ? null : j.startedAt + (j.elapsedMs || 0),
}));

function countsOf(view, held) {
  const attention = (view.panels?.needsYou || []).map(item => classify(item, []).attention);
  const stalled = (view.agents || []).filter(a => a.state === 'idle' && held.some(h => h.agent === a.name));
  return {
    needs_you: attention.filter(x => x === 'homeowner').length,
    faults: attention.filter(x => x === 'fault').length,
    stalled_agents: stalled.length,
    planned_held: held.length,
    running_jobs: (view.jobs || []).filter(j => j.status === 'running').length,
    inbox_waiting: (view.panels?.inbox || []).length,
  };
}

const sumOf = (view, field) => (view.slots || []).reduce((n, s) => n + field(s), 0);
const slotsOf = view => ({ max: sumOf(view, s => s.capacity || 0), in_use: sumOf(view, s => s.held?.length || 0) });

function versionOf(view) {
  const v = view.version || {};
  return {
    installed: v.installed || null,
    running: v.running || null,
    main: v.main || null,
    behind_commits: Number.isSafeInteger(v.behind) ? v.behind : null,
    latched: v.latched === true,
  };
}

export function build(view, context) {
  const now = context.now;
  const held = heldOf(view);
  const halt = view.breaker?.halt ?? null;
  const breaker = { halted: Boolean(halt), text: halt ? halt.text : null, since: null };
  const tick = tickOf(view);
  const roles = (view.slots || []).filter(s => s.capacity > 0).map(s => s.role);
  const system = systemCondition({
    breaker, tickKnown: tick.state !== 'unknown', jobs: jobTimes(view), held, now,
    paused: (view.agents || []).some(a => a.state === 'paused'),
  });
  return {
    system,
    counts: countsOf(view, held),
    slots: slotsOf(view),
    tick,
    agents: agentEntries(view, now, roles),
    breaker: halt ? condition('halted', 'fault', 'breaker_halt', breaker.text) : condition('clear', 'none'),
    direct_control: null,
    version: versionOf(view),
  };
}
