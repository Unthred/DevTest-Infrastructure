// Pure UI logic for the dashboard (issue #54). Imported by the server-side renderer and served as-is to the browser script,
// so the tests exercise exactly the code the page runs. No DOM, no I/O.

// Severity is one scale everywhere. Colour is never the only signal: each level also has a label and an icon name.
export const SEVERITIES = {
  action: { rank: 3, label: 'Action needed', icon: 'alert' },
  warning: { rank: 2, label: 'Warning', icon: 'warn' },
  info: { rank: 1, label: 'Info', icon: 'info' },
  ok: { rank: 0, label: 'OK', icon: 'check' }
};
// Attention item id -> severity. Anything that waits on the homeowner, or that has stopped work, is Action needed.
export function severityOf(id) {
  const s = String(id || '');
  if (/^(homeowner|tick-failed|job)(-|$)/.test(s)) return 'action';
  if (/^(ci|tick-stale|no-tick|idle|pause|drift|lease)(-|$)/.test(s)) return 'warning';
  return 'info';
}
export const worst = levels => levels.reduce((w, l) => ((SEVERITIES[l]?.rank ?? 0) > (SEVERITIES[w]?.rank ?? 0) ? l : w), 'ok');

// ---- tables
export const PAGE_SIZES = [10, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 25;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
// Numbers sort numerically, everything else as text; missing values always sort last, in either direction.
export function compareValues(a, b, dir = 'asc') {
  const missing = v => v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));
  if (missing(a) && missing(b)) return 0;
  if (missing(a)) return 1;
  if (missing(b)) return -1;
  const c = isNum(a) && isNum(b) ? a - b : String(a).localeCompare(String(b), 'en', { numeric: true, sensitivity: 'base' });
  return dir === 'desc' ? -c : c;
}
export function sortRows(rows, key, dir = 'asc') {
  if (!key) return rows.slice();
  return rows.map((r, i) => [r, i]).sort((x, y) => compareValues(x[0][key], y[0][key], dir) || x[1] - y[1]).map(x => x[0]);   // stable
}
export function filterRows(rows, query, keys) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return rows.slice();
  return rows.filter(r => keys.some(k => String(r[k] ?? '').toLowerCase().includes(q)));
}
export function paginate(rows, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const size = PAGE_SIZES.includes(Number(pageSize)) ? Number(pageSize) : DEFAULT_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(pages, Math.max(1, Math.floor(Number(page)) || 1));
  return { rows: rows.slice((p - 1) * size, p * size), page: p, pages, pageSize: size, total: rows.length, from: rows.length ? (p - 1) * size + 1 : 0, to: Math.min(rows.length, p * size) };
}
// Footer over ALL rows that match the filter (not just the visible page). spec: { key: 'sum' | 'avg' | 'count' }.
export function footer(rows, spec) {
  const out = {};
  for (const [key, op] of Object.entries(spec)) {
    const vals = rows.map(r => r[key]).filter(isNum);
    if (op === 'count') out[key] = rows.length;
    else if (op === 'sum') out[key] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    else if (op === 'avg') out[key] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return out;
}
export function tableState(rows, { sort, dir = 'asc', q = '', page = 1, pageSize = DEFAULT_PAGE_SIZE, searchKeys = [], totals = {} } = {}) {
  const filtered = sortRows(filterRows(rows, q, searchKeys), sort, dir);
  return { ...paginate(filtered, page, pageSize), footer: footer(filtered, totals) };
}

// ---- time range for charts
export const RANGES = { '24h': 24 * 3600000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
export const DEFAULT_RANGE = '7d';
export const rangeMs = r => RANGES[r] ?? RANGES[DEFAULT_RANGE];
export const inRange = (at, now, range) => Number.isFinite(at) && now - at <= rangeMs(range) && at <= now + 60000;

// ---- layout: saved per breakpoint, never shared between them
export const BREAKPOINTS = { phone: 0, tablet: 640, desktop: 1100 };
export const breakpointOf = width => (width >= BREAKPOINTS.desktop ? 'desktop' : width >= BREAKPOINTS.tablet ? 'tablet' : 'phone');
// Apply a saved { order: [ids], span: {id: n} } to the card ids actually present. Unknown saved ids are dropped, new cards appended.
export function applyLayout(ids, saved, bp) {
  const order = Array.isArray(saved?.order) ? saved.order.filter(i => ids.includes(i)) : [];
  const full = [...order, ...ids.filter(i => !order.includes(i))];
  const span = {};
  if (bp !== 'phone') for (const [k, v] of Object.entries(saved?.span || {})) if (ids.includes(k) && Number.isInteger(v) && v >= 1 && v <= 12) span[k] = v;   // phone: reorder only
  return { order: full, span };
}
export function moveItem(order, id, delta) {
  const i = order.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return order.slice();
  const out = order.slice(); [out[i], out[j]] = [out[j], out[i]]; return out;
}
