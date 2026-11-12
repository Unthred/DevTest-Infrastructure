// Issue #1159: telling a limit reset the homeowner applied from a real window rollover. Pure functions over weekly readings
// ({ at, used, resetsAt } in time order, as budget.weeklyHistory builds them); no clock, no file.
//
// A window that rolls over changes its reported reset time (and its use starts again). A reset the homeowner applies on the
// provider's site drops the use sharply while the reset time stays the same. Only the second is an applied reset: it is shown
// as an event, and it stays out of learned capacity and run-out estimates, so it never reads as a smaller or larger week.
export const RESET_DROP = 0.1;   // a fall of ten points of the weekly window within one window; ordinary readings only rise
const SAME_RESET_MS = 10 * 60000;
const sameReset = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_RESET_MS;

// True when `next` follows `prev` inside one window and the use fell by at least RESET_DROP.
export const isAppliedReset = (prev, next) => !!prev && !!next && sameReset(prev.resetsAt, next.resetsAt) && next.at < next.resetsAt
  && Number.isFinite(prev.used) && Number.isFinite(next.used) && prev.used - next.used >= RESET_DROP;

// Every applied reset in the readings: { at, from, to, restored, resetsAt }. `restored` is the share of the weekly window given back.
export function appliedResets(readings) {
  const out = [];
  const sorted = [...(readings || [])].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (isAppliedReset(prev, next)) out.push({ at: next.at, from: prev.used, to: next.used, restored: prev.used - next.used, resetsAt: next.resetsAt });
  }
  return out;
}

// The share of the window given back by resets applied inside the window that ends at `resetsAt`.
export const restoredIn = (readings, resetsAt) => appliedResets(readings).filter(r => sameReset(r.resetsAt, resetsAt)).reduce((s, r) => s + r.restored, 0);

// Readings of one window from its last applied reset onward: the rate of use before a reset describes use that was given back.
export function sinceLastReset(readings, resetsAt) {
  const last = appliedResets(readings).filter(r => sameReset(r.resetsAt, resetsAt)).at(-1);
  return last ? readings.filter(p => p.at >= last.at) : readings;
}
