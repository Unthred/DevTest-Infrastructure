// On-demand allowance probe (issue #110), shared by `ai-supervisor probe <agent>` and the dashboard's "Refresh allowance" button.
// Ignores the age and interval gates of the tick (a person asked), never the busy guard. The planner picks the stored reading up on the
// next tick; nothing here changes a mode, a latch or a job.
import { SupervisorError } from './core.mjs';
import { refreshProvider, overageRisk, probeKind } from './probe.mjs';
import { storeProbes, readJobs, readCache, latestAllowance } from './dashdata.mjs';
import { budgetSettings } from './budget.mjs';

// The newest stored reading of a provider and the exhausted_at setting: what a probe needs to judge "newer" and the overage rule.
export function refreshInputs(root, config, providerId) {
  return { stored: latestAllowance(readJobs(root), readCache(root)?.probes)[providerId] || null, exhaustedAt: budgetSettings(config).exhausted_at };
}

export async function probeNow({ root, registry, config, agent, now = Date.now(), refresh = refreshProvider }) {
  const entry = config.agents?.[agent];
  if (!entry) throw new SupervisorError(`unknown agent: ${String(agent).slice(0, 40)}`);
  // A model run is refused while the newest reading shows overage in use, or a used-up window with overage not refused (never spends credits).
  // The session-log read is model-free and always allowed; its minimal session fallback is refused under the same rule inside the probe (issue #1330).
  const { stored, exhaustedAt } = refreshInputs(root, config, entry.provider);
  if (probeKind(registry, entry.provider) !== 'session-log' && overageRisk(stored, now, exhaustedAt)) return { agent, ok: false, error: 'overage-risk' };
  const r = await refresh(registry, entry.provider, { now, stored, exhaustedAt });
  if (!r.record) return { agent, ok: false, error: r.error };
  const saved = storeProbes(root, { [entry.provider]: r.record });
  return { agent, ok: true, outcome: r.outcome || 'new', stored: saved, source: r.record.source, observedAt: r.record.observedAt,
    ageSeconds: Math.max(0, Math.round((now - r.record.observedAt) / 1000)), status: r.record.status,
    windows: r.record.windows.map(w => ({ type: w.type, utilization: w.utilization, resetsAt: w.resetsAt })), overage: r.record.billing?.usingOverage === true };
}
