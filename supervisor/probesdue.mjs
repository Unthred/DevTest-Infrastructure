// Allowance probes owed now (issue #110, #1163): [{ agent, provider, reason, resetFor }], at most one per provider. Pure: the caller (Team.probesDue)
// supplies the modes, readings and stored probe state; the tick runs the probes and records the attempt.
import { probeDue } from './probe.mjs';
import { refreshDue } from './readingfresh.mjs';

// agents: [[name, { provider }]]. demand: a Set of agent names a job is about to be admitted on; a stale or near-reserve reading is refreshed only for
// those (issue #1163), so an agent nothing is admitted on is never probed on a timer.
export function probesOwed({ agents, modes, usage, stored, probeState, settings, now, canProbe, demand = null }) {
  const out = [], seen = new Set();
  for (const [agent, a] of agents) {
    if (seen.has(a.provider) || !canProbe(a.provider)) continue;
    // D-019: a job of this provider that stopped on a usage limit waits for its reset; no provider call meanwhile.
    const limitWait = (usage.jobs || []).some(j => j.provider === a.provider && j.status === 'paused_limit' && j.lastEvent === 'usage_limit');
    const allowance = usage.allowance?.[a.provider] || null, mode = modes[agent];
    const owed = demand?.has(agent) ? refreshDue({ allowance, capacity: mode.capacity, used: mode.used, now, settings }) : null;
    const due = probeDue({ mode: mode.mode, stored: stored[agent] || null, allowance, state: probeState[agent] || null, settings, now, limitWait, owed });
    if (due) { seen.add(a.provider); out.push({ agent, provider: a.provider, ...due }); }
  }
  return out;
}
