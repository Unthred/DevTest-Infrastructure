// Parsing of the local clock times that provider CLIs print ("try again at 11:44 AM", "resets 7:18 AM on 4 Nov").
// Read in the host's local time zone (Tower: Europe/London, BST/GMT handled by Intl), rolled forward if already past.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map(x => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}
function offsetMs(ms, tz) { const p = localParts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; }
// Local wall-clock time in `tz` to epoch ms. Two passes settle the offset across a DST change.
export function zonedToUtc({ y, m, d, h, mi }, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(guess, tz);
  return guess - offsetMs(first, tz);
}
export const defaultZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function to24(hour, ampm) {
  const h = Number(hour); if (!(h >= 1 && h <= 12)) return null;
  return (h % 12) + (/^p/i.test(ampm) ? 12 : 0);
}
// Next instant at which the local clock reads h:mi, strictly after `now`.
export function nextLocalOccurrence(h, mi, now, tz = defaultZone()) {
  const today = localParts(now, tz);
  for (let add = 0; add <= 2; add++) {
    const day = new Date(Date.UTC(today.y, today.m - 1, today.d + add));
    const t = zonedToUtc({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), h, mi }, tz);
    if (t > now) return t;
  }
  return null;
}
// "<d> <Mon>" at h:mi, this year, or next year if already past.
export function nextDatedOccurrence(h, mi, day, month, now, tz = defaultZone()) {
  const year = localParts(now, tz).y;
  for (const y of [year, year + 1]) {
    const t = zonedToUtc({ y, m: month + 1, d: day, h, mi }, tz);
    const back = localParts(t, tz);
    if (back.d !== day || back.m !== month + 1) return null;          // e.g. 31 Feb
    if (t > now) return t;
  }
  return null;
}

const CLOCK = '(\\d{1,2}):(\\d{2})\\s*([AaPp][Mm])';
export function parseTryAgain(text, now, tz) {
  const m = new RegExp(`try again at ${CLOCK}`, 'i').exec(text);
  if (!m) return null;
  const h = to24(m[1], m[3]), mi = Number(m[2]);
  return h === null || mi > 59 ? null : nextLocalOccurrence(h, mi, now, tz);
}
// "5h limit: [...] 0% left (resets 11:44 AM)" and "(resets 7:18 AM on 4 Nov)". Returns the window only when it names a reset.
export function parseStatusWindow(text, now, tz) {
  const m = new RegExp(`(\\d{1,3})% left \\(resets ${CLOCK}(?: on (\\d{1,2}) ([A-Za-z]{3}))?\\)`, 'i').exec(text);
  if (!m) return null;
  const h = to24(m[2], m[4]), mi = Number(m[3]);
  if (h === null || mi > 59) return null;
  const month = m[6] ? MONTHS.indexOf(m[6].toLowerCase()) : -1;
  if (m[5] && month < 0) return null;
  const resetsAt = m[5] ? nextDatedOccurrence(h, mi, Number(m[5]), month, now, tz) : nextLocalOccurrence(h, mi, now, tz);
  return resetsAt === null ? null : { percentLeft: Number(m[1]), resetsAt };
}
