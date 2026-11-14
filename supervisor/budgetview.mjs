import { MODE_LABEL, budgetSettings } from './budget.mjs';
import { capacityView } from './capacity.mjs';
import { redact } from './redact.mjs';
import { tierLineSettings, tierLineText } from './tierline.mjs';
export { usageReading } from './readingfresh.mjs';

// The reason for the mode followed by the capacity figures (used percent, learned capacity, remaining, reserve), unless the reason already carries them.
const withCapacity = (reason, capacity) => (capacity?.text && !reason.includes(capacity.text) ? `${reason}${reason ? '; ' : ''}${capacity.text}` : reason);

// Keep malformed planner data out of the public warning while making the rejected shape visible to the dashboard.
export function assignmentFaults(assignments) {
  const faults = [];
  for (const assignment of assignments || []) {
    if (assignment?.fault === null || assignment?.fault === undefined) continue;
    if (!Number.isSafeInteger(assignment.number) || assignment.number < 1) return { faults, refusal: 'it does not name a valid issue' };
    if (typeof assignment.fault !== 'string' || !assignment.fault.trim()) return { faults, refusal: `its reason for issue #${assignment.number} is missing` };
    faults.push({ issue: assignment.number, fault: assignment.fault });
  }
  return { faults, refusal: null };
}

// Weekly burn and scheduling mode per agent, as the planner sees it (issue #56). Figures are the provider's own readings.
export function budgetView(team) {
  const out = {};
  for (const [name, m] of Object.entries(team.modes || {})) {
    const typical = m.costs?.cost ? { implement: m.costs.cost('implement'), review: m.costs.cost('review'), fix: m.costs.cost('fix') } : {};
    const capacity = capacityView(m.capacity);
    out[name] = {
      mode: m.mode,
      label: MODE_LABEL[m.mode],
      reason: redact(m.reason || '', 300),
      until: m.until ?? null,
      known: m.known,
      used: m.used,
      resetsAt: m.resetsAt,
      hoursLeft: m.hoursLeft,
      ratePerHour: m.ratePerHour,
      rateSource: m.rateSource,
      projected: m.projected,
      capacity,
      runsOutAt: m.runsOutAt,
      shortWindow: m.shortWindow,
      reading: m.reading ?? null,
      overage: m.overage,
      creditsAvailable: m.creditsAvailable,
      jobCost: typical,
      tierCutoff: m.tierCutoff ?? null,
      tierLine: tierLineText(m.tierCutoff),
      tierLimits: tierLineSettings(budgetSettings(team.c)),   // issue #1417: the thresholds in force, defaults included
      held: Object.fromEntries(Object.entries(team.held?.[name] || {}).map(([k, v]) => [k, redact(v, 300)]))
    };
    out[name].reason = [withCapacity(out[name].reason, capacity), m.tierCutoff?.firstHeld == null ? '' : out[name].tierLine].filter(Boolean).join('; ');
  }
  return out;
}

// Issue #1178: the scheduler's own marks, so the app bar's levels agree with it (high water, and the used-up mark).
export const budgetThresholds = settings => ({ highWater: settings.high_water, exhaustedAt: settings.exhausted_at });
