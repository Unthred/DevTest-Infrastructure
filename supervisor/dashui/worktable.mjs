// Issue #1224: the pure logic of the Work page's Table and Board views. No DOM, no I/O. The server builds the rows (workrows.mjs) and the
// browser (workview-ui.mjs) runs everything here on them, so the tests exercise exactly the code the page runs.
//
// A row is plain JSON: { key, ref, kind, title, agent, role, state, rank, rankOf, waitsOn, waitsText, holdReason, holdSince, estStart,
// estText, reviewRounds, fixRounds, rebaseRounds, checks, verdict, labels, tokens, cost, age, lastActivity, url }.
import { compareValues } from './logic.mjs';
import { foldPunctuation } from './lists.mjs';

export const STATES = [
  ['planned', 'Planned'], ['running', 'Running'], ['held', 'Held'],
  ['waiting-you', 'Waiting for you'], ['waiting-review', 'Waiting for review'], ['done', 'Done today']
];
export const STATE_LABEL = Object.fromEntries(STATES);

// The Board has its own six columns; each state lands in exactly one of them.
export const BOARD_COLUMNS = [
  ['held', 'Held', 'held'], ['planned', 'Planned', 'planned'], ['running', 'Running', 'running'],
  ['review', 'In review', 'waiting-review'], ['you', 'Waiting for you', 'waiting-you'], ['merged', 'Merged today', 'done']
];

// type: num sorts numerically, time is a millisecond value, text sorts as text.
export const COLUMNS = [
  { key: 'ref', label: 'Ref', type: 'num' }, { key: 'title', label: 'Title', type: 'text' }, { key: 'kind', label: 'Kind', type: 'text' },
  { key: 'agent', label: 'Agent', type: 'text' }, { key: 'role', label: 'Role', type: 'text' }, { key: 'state', label: 'State', type: 'text' },
  { key: 'rank', label: 'Rank', type: 'num' }, { key: 'waitsOn', label: 'Waits on', type: 'text' }, { key: 'holdReason', label: 'Hold reason', type: 'text' },
  { key: 'estStart', label: 'Estimated start', type: 'time' }, { key: 'reviewRounds', label: 'Review rounds', type: 'num' },
  { key: 'fixRounds', label: 'Fix rounds', type: 'num' }, { key: 'rebaseRounds', label: 'Rebase rounds', type: 'num' },
  { key: 'checks', label: 'Checks', type: 'text' }, { key: 'verdict', label: 'Verdict', type: 'text' }, { key: 'labels', label: 'Labels', type: 'text' },
  { key: 'tokens', label: 'Tokens spent', type: 'num' }, { key: 'cost', label: 'Cost', type: 'num' }, { key: 'age', label: 'Age', type: 'num' },
  { key: 'lastActivity', label: 'Last activity', type: 'time' }
];
export const COLUMN_KEYS = COLUMNS.map(c => c.key);
export const GROUPS = [['', 'No grouping'], ['agent', 'Agent'], ['state', 'State'], ['holdReason', 'Hold reason']];
export const VIEWS = [['cards', 'Queue cards'], ['table', 'Table'], ['board', 'Board']];
export const MAX_SAVED_VIEWS = 20;
export const MAX_NAME = 40;

const NONE = '(none)';
const refText = r => `${r.kind === 'pr' ? 'PR ' : '#'}${r.ref}`;
const list = a => (Array.isArray(a) ? a : []);

// The value a column sorts and exports by.
export function sortValue(row, key) {
  switch (key) {
    case 'ref': return row.ref;
    case 'kind': return row.kind === 'pr' ? 'PR' : 'Issue';
    case 'state': return STATES.findIndex(([k]) => k === row.state);
    case 'waitsOn': return [...list(row.waitsOn).map(n => `#${n}`), ...list(row.waitsText)].join(', ') || null;
    case 'labels': return list(row.labels).join(', ') || null;
    default: return row[key] ?? null;
  }
}
// What the cell shows. `ctx.time` formats a millisecond value (the browser passes the viewer's zone), `ctx.duration` an age.
export function cellText(row, key, ctx = {}) {
  const v = sortValue(row, key);
  if (v === null || v === undefined || v === '') return '';
  switch (key) {
    case 'ref': return refText(row);
    case 'state': return STATE_LABEL[row.state] || '';
    case 'rank': return row.rankOf ? `${row.rank} of ${row.rankOf}` : String(row.rank);
    case 'estStart': return ctx.time ? ctx.time(v) : String(v);
    case 'lastActivity': return ctx.time ? ctx.time(v) : String(v);
    case 'age': return ctx.duration ? ctx.duration(v) : String(v);
    case 'cost': return row.costText ?? String(v);
    default: return String(v);
  }
}

// ---- sort
export function sortRows(rows, key = 'rank', dir = 'asc') {
  const k = COLUMN_KEYS.includes(key) ? key : 'rank', d = dir === 'desc' ? 'desc' : 'asc';
  return rows.map((r, i) => [r, i]).sort((a, b) => compareValues(sortValue(a[0], k), sortValue(b[0], k), d) || a[1] - b[1]).map(x => x[0]);
}

// ---- filters: buttons for agent, state and label (several of one kind OR together, the kinds AND together) plus the search box
export const emptyFilters = () => ({ agent: [], state: [], label: [], q: '' });
const matchesQuery = (row, q) => {
  const words = foldPunctuation(String(q || '').trim().toLowerCase()).split(/\s+/).filter(Boolean).map(w => w.replace(/^#(?=\d)/, ''));
  if (!words.length) return true;
  const hay = foldPunctuation(`${row.ref} ${row.title} ${row.agent || ''} ${row.holdReason || ''} ${list(row.labels).join(' ')} ${refText(row)}`.toLowerCase());
  return words.every(w => hay.includes(w));
};
const passes = (row, f, skip) => (skip === 'agent' || !f.agent.length || f.agent.includes(row.agent ?? NONE))
  && (skip === 'state' || !f.state.length || f.state.includes(row.state))
  && (skip === 'label' || !f.label.length || list(row.labels).some(l => f.label.includes(l)))
  && matchesQuery(row, f.q);
export const filterRows = (rows, f) => rows.filter(r => passes(r, f, null));

// Counts for the buttons: each kind counts the rows that pass every OTHER filter, so a button says what pressing it would show.
export function facetCounts(rows, f) {
  const out = { agent: {}, state: {}, label: {} };
  for (const r of rows.filter(x => passes(x, f, 'agent'))) { const a = r.agent ?? NONE; out.agent[a] = (out.agent[a] || 0) + 1; }
  for (const r of rows.filter(x => passes(x, f, 'state'))) out.state[r.state] = (out.state[r.state] || 0) + 1;
  for (const r of rows.filter(x => passes(x, f, 'label'))) for (const l of new Set(list(r.labels))) out.label[l] = (out.label[l] || 0) + 1;
  return out;
}
// Every value that can be a button, so a button with a zero count is still there.
export const facetValues = rows => ({
  agent: [...new Set(rows.map(r => r.agent ?? NONE))].sort((a, b) => a.localeCompare(b)),
  label: [...new Set(rows.flatMap(r => list(r.labels)))].sort((a, b) => a.localeCompare(b))
});
export const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter(x => x !== v) : [...arr, v]);

// ---- grouping: by agent, state or hold reason. Groups keep the order of the rows inside them; "(none)" is last.
export function groupRows(rows, by) {
  if (!['agent', 'state', 'holdReason'].includes(by)) return [{ key: '', label: '', rows }];
  const keyOf = r => (by === 'state' ? r.state : (r[by] ?? NONE));
  const groups = new Map();
  for (const r of rows) { const k = keyOf(r); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const stateIndex = k => STATES.findIndex(([s]) => s === k);
  const compare = (a, b) => (by === 'state' ? stateIndex(a) - stateIndex(b) : a === NONE ? 1 : b === NONE ? -1 : a.localeCompare(b));
  const order = [...groups.keys()].sort(compare);
  return order.map(k => ({ key: k, label: by === 'state' ? STATE_LABEL[k] : k, rows: groups.get(k) }));
}

// ---- Board: six columns, a card per item
export function boardColumns(rows) {
  return BOARD_COLUMNS.map(([id, label, state]) => ({ id, label, rows: rows.filter(r => r.state === state) }));
}

// ---- CSV (RFC 4180). A text cell that a spreadsheet would run as a formula gets a leading apostrophe.
const FORMULA = /^[=+\-@\t\r]/;
export function csvCell(v) {
  const text = v === null || v === undefined ? '' : String(v);
  const safe = typeof v === 'string' && FORMULA.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
export function toCsv(rows, columns = COLUMN_KEYS) {
  const cols = COLUMNS.filter(c => columns.includes(c.key));
  const value = (r, c) => {
    const v = sortValue(r, c.key);
    if (c.type === 'time' && Number.isFinite(v)) return new Date(v).toISOString();
    return c.key === 'ref' ? refText(r) : c.key === 'state' ? STATE_LABEL[r.state] : v;
  };
  return `${[cols.map(c => csvCell(c.label)).join(','), ...rows.map(r => cols.map(c => csvCell(value(r, c))).join(','))].join('\r\n')}\r\n`;
}

// ---- the state of the view (what a saved view stores) and the saved views
export const defaultState = () => ({
  view: 'cards', filters: emptyFilters(), sortKey: 'rank', sortDir: 'asc', group: '', hidden: [], widths: {}
});
const strings = (a, max = 60) => [...new Set(list(a).filter(x => typeof x === 'string').map(x => x.slice(0, 200)))].slice(0, max);
export function sanitizeState(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const f = r.filters && typeof r.filters === 'object' ? r.filters : {};
  const widths = {};
  const given = r.widths && typeof r.widths === 'object' ? r.widths : {};
  for (const [k, w] of Object.entries(given)) {
    if (COLUMN_KEYS.includes(k) && Number.isFinite(w)) widths[k] = Math.min(800, Math.max(40, Math.round(w)));
  }
  return {
    view: VIEWS.some(([k]) => k === r.view) ? r.view : 'cards',
    filters: {
      agent: strings(f.agent), state: strings(f.state).filter(s => s in STATE_LABEL), label: strings(f.label),
      q: typeof f.q === 'string' ? f.q.slice(0, 200) : ''
    },
    sortKey: COLUMN_KEYS.includes(r.sortKey) ? r.sortKey : 'rank', sortDir: r.sortDir === 'desc' ? 'desc' : 'asc',
    group: GROUPS.some(([k]) => k && k === r.group) ? r.group : '',
    hidden: strings(r.hidden).filter(k => COLUMN_KEYS.includes(k)), widths
  };
}
export const sanitizeSaved = raw => {
  const out = [];
  for (const v of list(raw)) {
    const name = typeof v?.name === 'string' ? v.name.trim().slice(0, MAX_NAME) : '';
    if (name && !out.some(o => o.name === name)) out.push({ name, state: sanitizeState(v.state) });
  }
  return out.slice(0, MAX_SAVED_VIEWS);
};
// Saving under a name that exists replaces it; a blank name saves nothing. Returns the new list.
export function saveView(saved, name, state) {
  const n = String(name || '').trim().slice(0, MAX_NAME);
  if (!n) return sanitizeSaved(saved);
  const rest = sanitizeSaved(saved).filter(v => v.name !== n);
  return sanitizeSaved([...rest, { name: n, state }]);
}
export const deleteView = (saved, name) => sanitizeSaved(saved).filter(v => v.name !== name);

// The footer: "3 of 21 items".
export const countLine = (shown, total) => (shown === total ? `${total} item${total === 1 ? '' : 's'}` : `${shown} of ${total} items`);
