// Issue #1219: the pure logic of the Inbox view switch (Cards, Table, Compact list). No DOM and no I/O: the server renderer
// (supervisor/inbox-views.mjs) and the browser script (inbox-views-ui.mjs) both import it, so the tests run the code the page runs.
import { compareValues } from './logic.mjs';
import { sanitizeColumns } from './table-columns.mjs';

export const VIEWS = ['cards', 'table', 'compact'];
export const VIEW_LABELS = { cards: 'Cards', table: 'Table', compact: 'Compact list' };
// Issue #1416: the two chips lead the row, then the title (the one wide column), then the small Age and Source text, then the Result.
export const COLUMNS = [
  { key: 'kind', label: 'Kind' }, { key: 'state', label: 'State' }, { key: 'title', label: 'Title' },
  { key: 'age', label: 'Age' }, { key: 'source', label: 'Source' }, { key: 'result', label: 'Result' },
];
export const COLUMN_KEYS = COLUMNS.map(c => c.key);
export const STORE_KEY = 'dash.inbox.views';

const STATE_MARK = {
  running: ['▶', 'running'], paused: ['⏸', 'paused'], pending: ['◔', 'waiting'], done: ['✓', 'done'],
  failed: ['✗', 'failed'], rejected: ['✗', 'rejected'], refused: ['✗', 'refused'],
};
export const stateMark = state => STATE_MARK[state] || ['•', String(state || 'unknown')];

// Issue #1416: the chips use the Now card's own badge colours (.badge .sev-*); the word is always shown, colour is never the only signal.
const STATE_SEV = {
  pending: 'warning', done: 'ok', failed: 'action', rejected: 'action', refused: 'action', approved: 'info', decided: 'info', running: 'info', paused: 'warning',
};
export const stateSeverity = state => STATE_SEV[state] || 'info';
export const kindLabel = kind => { const t = String(kind || 'unknown').replace(/_/g, ' '); return t[0].toUpperCase() + t.slice(1); };
const clock = ms => (Number.isFinite(ms) ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');

// What the homeowner already decided on an item that has not been carried out yet, from what the record holds: a decision card's recorded
// clicks (card.pending, with their times in card.pendingAt) or an approved or rejected inbox item (decision and decidedAt). '' when nothing was decided.
export function decidedOf(rec) {
  const wait = ', waiting for the next pass';
  const open = Array.isArray(rec.card?.pending) ? rec.card.pending : [];
  if (open.length) {
    return open.map(action => {
      const label = (rec.card.controls || []).find(c => c.action === action)?.label || action;
      const at = clock(rec.card.pendingAt?.[action]);
      return `${label} pressed${at ? ` ${at}` : ''}${wait}`;
    }).join('; ');
  }
  const word = ['approved', 'rejected', 'pending'].includes(rec.state) ? { approve: 'Approved', reject: 'Rejected' }[rec.decision] : '';   // a finished item is not waiting
  if (!word) return '';
  const at = clock(rec.decidedAt);
  return `${word}${at ? ` ${at}` : ''}${rec.decision === 'approve' ? wait : ''}`;
}

// Pending items wait for the homeowner and have no result yet; every other item's stored text is its result.
export const resultOf = rec => (rec.state === 'pending' ? '' : String(rec.reason || rec.text || ''));
export const promptOf = rec => (rec.state === 'pending' ? String(rec.text || rec.why || rec.body || '') : '');
export const firstLine = text => String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';

export function sourceOf(rec) {
  if (rec.pr) return `PR #${rec.pr}`;
  if (rec.issue) return `Issue #${rec.issue}`;
  if (rec.kind === 'job') return 'Job';
  if (rec.decision === true) return 'Decision';   // a decision card; a string is the homeowner's answer on an inbox item (issue #1416)
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
    id: rec.id, reference: String(rec.reference || ''), decision: rec.decision, broken: rec.broken, title: String(rec.title || 'An inbox item that cannot be shown'), kind: String(rec.kind || 'unknown'), state: String(rec.state || 'unknown'), decided: decidedOf(rec),
    created, age: ageText(created, now), source: sourceOf(rec), job: rec.kind === 'job' ? { ...rec.job, elapsed: ageText(created, now) } : null,
    result: firstLine(resultOf(rec)), full: resultOf(rec), prompt: promptOf(rec),
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
