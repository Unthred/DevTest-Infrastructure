// Issue #1326: the record line under the 24 hour first review approval card and the merged per hour card. The figures are the stored
// best day record as GET /api/v1/best serves it (supervisor/api/models/best.mjs); nothing is worked out again here.
import { build } from './api/models/best.mjs';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// The best model for the view; null when the record cannot be read, so the cards stay as they were.
export function bestForView(root, now) {
  try {
    return build(null, { root, now });
  } catch {
    return null;
  }
}

function dayMonth(ms, tz, withMonth) {
  const parts = { day: 'numeric', ...(withMonth ? { month: 'short' } : {}) };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: tz || 'UTC' }).format(ms);
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...parts, timeZone: 'UTC' }).format(ms);
  }
}

// "6 to 7 Nov", or "30 Oct to 1 Nov" across a month end; one date when the window stays within one day of the viewer's clock.
export function windowDates(record, tz) {
  const start = Date.parse(record.start);
  const end = Date.parse(record.end);
  const from = dayMonth(start, tz, false);
  const to = dayMonth(end, tz, false);
  const month = dayMonth(end, tz, true).replace(/^\d+ /, '');
  const fromMonth = dayMonth(start, tz, true).replace(/^\d+ /, '');
  if (from === to && fromMonth === month) return `${to} ${month}`;
  return fromMonth === month ? `${from} to ${to} ${month}` : `${from} ${fromMonth} to ${to} ${month}`;
}

const rateText = rate => `${(Math.round(rate * 10) / 10).toLocaleString('en-GB', { minimumFractionDigits: 1 })}%`;

function lineText(id, best, tz) {
  if (id === 'first-pass') {
    const record = best.records.approval;
    if (!record) return null;
    const text = `Best 24 hours ${rateText(record.rate)} (${record.approved} of ${record.reviewed}), ${windowDates(record, tz)}`;
    return best.distance.approval > 0 ? `${text}. Record beaten: the last 24 hours are ${best.distance.approval} points above it` : text;
  }
  const record = best.records.merges;
  if (!record) return null;
  const text = `Most merged in 24 hours ${record.merged}, ${windowDates(record, tz)}`;
  return best.distance.merges > 0 ? `${text}. Record beaten: the last 24 hours are ${best.distance.merges} above it` : text;
}

// The line as HTML, or '' for any other card or when no record is stored.
export function bestLine(id, best, tz) {
  if (!best?.records || (id !== 'first-pass' && id !== 'merge-rate')) return '';
  const text = lineText(id, best, tz);
  if (!text) return '';
  const beaten = text.includes('Record beaten');
  return `<div class="hl-best sub" data-best="${esc(id)}"${beaten ? ' data-beaten="true"' : ''}>${esc(text)}</div>`;
}
