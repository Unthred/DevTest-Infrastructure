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
  if (/^(homeowner|fixlimit|reviewlimit|reviewrefused|prclosed|tick-failed|job|rebase-lost|migration|split|decision|noreviewer|stalled|stall)(-|$)/.test(s)) return 'action';
  if (/^(ci|board-paused|tick-stale|no-tick|idle|pause|drift|lease|register|history)(-|$)/.test(s)) return 'warning';
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
export function debounce(fn, ms, timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }) {
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
  // Issue #695: merged but not installed; the pill says when the next install is (or why it waits), never that merged means installed.
  if (v.drift && v.nextInstall) { const n = Number.isSafeInteger(v.behind) && v.behind > 0 ? `${v.behind} merged commit${v.behind === 1 ? '' : 's'} not installed` : 'Merged, not installed'; return { level: 'warning', label: `${n}. Next install: ${Number.isFinite(v.nextInstall.at) ? `not before ${tmark(v.nextInstall.at)}` : v.nextInstall.why}`, href }; }
  if (v.drift && Number.isSafeInteger(v.behind) && v.behind > 0 && Number.isFinite(v.nextTryAt)) return { level: 'warning', label: `${v.behind} commit${v.behind === 1 ? '' : 's'} behind, next try ${tmark(v.nextTryAt)}`, href };
  if (v.drift) return { level: 'warning', label: `Deploy needed: ${s7(v.installed)} → ${s7(v.main)}`, href };
  return { level: 'ok', label: `Up to date (${s7(v.installed)})`, href };
}

// ---- header status pills (issue #61): where each pill leads. #att-<id> is an attention item, #c-<id> a card; the target is
// highlighted with :target. Returns an href per pill.
export function pillLinks({ health, attention = [], needsYou, version } = {}) {
  const first = re => attention.find(a => re.test(String(a.id)));
  const att = a => (a ? `/system#att-${a.id}` : '/system');
  let healthHref = '/agents';
  if (health?.state === 'needs_you') healthHref = att(Array.isArray(needsYou) ? needsYou[0] : attention.find(a => a.severity === 'action'));
  else if (health?.state === 'stuck') healthHref = first(/^tick-stale/) ? '/supervisor#c-h-tick' : att(first(/^idle/));
  else if (health?.state === 'paused' || health?.state === 'unknown') healthHref = first(/^(pause|idle)/) ? att(first(/^(pause|idle)/)) : '/agents';
  return { health: healthHref, tick: '/supervisor#c-h-tick', data: '/supervisor#c-h-tick', team: '/system#c-sys', version: versionStatus(version).href };
}

// ---- time range for charts
export const RANGES = { '24h': 24 * 3600000, '7d': 7 * 86400000, '30d': 30 * 86400000, all: Infinity };   // 'all' (issue #362): back to the first retained record
export const DEFAULT_RANGE = '7d';
// The range to show (issue #140): an explicit address wins; otherwise the viewer's saved choice if it is a known range.
export const chooseRange = (saved, inUrl) => (Object.hasOwn(RANGES, inUrl) ? inUrl : Object.hasOwn(RANGES, saved) ? saved : DEFAULT_RANGE);
export const rangeMs = r => (Object.hasOwn(RANGES, r) ? RANGES[r] : RANGES[DEFAULT_RANGE]);
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
    for (const [k, v] of Object.entries(saved?.h || {})) if (ids.includes(k) && Number.isInteger(v) && v >= 40 && v <= 4000) h[k] = v;
  }
  return { order: full, span, h, collapsed };
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
export const TOP_PAGES = { agents: 'Agents', work: 'Work', inbox: 'Inbox', activity: 'Activity', usage: 'Usage & cost', reviews: 'Reviews', system: 'System' };
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
// A chart never hides its last visible data series: toggling it is a no-op. `free` lists marker-only keys (reference lines such as
// "Window reset"); they toggle freely and never count as a series, so a chart cannot be left showing only markers.
export function toggleSeries(hidden, key, all, free = []) {
  const set = new Set((hidden || []).filter(k => all.includes(k) || free.includes(k)));
  if (set.has(key)) { set.delete(key); return [...set]; }
  if (free.includes(key)) { set.add(key); return [...set]; }
  if (!all.includes(key) || all.every(k => k === key || set.has(k))) return [...set];
  set.add(key); return [...set];
}
// Stored state may be stale (a series that no longer exists), duplicated or hand-edited: keep only known keys once each, and never
// every data series (the last data series in the list is dropped, so it shows again).
export function sanitizeHidden(stored, all, free = []) {
  const list = Array.isArray(stored) ? [...new Set(stored.filter(k => typeof k === 'string' && (all.includes(k) || free.includes(k))))] : [];
  if (all.length && all.every(k => list.includes(k))) { const last = list.findLast(k => all.includes(k)); return list.filter(k => k !== last); }
  return list;
}

// ---- local time (issue #76). Data stays in UTC; only rendering changes. The server renders every time as
// <time datetime="…Z">… UTC</time>; the browser script rewrites it with this function in the viewer's own time zone.
export function formatLocal(ms, tz) {
  if (!Number.isFinite(ms)) return 'unknown';
  let zone = tz; try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); } catch { zone = 'UTC'; }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}
// A time inside plain text (review of PR #217): a readable, labelled UTC stamp "YYYY-MM-DD HH:MM UTC", so any consumer of
// the view (team status, its --json, /api/view.json, overseer notes) gets plain text. Renderers that know the viewer's zone
// rewrite each stamp with localStamps(): the dashboard into <time data-local> (escT), team status into its own time zone.
export const tmark = ms => (Number.isFinite(ms) ? `${new Date(ms).toISOString().slice(0, 10)} ${new Date(ms).toISOString().slice(11, 16)} UTC` : 'unknown');
export const localStamps = (text, fn) => String(text).replace(/\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\b/g, (_, d, hm) => fn(Date.parse(`${d}T${hm}:00Z`)));
export const timeOnly = (ms, tz) => formatLocal(ms, tz).slice(11);

// ---- Activity (issue #76): idle ticks collapse, rows filter by agent, outcome and job kind.
// A row is { at, text, link, kind: 'tick'|'job'|'review'|'merge'|…, idle?, agent?, outcome?, jobKind?, durationMs?, tokens? }.
// A run of two or more adjacent idle rows (newest first) becomes one { kind: 'idle-run', count, from, to, ticks } row. Any row
// that is not idle, from any source, ends a run, so a busy tick between two idle runs gives two runs.
export function collapseIdle(rows) {
  const out = []; let run = [];
  const flush = () => {
    if (run.length > 1) out.push({ at: run[0].at, kind: 'idle-run', idle: true, outcome: 'idle', agent: null, jobKind: null, count: run.length, from: run[run.length - 1].at, to: run[0].at, ticks: run, text: `${run.length} idle ticks` });
    else out.push(...run);
    run = [];
  };
  for (const r of rows) { if (r.idle) run.push(r); else { flush(); out.push(r); } }
  flush();
  return out;
}
export const ACTIVITY_FILTERS = ['agent', 'outcome', 'kind'];
// Filters combine (all must match). A value not offered is ignored rather than hiding everything.
export function activityFilters(query) {
  const f = {};
  for (const k of ACTIVITY_FILTERS) { const v = query.get(`act.${k}`); if (v) f[k] = v; }
  return f;
}
export function filterActivity(rows, f) {
  return rows.filter(r => (!f.agent || r.agent === f.agent) && (!f.outcome || r.outcome === f.outcome) && (!f.kind || r.jobKind === f.kind));
}
