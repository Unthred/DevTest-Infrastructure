// Issue #1116: the reserve rule and the planner invariant, as pure decisions over the capacity summary (capacity.mjs).
// Kept apart from budget.mjs, which calls it, so this file imports nothing from there.
import { remainingOf } from './capacity.mjs';
const pct = v => `${Math.round(v * 100)}%`;

// The reviews-only hold from the high-water mark. With a known capacity the mark is the absolute reserve; without one it is the fixed share
// (today's rule) and the reason says why the capacity rule could not be used. Null when the agent is not held by it.
export function highWaterHold({ out, weekly, settings, capacity }) {
  const absolute = capacity?.basis === 'absolute';
  const atMark = absolute ? capacity.belowReserve : out.used >= settings.high_water;
  if (!atMark || !(out.hoursLeft > settings.high_water_min_hours)) return null;
  const hours = `with more than ${settings.high_water_min_hours}h to go`;
  const reason = absolute
    ? `weekly ${pct(out.used)}: remaining capacity at or below the reserve (${capacity.text}) ${hours}`
    : `weekly ${pct(out.used)}: at or above ${pct(settings.high_water)} ${hours}${capacity ? ` (fixed share: ${capacity.reason})` : ''}`;
  return { ...out, rule: 'high-water', mode: 'reviews_only', until: weekly.resetsAt, reason };
}

// Planner invariant: no implement or continue is given to an agent whose remaining capacity, after the cost already planned this tick
// (`used` includes it), is at or below its reserve. Reviews and the repairs of its own pull requests are what the reserve is for.
export function reserveRefusal(a, type, reviewsOnlyTypes) {
  const cap = a?.capacity;
  if (cap?.basis !== 'absolute' || reviewsOnlyTypes.has(type) || type === 'review') return null;
  return remainingOf(cap.capacity, a.used) <= cap.reserve ? `remaining capacity is at or below the reserve (${cap.text})` : null;
}
