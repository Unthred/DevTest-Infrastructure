// On-demand allowance probe (issue #110), shared by `ai-supervisor probe <agent>` and the dashboard's "Refresh allowance" button.
// Ignores the age and interval gates of the tick (a person asked), never the busy guard. The planner picks the stored reading up on the
// next tick; nothing here changes a mode, a latch or a job.
import { SupervisorError } from './core.mjs';
import { storeProbes } from './dashdata.mjs';
import { refreshProvider } from './probe.mjs';

export async function probeNow({ root, registry, config, agent, now = Date.now(), refresh = refreshProvider }) {
  const entry = config.agents?.[agent];
  if (!entry) throw new SupervisorError(`unknown agent: ${String(agent).slice(0, 40)}`);
  const r = await refresh(registry, entry.provider, { now });
  if (!r.record) return { agent, ok: false, error: r.error };
  const stored = storeProbes(root, { [entry.provider]: r.record });
  return { agent, ok: true, stored, source: r.record.source, observedAt: r.record.observedAt, ageSeconds: Math.max(0, Math.round((now - r.record.observedAt) / 1000)), status: r.record.status,
    windows: r.record.windows.map(w => ({ type: w.type, utilization: w.utilization, resetsAt: w.resetsAt })), overage: r.record.billing?.usingOverage === true };
}
