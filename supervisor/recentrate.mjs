// Issue #1345: recent allowance rate from plain readings. No clock or storage is read here.

export const RECENT_HOURS = 2;
const HOUR_MS = 60 * 60 * 1000;
const RESET_TOLERANCE_MS = 10 * 60 * 1000;

function windowOf(reading, kind) {
  const window = reading?.[kind];
  if (!Number.isFinite(window?.used) || !Number.isFinite(window?.resetsAt)) return null;
  return { at: reading.at, used: window.used, resetsAt: window.resetsAt };
}

function sameReset(left, right) {
  return Math.abs(left - right) <= RESET_TOLERANCE_MS;
}

// Return the rise per hour across readings from the last two hours for one window kind.
// Null means that one reading, or readings from different reset windows, cannot establish a rate.
export function recentRate({ readings = [], kind, now, hours = RECENT_HOURS }) {
  if (!Number.isFinite(now) || !['weekly', 'short'].includes(kind)) return null;
  const earliest = now - hours * HOUR_MS;
  const usable = readings
    .filter(reading => Number.isFinite(reading?.at) && reading.at >= earliest && reading.at <= now)
    .map(reading => windowOf(reading, kind))
    .filter(Boolean)
    .sort((left, right) => left.at - right.at);
  const latest = usable.at(-1);
  const windowReadings = latest
    ? usable.filter(reading => sameReset(reading.resetsAt, latest.resetsAt))
    : [];

  if (windowReadings.length < 2) return null;
  const first = windowReadings[0];
  const spanHours = (latest.at - first.at) / HOUR_MS;
  if (spanHours <= 0) return null;
  return Math.max(0, (latest.used - first.used) / spanHours);
}
