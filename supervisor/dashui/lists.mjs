// Shared list logic for the Overview lists (issue: every list gets a fixed height, sorting and search). Pure: no DOM, no I/O.
// Imported by the server-side renderer (dashrender.mjs, to render the default order and the footer) and served as-is to the browser
// (lists-ui.mjs), so the tests exercise exactly the code the page runs. Designed so the Work and System pages can adopt it later:
// a page only has to render its rows through dlist() in dashrender.mjs.
import { SEVERITIES, compareValues, countText } from './logic.mjs';

// A list with fewer rows than this has no search box (it returns on the next refresh once the list grows).
export const LIST_MIN_SEARCH = 6;

// One row, as the renderer and the browser both see it: { i: original position, sev, num, name, age, text }.
//   sev  'action' | 'warning' | 'info' | 'ok' (missing sorts last)
//   num  an issue, pull request or job number (missing sorts last)
//   name a short plain label to sort by
//   age  milliseconds since the row's event (bigger = older; missing sorts last)
//   text everything the row shows, for search
export const SORT_KEYS = ['default', 'severity', 'age', 'number', 'name'];
// Direction words: asc, desc. They are what the direction button says, so the current sort is never only an arrow.
export const DIRECTION_WORDS = {
  default: ['Original order', 'Reversed'],
  severity: ['Least urgent first', 'Most urgent first'],
  age: ['Newest first', 'Oldest first'],
  number: ['Lowest first', 'Highest first'],
  name: ['A to Z', 'Z to A']
};
export const SORT_LABELS = { default: 'Default', severity: 'Severity', age: 'Age', number: 'Number', name: 'Name' };

const rank = sev => (sev in SEVERITIES ? SEVERITIES[sev].rank : null);
const keyOf = (r, key) => (key === 'severity' ? rank(r.sev) : key === 'age' ? r.age : key === 'number' ? r.num : key === 'name' ? (r.name ? String(r.name).toLowerCase() : null) : r.i);

// Stable: ties keep the original order (so "most urgent first" inside one severity is the order the planner gave).
export function sortListRows(rows, key = 'default', dir = 'asc') {
  const k = SORT_KEYS.includes(key) ? key : 'default';
  return rows.map(r => r).sort((a, b) => compareValues(keyOf(a, k), keyOf(b, k), dir === 'desc' ? 'desc' : 'asc') || a.i - b.i);
}
// Case-insensitive "contains" over what the row shows; "#41" finds number 41 as people type it. Every word must match.
// Issue #977: curly and straight quotes and apostrophes match each other, and so do the hyphen, non-breaking hyphen, en dash, em dash and minus sign.
export const foldPunctuation = s => String(s ?? '').replace(/[\u2018\u2019\u201A\u201B\u2032\u00B4`]/g, "'").replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-');
export function filterListRows(rows, query) {
  const words = foldPunctuation(String(query || '').trim().toLowerCase()).split(/\s+/).filter(Boolean).map(w => w.replace(/^#(?=\d)/, ''));
  if (!words.length) return rows.slice();
  return rows.filter(r => { const hay = foldPunctuation(`${String(r.text || '').toLowerCase()} ${r.num ?? ''}`); return words.every(w => hay.includes(w)); });
}
export function sanitizeListState(raw, { sorts = ['default'], defaultSort = { key: 'default', dir: 'asc' }, searchable = true } = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const key = sorts.includes(r.key) ? r.key : defaultSort.key;
  const dir = sorts.includes(r.key) ? (r.dir === 'desc' ? 'desc' : 'asc') : defaultSort.dir;
  const open = Array.isArray(r.open) ? r.open.filter(x => typeof x === 'string').slice(0, 200) : [];
  return { q: searchable && typeof r.q === 'string' ? r.q.slice(0, 200) : '', key, dir, top: Number.isFinite(r.top) && r.top > 0 ? Math.round(r.top) : 0, open };
}
// The view of a list for a state: the visible rows in order, plus the counts the footer and the "nothing matches" message need.
export function listView(rows, { q = '', key = 'default', dir = 'asc' } = {}) {
  const matched = filterListRows(rows, q), shown = sortListRows(matched, key, dir);
  return { order: sortListRows(rows, key, dir), shown, total: rows.length, count: shown.length, filtered: String(q).trim() !== '', none: rows.length > 0 && shown.length === 0 };
}
// "7 items · 3 action · 2 warning" or, while filtered, "2 of 7 items · 1 action".
export function footerText(rows, shownRows, noun = 'items', filtered = false) {
  const n = shownRows.length, head = filtered ? countText(n, rows.length, noun) : `${n} ${n === 1 ? noun.replace(/s$/, '') : noun}`;
  const parts = ['action', 'warning'].map(s => [s, shownRows.filter(r => r.sev === s).length]).filter(([, c]) => c > 0).map(([s, c]) => `${c} ${s}`);
  return [head, ...parts].join(' · ');
}
export const noMatchText = q => `Nothing matches “${String(q).trim().slice(0, 60)}”.`;
export const searchVisible = (total, min = LIST_MIN_SEARCH) => total >= min;
export const sortsVisible = sorts => sorts.length > 1;
