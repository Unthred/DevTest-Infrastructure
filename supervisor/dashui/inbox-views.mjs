// Issue #1219: the pure logic of the Inbox view switch (Cards, Table, Compact list). No DOM and no I/O: the server renderer
// (supervisor/inbox-views.mjs) and the browser script (inbox-views-ui.mjs) both import it, so the tests run the code the page runs.
import { compareValues } from './logic.mjs';
import { sanitizeColumns } from './table-columns.mjs';

export const VIEWS = ['cards', 'table', 'compact'];
export const VIEW_LABELS = { cards: 'Cards', table: 'Table', compact: 'Compact list' };
export const COLUMNS = [
  { key: 'title', label: 'Title' }, { key: 'kind', label: 'Kind' }, { key: 'state', label: 'State' },
  { key: 'age', label: 'Age' }, { key: 'source', label: 'Source' }, { key: 'result', label: 'Result' },
];
export const COLUMN_KEYS = COLUMNS.map(c => c.key);
export const STORE_KEY = 'dash.inbox.views';

const STATE_MARK = { pending: ['◔', 'waiting'], done: ['✓', 'done'], failed: ['✗', 'failed'], rejected: ['✗', 'rejected'], refused: ['✗', 'refused'] };
export const stateMark = state => STATE_MARK[state] || ['•', String(state || 'unknown')];

// Pending items wait for the homeowner and have no result yet; every other item's stored text is its result.
export const resultOf = rec => (rec.state === 'pending' ? '' : String(rec.reason || rec.text || ''));
export const promptOf = rec => (rec.state === 'pending' ? String(rec.text || rec.why || rec.body || '') : '');
export const firstLine = text => String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';

export function sourceOf(rec) {
  if (rec.pr) return `PR #${rec.pr}`;
  if (rec.issue) return `Issue #${rec.issue}`;
  if (rec.decision) return 'Decision';
  return 'Overseer';
}

// Age in words from a creation time; the table sorts on the number, not on this text.
export function ageText(createdAt, now) {
  if (!Number.isFinite(createdAt) || !Number.isFinite(now)) return '–';
  const s = Math.max(0, Math.round((now - createdAt) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

// The one rule for which decision buttons an item has (the card and both list views call it): Approve when it has no decision, is pending and
// is not broken; Reject when it has no decision and is pending. `form(id, decision, label, cls)` returns the form HTML.
export function decisionForms(item, form) {
  const open = !item.decision && item.state === 'pending';
  return {
    approve: open && !item.broken ? form(item.id, 'approve', 'Approve', 'inbox-approve') : '',
    reject: open ? form(item.id, 'reject', 'Reject', 'inbox-reject') : '',
  };
}

// One row as both renderers and the sorter see it.
export function rowOf(rec, now) {
  const created = Number.isFinite(rec.createdAt) ? rec.createdAt : null;
  return {
    id: rec.id, reference: String(rec.reference || ''), decision: rec.decision, broken: rec.broken, title: String(rec.title || 'An inbox item that cannot be shown'), kind: String(rec.kind || 'unknown'), state: String(rec.state || 'unknown'),
    created, age: ageText(created, now), source: sourceOf(rec), result: firstLine(resultOf(rec)), full: resultOf(rec), prompt: promptOf(rec),
  };
}

const TEXT_KEYS = ['title', 'kind', 'state', 'source', 'result'];
const sortValue = (row, key) => {
  if (key === 'age') return row.created;
  return TEXT_KEYS.includes(key) && row[key] ? row[key].toLowerCase() : null;
};
// Age is older-first when descending: a larger age is an earlier creation time, so the number sorted is the creation time reversed.
export function sortRows(rows, key, dir = 'asc') {
  if (!COLUMN_KEYS.includes(key)) return rows.slice();
  const flip = key === 'age';
  const way = (dir === 'desc') !== flip ? 'desc' : 'asc';
  return rows.map((r, i) => [r, i]).sort((a, b) => compareValues(sortValue(a[0], key), sortValue(b[0], key), way) || a[1] - b[1]).map(p => p[0]);
}

// Phone default is the Compact list, desktop default is the Table (requirement 5).
export const defaultView = phone => (phone ? 'compact' : 'table');
export function sanitizePrefs(raw, { phone = false } = {}) {
  const view = VIEWS.includes(raw?.view) ? raw.view : defaultView(phone);
  return { view, ...sanitizeColumns(raw, COLUMN_KEYS) };
}
