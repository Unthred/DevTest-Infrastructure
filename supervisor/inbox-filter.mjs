// Inbox quick filters (issue #1217): the state and kind buttons, their counts and the filtering, as pure functions of the records.
// The page (inbox-page.mjs) renders what this returns; the buttons, the State and Kind dropdowns and the URL all carry the same ids.
import { matchesInboxSearch } from '../foreman-mcp/inbox-search.mjs';

export const STATE_BUTTONS = [
  { id: 'waiting', label: 'Waiting for approval', states: ['pending'] },
  { id: 'running', label: 'Running', states: ['approved', 'running', 'posting'] },
  { id: 'done', label: 'Done', states: ['done'] },
  { id: 'failed', label: 'Failed', states: ['failed'] },
  { id: 'refused', label: 'Refused or rejected', states: ['refused', 'rejected'] },
];
export const ALL = { id: 'all', label: 'All' };
export const KIND_BUTTONS = [
  { id: 'prompt', label: 'Prompt' },
  { id: 'issue_draft', label: 'Issue draft' },
  { id: 'action', label: 'Action' },
  { id: 'control', label: 'Control', kinds: ['control', 'host_value'] },
  { id: 'decision', label: 'Decision' },
];

const groupOf = state => STATE_BUTTONS.find(b => b.states.includes(state))?.id || null;
const groupIds = new Set([ALL.id, ...STATE_BUTTONS.map(b => b.id)]);
const kindGroupOf = kind => KIND_BUTTONS.find(b => (b.kinds || [b.id]).includes(kind))?.id || null;
const kindIds = new Set(KIND_BUTTONS.map(b => b.id));

// Older links used the raw state (?state=pending); they keep working and select the button that holds that state.
const stateParam = raw => (groupIds.has(raw) ? raw : groupOf(raw) || '');

export function countButtons(records) {
  const states = { all: records.length };
  for (const b of STATE_BUTTONS) states[b.id] = 0;
  const kinds = Object.fromEntries(KIND_BUTTONS.map(b => [b.id, 0]));
  for (const r of records) {
    const group = groupOf(r.state);
    if (group) states[group]++;
    const kindGroup = kindGroupOf(r.kind);
    if (kindGroup) kinds[kindGroup]++;
  }
  return { states, kinds };
}

// The filters in force. With no state in the address the view is Waiting for approval when anything waits, otherwise All.
export function parseFilters(query, counts) {
  const asked = stateParam(query.get('state'));
  const state = asked || (counts.states.waiting > 0 ? 'waiting' : 'all');
  const kind = kindIds.has(query.get('kind')) ? query.get('kind') : '';
  const search = String(query.get('search') || '').slice(0, 200);
  return { state, kind, search };
}

export function applyFilters(records, { state, kind, search }) {
  const group = STATE_BUTTONS.find(b => b.id === state);
  return records.filter(r => (!group || group.states.includes(r.state))
    && (!kind || kindGroupOf(r.kind) === kind)
    && matchesInboxSearch(r, search));
}

export const filtersOn = f => f.state !== 'all' || !!f.kind || !!f.search;

// Words for the empty-result message, e.g. ["Waiting for approval", "kind Prompt", "search “x”"].
export function describeFilters(f) {
  const parts = [];
  if (f.state !== 'all') parts.push(STATE_BUTTONS.find(b => b.id === f.state).label);
  if (f.kind) parts.push(`kind ${KIND_BUTTONS.find(b => b.id === f.kind).label}`);
  if (f.search) parts.push(`search “${f.search}”`);
  return parts;
}

// The address a button leads to. Choosing the state already on goes back to All; choosing the kind already on turns it off.
export function chipQuery(f, change) {
  const next = { ...f, ...change };
  if (change.state && change.state === f.state && change.state !== 'all') next.state = 'all';
  if (change.kind && change.kind === f.kind) next.kind = '';
  const q = new URLSearchParams({ state: next.state });
  if (next.kind) q.set('kind', next.kind);
  if (next.search) q.set('search', next.search);
  return `/inbox?${q}`;
}
