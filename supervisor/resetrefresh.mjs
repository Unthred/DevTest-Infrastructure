// Issue #1162: after the homeowner marks a reset used, ask for an allowance refresh as the Refresh allowance button does and wake the dispatcher,
// so the hold lifts on the next tick. Best effort: a refused or failed refresh never undoes the mark, because the next tick reads the provider anyway.
import { reserveCooldown, releaseCooldown } from './dashwrite.mjs';

export async function refreshAllowance({ root, source, probe, registry, wake, agent, now }) {
  const slot = reserveCooldown(root, `probe:${agent}`, now);
  if (slot.ok) {
    try {
      const out = await probe({ root, registry, config: source(), agent, now });
      if (!out.ok) releaseCooldown(root, `probe:${agent}`, now);
    } catch {
      releaseCooldown(root, `probe:${agent}`, now);
    }
  }
  try { wake(root, 'approve', source()); } catch { /* the schedule is the fallback */ }
}
