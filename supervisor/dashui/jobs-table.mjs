// Jobs table logic (issue #1220): the row builder, the filters with their counts, grouping, sorting, the totals row and the CSV, as pure
// functions of the job rows the dashboard view carries. No DOM, no I/O. The server renders the page from these (jobs-page.mjs) and the
// browser imports the same file to build the CSV of the current table, so what is exported is what the page filtered.
// Unknown stays unknown everywhere: a job with no reported tokens or cost is never counted as 0.

export const COLUMNS = [
  { key: 'id', label: 'Id' }, { key: 'kind', label: 'Kind' }, { key: 'agent', label: 'Agent' }, { key: 'model', label: 'Model' },
  { key: 'effort', label: 'Effort' }, { key: 'ref', label: 'Ref', num: true }, { key: 'status', label: 'Status' }, { key: 'cause', label: 'Cause' },
  { key: 'startedAt', label: 'Started', num: true }, { key: 'durationMs', label: 'Duration', num: true },
  { key: 'tokensIn', label: 'Tokens in', num: true }, { key: 'tokensOut', label: 'Tokens out', num: true },
  { key: 'costGbp', label: 'Cost (£)', num: true }, { key: 'attempts', label: 'Attempts', num: true }, { key: 'wasted', label: 'Wasted tokens', num: true },
];
export const COLUMN_KEYS = COLUMNS.map(c => c.key);
export const DAY_RANGES = [{ id: '24h', label: 'Last 24 hours', ms: 86400000 }, { id: '7d', label: 'Last 7 days', ms: 7 * 86400000 }];
export const GROUPS = [{ id: 'cause', label: 'Cause' }, { id: 'agent', label: 'Agent' }, { id: 'kind', label: 'Kind' }, { id: 'ref', label: 'Ref' }];
export const NO_CAUSE = 'none';
export const PAGE_SIZE = 100;
// The facets shown as buttons with counts, in page order. `value` is what a row has for the facet.
export const FACETS = [
  { id: 'agent', label: 'Agent' }, { id: 'kind', label: 'Kind' }, { id: 'status', label: 'Status' }, { id: 'cause', label: 'Cause' },
];

const ISSUE_KINDS = new Set(['implement', 'continue']);
const finite = n => (Number.isFinite(n) ? n : null);

// One table row from one job row of the view. Pull request work (review, fix, rebase) refers to a pull request, implement work to an issue.
export function buildRow(j) {
  const refKind = j.ref == null ? null : ISSUE_KINDS.has(j.kind) ? 'issue' : 'pr';
  return {
    id: String(j.id || String(j.fullId || '').slice(0, 8)).slice(0, 8), fullId: j.fullId || j.id, kind: j.kind || 'job', agent: j.agent || null,
    model: j.model || null, effort: j.effort || null, ref: j.ref ?? null, refKind, status: j.status || 'unknown',
    cause: j.cause || null, causeLabel: j.causeLabel || null, startedAt: finite(j.startedAt), durationMs: finite(j.elapsedMs),
    tokensIn: finite(j.inTokens), tokensOut: finite(j.outTokens), costGbp: finite(j.costGbp), attempts: finite(j.attempts),
    wasted: finite(j.wastedTokens), tokens: finite(j.tokens),
  };
}
export const buildRows = list => list.map(buildRow);

export const refText = r => (r.ref == null ? '' : `${r.refKind === 'issue' ? 'Issue' : 'PR'} #${r.ref}`);
export const refKey = r => (r.ref == null ? null : `${r.refKind}:${r.ref}`);

// The value a row has for a facet (a job with no recorded cause has the cause `none`).
export const facetValue = (row, facet) => (facet === 'cause' ? row.cause || NO_CAUSE : row[facet] ?? 'unknown');

// ---- the query ----
const word = (v, max = 60) => String(v ?? '').slice(0, max);
export function parseJobsQuery(params) {
  const get = k => params.get(k) ?? '';
  const group = get('group');
  const page = Number.parseInt(get('page'), 10);
  return {
    agent: word(get('agent')), kind: word(get('kind')), status: word(get('status')), cause: word(get('cause')),
    range: DAY_RANGES.some(r => r.id === get('range')) ? get('range') : '',
    q: word(get('q'), 200), group: GROUPS.some(g => g.id === group) ? group : '',
    sort: COLUMN_KEYS.includes(get('sort')) ? get('sort') : 'startedAt', dir: get('dir') === 'asc' ? 'asc' : 'desc',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1, job: /^[a-f0-9]{8,32}$/.test(get('job')) ? get('job') : '',
  };
}
// The address query for a set of filters; filters that are off are left out.
export function jobsQuery(f, change = {}) {
  const next = { ...f, ...change };
  const q = new URLSearchParams({ view: 'jobs' });
  for (const k of ['agent', 'kind', 'status', 'cause', 'range', 'q', 'group']) if (next[k]) q.set(k, next[k]);
  q.set('sort', next.sort);   // always written, so only the Jobs switch link is a bare address (the one that restores the last saved view)
  q.set('dir', next.dir);
  if (next.page > 1) q.set('page', String(next.page));
  if (next.job) q.set('job', next.job);
  return q.toString();
}

// ---- filtering ----
const searchText = r => [r.id, r.fullId, r.kind, r.agent, r.model, r.effort, r.status, r.causeLabel, r.cause, refText(r), r.ref == null ? '' : `#${r.ref}`].join(' ').toLowerCase();
export function matchesSearch(row, q) {
  const words = String(q || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = searchText(row);
  return words.every(w => hay.includes(w));
}
// `skip` leaves one facet out, which is how a button's count shows what choosing it would give (the other filters stay applied).
// The day range is not a facet: its two buttons are counted by applying each range in turn (facetCounts).
export function applyFilters(rows, f, now, skip = null) {
  const range = DAY_RANGES.find(r => r.id === f.range);
  return rows.filter(r => (!range || (r.startedAt != null && now - r.startedAt <= range.ms))
    && FACETS.every(({ id }) => skip === id || !f[id] || facetValue(r, id) === f[id])
    && matchesSearch(r, f.q));
}
// For each facet the values present with their counts (largest first, then by name), plus the day ranges.
export function facetCounts(rows, f, now) {
  const out = {};
  for (const { id } of FACETS) {
    const m = new Map();
    for (const r of applyFilters(rows, f, now, id)) m.set(facetValue(r, id), (m.get(facetValue(r, id)) || 0) + 1);
    if (f[id] && !m.has(f[id])) m.set(f[id], 0);
    out[id] = [...m].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))).map(([value, count]) => ({ value, count }));
  }
  out.range = DAY_RANGES.map(r => ({ value: r.id, label: r.label, count: applyFilters(rows, { ...f, range: r.id }, now).length }));
  return out;
}
export const filtersOn = f => !!(f.agent || f.kind || f.status || f.cause || f.range || f.q);

// ---- sorting, grouping ----
const sortValue = (r, key) => (key === 'cause' ? r.causeLabel || r.cause : key === 'ref' ? r.ref : r[key]);
export function sortRows(rows, key = 'startedAt', dir = 'desc') {
  const sign = dir === 'asc' ? 1 : -1;
  return rows.map((r, i) => [r, i]).sort(([a, ia], [b, ib]) => {
    const x = sortValue(a, key), y = sortValue(b, key);
    if (x == null && y == null) return ia - ib;
    if (x == null) return 1;   // unknown sorts last in either direction
    if (y == null) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en-GB', { numeric: true })) * sign || ia - ib;
  }).map(([r]) => r);
}
const groupLabel = (by, r) => (by === 'cause' ? r.causeLabel || 'No cause recorded' : by === 'ref' ? refText(r) || 'No ref' : r[by] || 'unknown');
export function groupRows(rows, by) {
  if (!by) return [{ key: '', label: '', rows }];
  const m = new Map();
  for (const r of rows) { const label = groupLabel(by, r); m.set(label, [...(m.get(label) || []), r]); }
  return [...m].map(([label, list]) => ({ key: label, label, rows: list })).sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
}

// ---- totals ----
// Tokens, cost and wasted tokens add up what is known; `unknown` counts the jobs that could not be added in, so a total never hides them.
// The share wasted is wasted tokens over tokens, taken over the jobs where both are known; null when there is nothing to divide.
export function totalsRow(rows) {
  const sum = pick => {
    let total = 0, known = 0;
    for (const r of rows) { const v = pick(r); if (v != null) { total += v; known++; } }
    return { total: known ? total : null, unknown: rows.length - known };
  };
  const tokens = sum(r => (r.tokensIn == null || r.tokensOut == null ? r.tokens : r.tokensIn + r.tokensOut));
  const cost = sum(r => r.costGbp);
  const wasted = sum(r => r.wasted);
  let w = 0, t = 0;
  for (const r of rows) { const tk = r.tokensIn == null || r.tokensOut == null ? r.tokens : r.tokensIn + r.tokensOut; if (r.wasted != null && tk != null) { w += r.wasted; t += tk; } }
  return { jobs: rows.length, tokens, cost: { ...cost, total: cost.total == null ? null : Math.round(cost.total * 100) / 100 }, wasted, shareWasted: t > 0 ? Math.round((w / t) * 1000) / 10 : null };
}

// ---- display text (shared by the page and the CSV) ----
export const UNKNOWN = 'unknown';
export const fmtCount = n => (n == null ? UNKNOWN : n.toLocaleString('en-GB'));
export const fmtCost = g => (g == null ? UNKNOWN : `£${g.toFixed(2)}`);
export function fmtDuration(ms) {
  if (ms == null) return UNKNOWN;
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}
export const fmtShare = p => (p == null ? UNKNOWN : `${p}%`);
// "5,000 (2 unknown)" for a total that leaves jobs out.
export const withUnknown = (text, unknown) => (unknown && text !== UNKNOWN ? `${text} (${unknown} unknown)` : text);

// ---- CSV ----
const CSV_CELL = { id: r => r.fullId || r.id, ref: r => refText(r) || null, cause: r => r.causeLabel || r.cause, startedAt: r => (r.startedAt == null ? null : new Date(r.startedAt).toISOString()),
  durationMs: r => (r.durationMs == null ? null : Math.round(r.durationMs / 1000)), costGbp: r => (r.costGbp == null ? null : r.costGbp.toFixed(2)) };
const CSV_HEAD = { durationMs: 'Duration (s)', costGbp: 'Cost (GBP)' };
// A cell that a spreadsheet would read as a formula is prefixed so it stays text.
export function csvCell(v) {
  let s = v == null ? UNKNOWN : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(rows, columns = COLUMN_KEYS) {
  const cols = COLUMNS.filter(c => columns.includes(c.key));
  const line = cells => cells.map(csvCell).join(',');
  return `${[line(cols.map(c => CSV_HEAD[c.key] || c.label)), ...rows.map(r => line(cols.map(c => (CSV_CELL[c.key] ? CSV_CELL[c.key](r) : r[c.key]))))].join('\r\n')}\r\n`;
}

// The other jobs on the same pull request or issue, oldest first, for the side panel.
export function sameRef(rows, row) {
  const key = refKey(row);
  if (!key) return [];
  return rows.filter(r => refKey(r) === key).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

// The jobs the page works on: the view's newest and older job rows, deduplicated by full id.
export function allJobRows(view) {
  const seen = new Set();
  return buildRows([...(view.jobs || []), ...(view.olderJobs || [])].filter(j => !seen.has(j.fullId) && seen.add(j.fullId)));
}
