// Issue #1163: the reading line of an allowance card on the Usage page: the age of the reading, where it came from, and a stale badge when
// it is older than the age limit. Page helpers are passed in (the resetscard pattern). Every dynamic value goes through esc().
export function readingLine(h, u, now) {
  if (!u.windows.length) return '';
  const age = Number.isFinite(u.observedAt) ? `${h.dur(now - u.observedAt)} old` : 'age unknown';
  const stale = u.stale ? `${h.badge('warning', 'Stale')} ` : '';
  const text = u.stale ? `Stale: the last reading is ${age}, past the ${u.maxAgeMinutes} minute limit. It is not current and Foreman refreshes it before the next job starts.` : `Reading is ${age}.`;
  const kinds = u.kinds?.length ? ` Limits in this reading: ${u.kinds.join('; ')}.` : '';
  const session = u.sessionTracked ? '' : ' The provider has not reported a 5 hour session limit.';
  return `<p class="sub reading" data-stale="${u.stale ? 'true' : 'false'}">${stale}${h.esc(text + kinds + session)}</p>`;
}
