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
  if (/^(homeowner|fixlimit|reviewlimit|unqueued|tick-failed|job|rebase-lost|migration|split|decision|noreviewer|stalled|stall)(-|$)/.test(s)) return 'action';
  if (/^(ci|tick-stale|no-tick|idle|pause|drift|lease|register)(-|$)/.test(s)) return 'warning';
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
// Case-insensitive "contains" over the given keys. "#41" matches number 41 (people type the number the way the page shows it).
export function filterRows(rows, query, keys) {
  const q = String(query || '').trim().toLowerCase().replace(/^#/, '');
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
  return { ...paginate(filtered, page, pageSize), footer: footer(filtered, totals), all: rows.length };
}

// ---- live tables (issue #61). The URL stays the single source of truth: a control change or a link click becomes a new URL for
// ONE table (its `<id>.*` parameters) merged into the current address, fetched in place; nothing else on the page is touched.
// Replace every `<id>.` parameter of `current` by those of `incoming`; other parameters (other tables, range) are kept.
export function mergeTableParams(current, incoming, id) {
  const cur = new URLSearchParams(current), inc = new URLSearchParams(incoming), out = new URLSearchParams();
  for (const [k, v] of cur) if (!k.startsWith(`${id}.`)) out.append(k, v);
  for (const [k, v] of inc) if (k.startsWith(`${id}.`)) out.append(k, v);
  return out.toString();
}
// A control change: set the given params of table `id`; empty/null removes one. Any change but a page change goes back to page 1.
export function tableChange(current, id, set) {
  const q = new URLSearchParams(current);
  for (const [k, v] of Object.entries(set)) { if (v === null || v === undefined || v === '') q.delete(`${id}.${k}`); else q.set(`${id}.${k}`, String(v)); }
  if (!('page' in set)) q.delete(`${id}.page`);
  return q.toString();
}
// Trailing-edge debounce with an injectable clock so the behaviour can be tested without waiting.
export function debounce(fn, ms, timers = { set: setTimeout, clear: clearTimeout }) {
  let t = null;
  const run = (...a) => { if (t !== null) timers.clear(t); t = timers.set(() => { t = null; fn(...a); }, ms); };
  run.cancel = () => { if (t !== null) timers.clear(t); t = null; };
  return run;
}
export const FILTER_DEBOUNCE_MS = 250;
// "n of m": n rows match the filter, m rows exist.
export const countText = (n, m, noun) => `${n} of ${m} ${noun}`;

// ---- collapsing cards (issue #61): saved with the layout, per breakpoint, by card id
export function toggleCollapsed(list, id) {
  const set = new Set(Array.isArray(list) ? list : []);
  if (set.has(id)) set.delete(id); else set.add(id);
  return [...set];
}
export const sanitizeCollapsed = (saved, ids) => (Array.isArray(saved) ? [...new Set(saved.filter(i => typeof i === 'string' && ids.includes(i)))] : []);

// ---- back-to-top button (issue #61): shown once the page has scrolled down a little
export const BACK_TO_TOP_AFTER = 400;
export const showBackToTop = (y, after = BACK_TO_TOP_AFTER) => Number.isFinite(y) && y > after;

// ---- status colours (issue #61): one rule everywhere. Up to date = green; something to do = amber with a label that says what;
// failed or latched = red. Never amber for "nothing is wrong".
export function versionStatus(v) {
  const s7 = x => String(x || '').slice(0, 7);
  const href = '/supervisor#c-h-version';
  if (!v) return { level: 'info', label: 'Version unknown', href };
  if (v.latched) return { level: 'action', label: `Upgrade latched at ${s7(v.installed)}`, href };
  if (['rolled_back', 'rollback_failed'].includes(v.result)) return { level: 'action', label: `Upgrade failed (${String(v.result).replace('_', ' ')})`, href };
  if (v.running && v.running !== v.installed) return { level: 'warning', label: `Restart needed: ${s7(v.running)} running, ${s7(v.installed)} installed`, href };
  if (v.drift && Number.isSafeInteger(v.behind) && v.behind > 0 && Number.isFinite(v.nextTryAt)) return { level: 'warning', label: `${v.behind} commit${v.behind === 1 ? '' : 's'} behind, next try ${new Date(v.nextTryAt).toISOString().slice(11, 16)} UTC`, href };
  if (v.drift) return { level: 'warning', label: `Deploy needed: ${s7(v.installed)} → ${s7(v.main)}`, href };
  return { level: 'ok', label: `Up to date (${s7(v.installed)})`, href };
}

// ---- header status pills (issue #61): where each pill leads. #att-<id> is an attention item, #c-<id> a card; the target is
// highlighted with :target. Returns an href per pill.
export function pillLinks({ health, attention = [], version } = {}) {
  const first = re => attention.find(a => re.test(String(a.id)));
  const att = a => (a ? `/system#att-${a.id}` : '/system');
  let healthHref = '/agents';
  if (health?.state === 'needs_you') healthHref = att(attention.find(a => a.severity === 'action'));
  else if (health?.state === 'stuck') healthHref = first(/^tick-stale/) ? '/supervisor#c-h-tick' : att(first(/^idle/));
  else if (health?.state === 'paused' || health?.state === 'unknown') healthHref = first(/^(pause|idle)/) ? att(first(/^(pause|idle)/)) : '/agents';
  return { health: healthHref, tick: '/supervisor#c-h-tick', data: '/supervisor#c-h-tick', team: '/system#c-sys', version: versionStatus(version).href };
}

// ---- time range for charts
export const RANGES = { '24h': 24 * 3600000, '7d': 7 * 86400000, '30d': 30 * 86400000 };
export const DEFAULT_RANGE = '7d';
// The range to show (issue #140): an explicit address wins; otherwise the viewer's saved choice if it is a known range.
export const chooseRange = (saved, inUrl) => (inUrl in RANGES ? inUrl : saved in RANGES ? saved : DEFAULT_RANGE);
export const rangeMs = r => RANGES[r] ?? RANGES[DEFAULT_RANGE];
export const inRange = (at, now, range) => Number.isFinite(at) && now - at <= rangeMs(range) && at <= now + 60000;

// ---- layout: saved per breakpoint, never shared between them
export const BREAKPOINTS = { phone: 0, tablet: 640, desktop: 1100 };
export const breakpointOf = width => (width >= BREAKPOINTS.desktop ? 'desktop' : width >= BREAKPOINTS.tablet ? 'tablet' : 'phone');
// Apply a saved { order: [ids], span: {id: n}, h: {id: px} } to the card ids actually present. Unknown saved ids are dropped, new
// cards appended. Sizes are saved per breakpoint, in that breakpoint's own column units; on a phone only the order applies.
export function applyLayout(ids, saved, bp) {
  const order = Array.isArray(saved?.order) ? saved.order.filter(i => ids.includes(i)) : [];
  const full = [...order, ...ids.filter(i => !order.includes(i))];
  const span = {}, h = {};
  const collapsed = sanitizeCollapsed(saved?.collapsed, ids);
  if (bp !== 'phone') {
    for (const [k, v] of Object.entries(saved?.span || {})) if (ids.includes(k) && Number.isInteger(v) && v >= 1 && v <= 12) span[k] = v;
    for (const [k, v] of Object.entries(saved?.h || {})) if (ids.includes(k) && Number.isInteger(v) && v >= ROW_STEP && v <= 4000) h[k] = v;
  }
  return { order: full, span, h, collapsed };
}

// ---- card resizing (issue #58): snap to the grid, limits per card type, never smaller than the content
export const ROW_STEP = 40;   // px: card heights snap to this step
export const MIN_CARD_H = 120;   // px: a resized card never gets shorter than this, even when its content is shorter
// Width is in grid columns (12 on desktop, 6 on tablet). A saved height is a min-height, so content can never be clipped.
// vlock: the card's height is its content (charts scale with their width, KPI tiles are one fixed shape).
export const CARD_LIMITS = {
  panel: { minSpan: 3, maxSpan: 12, maxH: 800 },
  kpi: { minSpan: 2, maxSpan: 4, vlock: true },
  chart: { minSpan: 4, maxSpan: 12, vlock: true },
  queue: { minSpan: 3, maxSpan: 12, maxH: 800 },
  table: { minSpan: 6, maxSpan: 12, maxH: 1200 },
  info: { minSpan: 3, maxSpan: 12, maxH: 800 }
};
export const limitsOf = type => CARD_LIMITS[type] || CARD_LIMITS.info;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
// Column limits for a breakpoint. Tablet has 6 columns, so the limits are halved (at least 2, at most 6).
export function spanLimits(type, bp) {
  const l = limitsOf(type);
  if (bp === 'tablet') return { cols: 6, min: clamp(Math.ceil(l.minSpan / 2), 2, 6), max: clamp(Math.ceil(l.maxSpan / 2), 2, 6) };
  return { cols: 12, min: l.minSpan, max: l.maxSpan };
}
// A drag from one of the 8 edges/corners (n s e w ne nw se sw); dx, dy are pointer movement in px. Dragging the west or north
// edge outward (left/up) grows the card, as in a window; the grid keeps its order. natH is the content's own height at that width.
export function resizeBox({ edge, dx, dy, span, h, natH = 0, colW, type, bp = 'desktop' }) {
  const l = limitsOf(type), sl = spanLimits(type, bp), e = String(edge);
  const cw = colW > 0 ? colW : 1, ddx = Number.isFinite(dx) && colW > 0 ? dx : 0, ddy = Number.isFinite(dy) ? dy : 0;   // NaN or a zero-width column resizes nothing
  let nSpan = span;
  if (e.includes('e')) nSpan = span + Math.round(ddx / cw);
  if (e.includes('w')) nSpan = span - Math.round(ddx / cw);
  nSpan = clamp(nSpan, sl.min, sl.max);
  let nH = h;
  if (!l.vlock && (e.includes('s') || e.includes('n'))) {
    const floor = Math.max(MIN_CARD_H, Math.ceil(natH / ROW_STEP) * ROW_STEP);
    nH = clamp(Math.round((h + (e.includes('s') ? ddy : -ddy)) / ROW_STEP) * ROW_STEP, floor, Math.max(floor, l.maxH));
  }
  return { span: nSpan, h: l.vlock ? null : nH };
}

// ---- dockable navigation (issue #58). Saved per breakpoint; a phone always keeps the fixed bottom tab bar.
export const DOCKS = ['top', 'bottom', 'left', 'right'];
export const dockOf = v => (DOCKS.includes(v) ? v : 'top');
export const effectiveDock = (saved, bp) => (bp === 'phone' ? 'bottom' : dockOf(saved));
// The window edge nearest to a point (x, y) in a w x h window: where a dragged navigation bar would dock.
export function dockFromPoint(x, y, w, h) {
  if (!(w > 0 && h > 0)) return 'top';
  const d = { top: y / h, bottom: (h - y) / h, left: x / w, right: (w - x) / w };
  return DOCKS.reduce((best, k) => (d[k] < d[best] ? k : best), 'top');
}

// ---- back navigation (issue #58)
export const TOP_PAGES = { agents: 'Agents', work: 'Work', activity: 'Activity', usage: 'Usage & cost', reviews: 'Reviews', system: 'System' };
// The trail for a page: Overview > Work > PR #41. [href, label]; the last item has no link. Overview itself has no trail.
export function trail(page, extra = []) {
  if (page === 'overview') return [];
  if (TOP_PAGES[page]) return [['/', 'Overview'], [null, TOP_PAGES[page]]];
  return [['/', 'Overview'], ...extra];
}
// Scroll position to restore: a positive finite number, clamped to what the page can scroll; anything else is ignored.
export const restorableScroll = (saved, maxY) => (Number.isFinite(saved) && saved > 0 ? Math.min(Math.round(saved), Math.max(0, maxY)) : 0);
export function moveItem(order, id, delta) {
  const i = order.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= order.length) return order.slice();
  const out = order.slice(); [out[i], out[j]] = [out[j], out[i]]; return out;
}

// ---- copy buttons (issue #72). The page is served over plain HTTP on the LAN, which is not a secure context, so the
// asynchronous Clipboard API is usually missing; the order of fallbacks is chosen here so it can be tested.
export function copyMethods({ secure = false, clipboard = false, execCommand = false } = {}) {
  return [...(secure && clipboard ? ['clipboard'] : []), ...(execCommand ? ['exec'] : []), 'manual'];
}
export const COPY_FEEDBACK_MS = 1600;
export const copyFeedback = ok => (ok ? { state: 'copied', label: 'Copied', announce: 'Copied to the clipboard' } : { state: 'failed', label: 'Select and copy', announce: 'Could not copy automatically; the text is selected for you to copy' });

// ---- chart legends (issue #160): one shared handler for every chart.
// `hidden` is the list of series keys the viewer hid; `all` is every series key the chart's legend offers.
// A chart never hides its last visible series: toggling it is a no-op.
export function toggleSeries(hidden, key, all) {
  const set = new Set((hidden || []).filter(k => all.includes(k)));
  if (set.has(key)) { set.delete(key); return [...set]; }
  if (!all.includes(key) || all.every(k => k === key || set.has(k))) return [...set];
  set.add(key); return [...set];
}
// Stored state may be stale (a series that no longer exists) or hand-edited: keep only known keys, and never all of them.
export function sanitizeHidden(stored, all) {
  const list = Array.isArray(stored) ? stored.filter(k => typeof k === 'string' && all.includes(k)) : [];
  return all.length && all.every(k => list.includes(k)) ? list.slice(0, -1) : [...new Set(list)];
}
