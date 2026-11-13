// Issue #1266: how the client writes numbers, times and words. Pure functions; every time is Europe/London.
const ZONE = 'Europe/London';
const clockFormat = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const validTime = iso => (typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : null);

export const percent = fraction => `${Math.round(fraction * 100)}%`;

// 3h 23m, 9h, 6m, 45s, 2d 3h: at most two units, the zero second unit left out.
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown';
  const whole = Math.floor(seconds);
  const units = [['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  const index = units.findIndex(([, size]) => whole >= size);
  if (index < 0) return '0s';
  const [letter, size] = units[index];
  const major = Math.floor(whole / size);
  const next = units[index + 1];
  const minor = next && next[0] !== 's' ? Math.floor((whole % size) / next[1]) : 0;
  return minor ? `${major}${letter} ${minor}${next[0]}` : `${major}${letter}`;
}
export const shortDuration = seconds => duration(seconds).split(' ')[0];

export const clock = iso => (validTime(iso) === null ? 'unknown' : clockFormat.format(validTime(iso)));
export const dateTime = iso => (validTime(iso) === null ? 'unknown' : dateFormat.format(validTime(iso)));

// A state code such as waiting_for_approval as words: "Waiting for approval".
export function words(code) {
  const text = String(code ?? '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Unknown';
}
