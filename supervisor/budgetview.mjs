import { MODE_LABEL } from './budget.mjs';
import { capacityView } from './capacity.mjs';
import { redact } from './redact.mjs';
export { usageReading } from './readingfresh.mjs';

// The reason for the mode followed by the capacity figures (used percent, learned capacity, remaining, reserve), unless the reason already carries them.
const withCapacity = (reason, capacity) => (capacity?.text && !reason.includes(capacity.text) ? `${reason}${reason ? '; ' : ''}${capacity.text}` : reason);

// Weekly burn and scheduling mode per agent, as the planner sees it (issue #56). Figures are the provider's own readings.
export function budgetView(team) {
  const out = {};
  for (const [name, m] of Object.entries(team.modes || {})) {
    const typical = m.costs?.cost ? { implement: m.costs.cost('implement'), review: m.costs.cost('review'), fix: m.costs.cost('fix') } : {};
    const capacity = capacityView(m.capacity);
    out[name] = { mode: m.mode, label: MODE_LABEL[m.mode], reason: redact(m.reason || '', 300), until: m.until ?? null, known: m.known, used: m.used, resetsAt: m.resetsAt, hoursLeft: m.hoursLeft, ratePerHour: m.ratePerHour, rateSource: m.rateSource,
      projected: m.projected, capacity, runsOutAt: m.runsOutAt, shortWindow: m.shortWindow, reading: m.reading ?? null, overage: m.overage, creditsAvailable: m.creditsAvailable, jobCost: typical,
      held: Object.fromEntries(Object.entries(team.held?.[name] || {}).map(([k, v]) => [k, redact(v, 300)])) };
    out[name].reason = withCapacity(out[name].reason, capacity);
  }
  return out;
}
