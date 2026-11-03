// Issue #406: why an agent was idle, by cause, from the tick snapshots (same method as the issue's measurement).
// Causes: upgrade (a pending or just-installed upgrade held dispatch), named-hold (work existed and the planner named a hold),
// no-eligible-work (nothing to do), and, computed across snapshots, waiting-for-tick (work was planned at the next tick).
export const IDLE_CAUSES = ['waiting-for-tick', 'upgrade', 'named-hold', 'no-eligible-work'];

// One tick: the cause for each agent that is idle after it. `held` is report.held, `idle` is the planner's idle record
// (work exists but nothing started), `heldBy` is the planner's per-agent hold texts.
export function classifyIdle({ states, held = null, idle = null, plan = [] }) {
  const out = {};
  for (const [agent, s] of Object.entries(states || {})) {
    if (s !== 'idle') continue;
    if (held) out[agent] = 'upgrade';
    else if (idle) out[agent] = 'named-hold';
    else out[agent] = plan.some(p => p.agent === agent) ? 'waiting-for-tick' : 'no-eligible-work';
  }
  return out;
}

// Minutes idle per agent and cause over snapshots (sorted by time). An interval after a snapshot where the agent was idle with no
// work is "waiting-for-tick" when the next snapshot planned a job for it: work existed all along.
export function summarizeIdle(snapshots, { agents = null } = {}) {
  const snaps = [...snapshots].filter(s => Number.isFinite(s.at)).sort((a, b) => a.at - b.at);
  const out = {};
  for (let i = 0; i + 1 < snaps.length; i++) {
    const a = snaps[i], b = snaps[i + 1], ms = b.at - a.at;
    for (const [agent, cause] of Object.entries(a.idle || {})) {
      if (agents && !agents.includes(agent)) continue;
      const planned = (b.plan || []).some(p => p.agent === agent);
      const c = cause === 'no-eligible-work' && planned ? 'waiting-for-tick' : cause;
      const row = (out[agent] ||= Object.fromEntries(IDLE_CAUSES.map(k => [k, 0])));
      row[c] = (row[c] || 0) + ms / 60000;
    }
  }
  return out;
}

// Issue #406 acceptance: idle with work available (every cause except no-eligible-work) as a percent of the window, per agent,
// next to the issue's measured "before" figures. Same method as the issue: snapshot intervals, causes as above. Out-of-allowance time
// is not excluded here (no snapshot records it as idle work), so compare like with like over a window without a long pause.
export const IDLE_BEFORE_PERCENT = { claude: 35.5, codex: 24.8 };
export function idleReport(snapshots, { now, hours = 24, agents = Object.keys(IDLE_BEFORE_PERCENT) } = {}) {
  const windowMs = hours * 3600000, recent = snapshots.filter(s => Number.isFinite(s.at) && now - s.at <= windowMs);
  const sum = summarizeIdle(recent, { agents });
  const out = {};
  for (const n of agents) {
    const row = sum[n] || Object.fromEntries(IDLE_CAUSES.map(k => [k, 0])), withWork = IDLE_CAUSES.filter(k => k !== 'no-eligible-work').reduce((t, k) => t + (row[k] || 0), 0);
    out[n] = { minutes: Object.fromEntries(IDLE_CAUSES.map(k => [k, Math.round(row[k] || 0)])), idleWithWorkPercent: Math.round(withWork / (hours * 60) * 1000) / 10, beforePercent: IDLE_BEFORE_PERCENT[n] ?? null };
  }
  return { windowHours: hours, snapshots: recent.length, agents: out };
}
