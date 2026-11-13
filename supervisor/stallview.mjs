// Issue #1222: agents idle while planned work waits, and jobs stuck past their resume time. Read-only arithmetic on data the tick already
// stored (the planned ledger of #1223, the job records, the tick snapshots): no GitHub call, no model call, no write.
// The rule (stallRows) is pure; withStall decorates the finished view with `view.stall` and the stalled marks the page reads.
// No agent names are in here: agents come from the configuration.
import { redact } from './redact.mjs';
import { STALE_TICK_MS } from './dashdata.mjs';

export const STALL_MINUTES_DEFAULT = 15;
export const NO_REASON = 'No reason recorded';
const MIN = 60000;
const REASON_CHARS = 300;
// An action that waits for the homeowner is not a fault of Foreman: it is listed apart (requirement 4).
const HOMEOWNER_KINDS = new Set(['retry_cap']);

export const stallLimitMs = limits => (Number.isFinite(limits?.idle_stall_minutes) && limits.idle_stall_minutes > 0 ? limits.idle_stall_minutes : STALL_MINUTES_DEFAULT) * MIN;

// The oldest tick of the unbroken run of ticks (newest first) in which the agent had a planned action that was not launched.
// Returns null when the newest tick has none. A tick recorded before the ledger existed has no `planned` and ends the run.
export function plannedSince(snapshots, agent) {
  let since = null;
  for (const s of [...(snapshots || [])].filter(x => Number.isFinite(x?.at)).sort((a, b) => b.at - a.at)) {
    const held = Array.isArray(s.planned) && s.planned.some(p => p.agent === agent && p.outcome === 'held');
    if (!held) break;
    since = s.at;
  }
  return since;
}

const titleOf = (view, type, ref) => {
  const prs = view.prs || [], issues = view.issues || [];
  const pr = prs.find(p => p.number === ref), issue = issues.find(i => i.number === ref);
  const hit = type === 'implement' ? (issue || pr) : (pr || issue);
  return redact(hit?.title || '', 200);
};
const homeownerLabelled = (view, type, ref) => {
  const hit = type === 'implement' ? (view.issues || []).find(i => i.number === ref) : (view.prs || []).find(p => p.number === ref);
  return hit?.needsHomeowner === true;
};
const actionRow = (view, p) => ({ type: p.type, ref: p.ref ?? null, title: titleOf(view, p.type, p.ref),
  reason: p.kind === 'unexplained' || !p.reason ? null : redact(p.reason, REASON_CHARS), kind: p.kind ?? null });

// view: agents ({ name, state, lastActivityAt }), planned (the last tick's ledger), prs, issues.
// jobs: the job records (paused ones carry nextAttemptAt/resetAt and resumeCheck). snapshots: the tick history.
// Returns { limitMinutes, agents, jobs, waiting, stalled }; nothing is listed for an agent with a running job.
export function stallRows({ view, jobs = [], providerOf = {}, snapshots = [], limitMs, now }) {
  const planned = (Array.isArray(view.planned) ? view.planned : []).filter(p => p.agent && p.outcome === 'held');
  const agents = [], waiting = [];
  const busy = new Set((view.agents || []).filter(a => a.state === 'running').map(a => a.name));
  for (const a of view.agents || []) {
    // 'blocked' means the last job ended failed or blocked: nothing runs and the tick keeps planning for the agent, so it counts as idle here.
    if (a.state !== 'idle' && a.state !== 'blocked') continue;
    const mine = planned.filter(p => p.agent === a.name);
    const theirs = mine.filter(p => HOMEOWNER_KINDS.has(p.kind) || homeownerLabelled(view, p.type, p.ref));
    for (const p of theirs) waiting.push({ agent: a.name, ...actionRow(view, p) });
    const faults = mine.filter(p => !theirs.includes(p));
    const idleSince = Number.isFinite(a.lastActivityAt) ? a.lastActivityAt : null;
    const waitingSince = Math.max(idleSince ?? 0, plannedSince(snapshots, a.name) ?? 0) || null;
    if (!faults.length || waitingSince === null || now - waitingSince <= limitMs) continue;
    agents.push({ agent: a.name, idleMs: idleSince === null ? null : now - idleSince, idleSince, waitingMs: now - waitingSince, actions: faults.map(p => actionRow(view, p)) });
  }
  const stuck = [];
  for (const j of jobs) {
    if (j?.status !== 'paused_limit') continue;
    const agent = Object.keys(providerOf).find(n => providerOf[n] === j.provider);
    const resumeAt = Number.isFinite(j.nextAttemptAt) ? j.nextAttemptAt : Number.isFinite(j.resetAt) ? j.resetAt : null;
    if (!agent || busy.has(agent) || resumeAt === null || now - resumeAt <= limitMs) continue;
    stuck.push({ id: String(j.id).slice(0, 8), fullId: j.id, agent, kind: j.kind || 'job', resumeAt, overdueMs: now - resumeAt,
      error: j.resumeCheck?.message ? redact(j.resumeCheck.message, REASON_CHARS) : null });
  }
  return { limitMinutes: limitMs / MIN, agents, jobs: stuck, waiting, stalled: agents.length + stuck.length > 0 };
}

// The pill: a stall with nothing else open makes the pill itself say so; with other items it keeps its count and carries the marker.
export function healthWithStall(health, stall) {
  if (!stall.stalled) return health;
  // Stuck and Unknown name a more specific cause than the stall, so they stay and only gain the marker.
  if (['needs_you', 'stuck', 'unknown'].includes(health.state)) return { ...health, stalled: true };
  return { state: 'needs_you', label: 'Stalled', count: 0, severity: 'action', stalled: true };
}

// A team loop switched off by the homeowner, or a tick that stopped, leaves the last ledger in the cache: that is not a stall (requirement 4),
// and the Stuck pill already names the stopped tick.
const loopRunning = (view, config, now) => config.enabled !== false && Number.isFinite(view.tick?.at) && now - view.tick.at <= STALE_TICK_MS;
// Decorates the finished view. `jobs` are the raw job records, `snapshots` the hot tick history.
export function withStall(view, { config, jobs, snapshots, now }) {
  if (!loopRunning(view, config, now)) {
    return { ...view, stall: { limitMinutes: stallLimitMs(config.limits) / MIN, agents: [], jobs: [], waiting: [], stalled: false } };
  }
  const providerOf = Object.fromEntries(Object.entries(config.agents || {}).map(([n, a]) => [n, a.provider]));
  const stall = stallRows({ view, jobs, providerOf, snapshots, limitMs: stallLimitMs(config.limits), now });
  const stalledNames = new Set(stall.agents.map(a => a.agent));
  for (const j of stall.jobs) stalledNames.add(j.agent);
  return { ...view, stall, health: healthWithStall(view.health, stall),
    agents: view.agents.map(a => (stalledNames.has(a.name) ? { ...a, stalled: true } : a)) };
}
