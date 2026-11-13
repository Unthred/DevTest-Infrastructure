// Issue #1166: an agent's use rate over the last hour or two, from the dashboard snapshots (one per tick) plus the newest reading. Plain data in, plain data out.
import { isWeekly } from './capacity.mjs';

const HOUR = 3600000;
export const RECENT_HOURS = 2;
const MIN_SPAN_HOURS = 0.2;   // shorter than this is two reads of one tick, not a rate
const sameReset = (a, b) => Math.abs(a - b) <= 10 * 60000;

// `pick` selects the window of a reading: 'weekly' or 'short'. Returns fraction per hour, or null when the readings do not span enough time.
export function recentWindowRate({ snapshots = [], current = null, agent, kind, now, hours = RECENT_HOURS }) {
  const want = w => Number.isFinite(w.utilization) && Number.isFinite(w.resetsAt) && w.resetsAt > now && (kind === 'weekly') === isWeekly(w);
  const readings = [];
  for (const al of [...snapshots.map(s => s?.allowance?.[agent]), current]) {
    if (!al || !Number.isFinite(al.observedAt) || al.observedAt > now || now - al.observedAt > hours * HOUR) continue;
    const w = (al.windows || []).filter(want).sort((a, b) => b.utilization - a.utilization)[0];
    if (w) readings.push({ at: al.observedAt, used: w.utilization, resetsAt: w.resetsAt });
  }
  readings.sort((a, b) => a.at - b.at);
  const last = readings.at(-1);
  const same = last ? readings.filter(r => sameReset(r.resetsAt, last.resetsAt)) : [];
  if (same.length < 2) return null;
  const span = (last.at - same[0].at) / HOUR;
  return span >= MIN_SPAN_HOURS ? Math.max(0, (last.used - same[0].used) / span) : null;
}
