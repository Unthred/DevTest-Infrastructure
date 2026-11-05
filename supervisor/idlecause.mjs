// Issue #487: why an agent was idle, by cause. Read-only arithmetic on data the tick and the job records already hold: no model call,
// no GitHub call. The method is the one used for the figures in issue #406 (24 hours to 06:25 on 3 Nov 2026):
//  - a gap runs from the end of an agent's last job to the start of its next one (an agent running any job is busy);
//  - each tick interval inside a gap is classed from the tick log: after a tick that held the agent's work for an upgrade it is
//    `upgrade`; after a tick that named a hold for that agent it is `named-hold`; an interval that ends at the tick that started the
//    job is `waiting-for-tick`; otherwise nothing was eligible (`no-eligible-work`);
//  - the time from the start of the tick that started the job to the job's start is `tick-run` (the 43 and 22 minute rows).
import { redact } from './redact.mjs';
export const IDLE_CAUSES = ['waiting-for-tick', 'upgrade', 'tick-run', 'named-hold', 'no-eligible-work', 'unrecorded'];
// Causes that count as "idle with work available": every one except nothing-to-do and no tick record.
export const WORK_CAUSES = ['waiting-for-tick', 'upgrade', 'tick-run', 'named-hold'];
export const CAUSE_LABEL = { 'waiting-for-tick': 'waiting for the next tick', upgrade: 'upgrade pending or draining', 'tick-run': 'tick run time before the job started',
  'named-hold': 'a named hold', 'no-eligible-work': 'no eligible work', unrecorded: 'no tick record' };
const ACTIVE = new Set(['queued', 'running', 'paused_limit', 'paused_manual']);
const MIN = 60000;

// One tick: the cause recorded for each agent that is idle when the tick ends. `heldAgents` are the agents whose planned work the upgrade
// hold dropped (null when no upgrade hold applied), `holds` is the planner's per-agent hold text ({ agent: { type: text } }), `plan` the
// actions the tick planned. A hold applies to the agent it belongs to, not to every idle agent.
export function classifyIdle({ states, heldAgents = null, holds = {}, plan = [] }) {
  const out = {};
  for (const [agent, s] of Object.entries(states || {})) {
    if (s !== 'idle') continue;
    const mine = plan.some(p => p.agent === agent && p.type !== 'merge');
    if (heldAgents?.includes(agent)) out[agent] = { cause: 'upgrade' };
    else if (mine) out[agent] = { cause: 'work-planned' };
    else {
      const text = [...new Set(Object.values(holds?.[agent] || {}))].join(' | ').slice(0, 300);
      out[agent] = text ? { cause: 'named-hold', hold: redact(text, 300) } : { cause: 'no-eligible-work' };
    }
  }
  return out;
}

// Busy intervals of one agent (its provider's jobs), clipped to the window and merged.
export function busyIntervals(jobs, provider, from, to) {
  const spans = [];
  for (const j of jobs || []) {
    if (j?.unreadable || j.provider !== provider || !Number.isFinite(j.createdAt)) continue;
    const end = ACTIVE.has(j.status) ? to : (Number.isFinite(j.updatedAt) ? j.updatedAt : j.createdAt);
    if (end <= from || j.createdAt >= to) continue;
    spans.push([Math.max(j.createdAt, from), Math.min(Math.max(end, j.createdAt), to)]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged.at(-1);
    if (last && a <= last.end) last.end = Math.max(last.end, b); else merged.push({ start: a, end: b });
  }
  return merged;
}

// Index of the first snapshot with at >= t (binary search; snapshots are sorted).
const firstAtOrAfter = (snaps, t) => { let lo = 0, hi = snaps.length; while (lo < hi) { const m = (lo + hi) >> 1; if (snaps[m].at < t) lo = m + 1; else hi = m; } return lo; };
const mapCause = c => (c === 'work-planned' ? 'waiting-for-tick' : c);

// Minutes idle per agent and cause. `agents` maps agent name to provider. Times are epoch milliseconds.
export function idleBreakdown({ jobs, snapshots, agents, from, to }) {
  const snaps = (snapshots || []).filter(s => Number.isFinite(s?.at)).sort((x, y) => x.at - y.at);
  const out = {};
  for (const [agent, provider] of Object.entries(agents)) {
    const row = { windowMinutes: (to - from) / MIN, busyMinutes: 0, minutes: Object.fromEntries(IDLE_CAUSES.map(k => [k, 0])), holds: {} };
    const add = (cause, ms, hold) => { row.minutes[cause] += ms / MIN; if (cause === 'named-hold' && hold) row.holds[hold] = (row.holds[hold] || 0) + ms / MIN; };
    const busy = busyIntervals(jobs, provider, from, to);
    let cursor = from;
    const idleSpans = [];
    for (const b of busy) { if (b.start > cursor) idleSpans.push({ a: cursor, b: b.start, starts: true }); row.busyMinutes += (b.end - b.start) / MIN; cursor = Math.max(cursor, b.end); }
    if (cursor < to) idleSpans.push({ a: cursor, b: to, starts: false });
    for (const { a, b, starts } of idleSpans) {
      // The tick that started the job: the first tick record that ends at or after the job's start.
      const startSnap = starts ? snaps[firstAtOrAfter(snaps, b)] : null;
      const t0 = startSnap ? Math.min(b, Math.max(a, Number.isFinite(startSnap.startedAt) ? startSnap.startedAt : b)) : b;
      if (b > t0) add('tick-run', b - t0);
      const cuts = [a]; for (let k = firstAtOrAfter(snaps, a + 1); k < snaps.length && snaps[k].at < t0; k++) cuts.push(snaps[k].at); cuts.push(t0);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const x = cuts[i], y = cuts[i + 1];
        if (y <= x) continue;
        const prev = snaps[firstAtOrAfter(snaps, x + 1) - 1], end = snaps[firstAtOrAfter(snaps, y)];
        const entry = prev?.idle?.[agent];
        let cause, hold = entry?.hold;
        if (entry) cause = mapCause(entry.cause);
        else {
          // The previous tick saw the agent running (or there was none): the tick that ends the interval says what held its work.
          const e = end?.idle?.[agent];
          cause = e ? mapCause(e.cause) : end ? 'no-eligible-work' : 'unrecorded'; hold = e?.hold;
          if (!prev && !e) cause = 'unrecorded';
        }
        if (cause === 'no-eligible-work' && end && end === startSnap) cause = 'waiting-for-tick';
        add(cause, y - x, hold);
      }
    }
    out[agent] = row;
  }
  return out;
}

const round1 = n => Math.round(n * 10) / 10;
// The report: per agent, minutes by cause, busy minutes and "idle with work available" as a percent of the window.
export function idleReport({ jobs, snapshots, agents, from, to }) {
  const raw = idleBreakdown({ jobs, snapshots, agents, from, to }), out = {};
  for (const [n, r] of Object.entries(raw)) {
    const withWork = WORK_CAUSES.reduce((t, k) => t + r.minutes[k], 0);
    out[n] = { windowMinutes: round1(r.windowMinutes), busyMinutes: round1(r.busyMinutes), minutes: Object.fromEntries(IDLE_CAUSES.map(k => [k, round1(r.minutes[k])])),
      holds: Object.fromEntries(Object.entries(r.holds).map(([k, v]) => [k, round1(v)])), idleWithWorkMinutes: round1(withWork), idleWithWorkPercent: r.windowMinutes > 0 ? round1(withWork / r.windowMinutes * 100) : 0 };
  }
  return { from, to, agents: out };
}

export function renderIdleReport(rep) {
  const lines = [`Idle time by cause, ${new Date(rep.from).toISOString()} to ${new Date(rep.to).toISOString()} (minutes)`];
  for (const [n, r] of Object.entries(rep.agents)) {
    lines.push(`${n}: busy ${r.busyMinutes} of ${r.windowMinutes}; idle with work available ${r.idleWithWorkMinutes} (${r.idleWithWorkPercent}%)`);
    for (const k of IDLE_CAUSES) lines.push(`  ${CAUSE_LABEL[k]}: ${r.minutes[k]}`);
    for (const [h, m] of Object.entries(r.holds)) lines.push(`  hold "${h}": ${m}`);
  }
  return lines.join('\n');
}
