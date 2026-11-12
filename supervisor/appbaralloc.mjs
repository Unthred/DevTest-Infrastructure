// Issues #1178, #1221: the allowance figures of each configured agent as plain data (allowanceItems). The markup is appbaragent.mjs.
// The figures are the budget view's reading (budgetview.mjs), so the bar, the Usage page and the MCP agree. No agent name is in here:
// the items follow the agent list the view was built from.
import { DEFAULT_BUDGET } from './budget.mjs';

const WEEKLY_KINDS = ['weekly_all', 'weekly_model'];
const SHORT_KIND = 'session_5h';
export const LEVEL_TEXT = { normal: 'OK', high: 'High', near: 'Near limit' };
export const LEVEL_MARK = { normal: '', high: '▲', near: '■' };

// Same thresholds as the scheduler: budget high_water for "high water", exhausted_at for "near exhausted".
export const levelOf = (used, limits = {}) => {
  const near = limits.exhaustedAt ?? DEFAULT_BUDGET.exhausted_at, high = limits.highWater ?? DEFAULT_BUDGET.high_water;
  return used >= near ? 'near' : used >= high ? 'high' : 'normal';
};

// One window of the reading as { state: 'known', used, level, resetsAt } or { state: 'unknown', reason }. An expired window (its reset
// time has passed) is unknown: the old figure no longer describes anything.
function windowFigure(reading, kinds, label, limits) {
  if (!reading) return { state: 'unknown', reason: 'no allowance reading yet' };
  const all = reading.limits.filter(l => kinds.includes(l.kind));
  if (!all.length) return { state: 'unknown', reason: `${label} limit not reported by the provider` };
  const live = all.filter(l => !l.expired).sort((a, b) => b.used - a.used);
  if (!live.length) return { state: 'unknown', reason: `${label} window has reset; no new reading yet` };
  return { state: 'known', used: live[0].used, level: levelOf(live[0].used, limits), resetsAt: live[0].resetsAt };
}

// `view` needs agents (name), budget (per agent), budgetLimits ({ highWater, exhaustedAt }). Returns one plain item per agent.
export function allowanceItems(view) {
  return (view.agents || []).map(a => {
    const reading = view.budget?.[a.name]?.reading ?? null;
    const seen = reading && reading.limits.length > 0;
    return {
      agent: a.name,
      weekly: windowFigure(seen ? reading : null, WEEKLY_KINDS, 'weekly', view.budgetLimits),
      short: windowFigure(seen ? reading : null, [SHORT_KIND], '5 hour', view.budgetLimits),
      seen: Boolean(seen),
      ageMinutes: seen ? reading.ageMinutes : null,
      stale: seen ? reading.stale === true : false,
      maxAgeMinutes: reading?.maxAgeMinutes ?? null
    };
  });
}
