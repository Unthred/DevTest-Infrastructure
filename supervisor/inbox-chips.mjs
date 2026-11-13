// Inbox quick filter buttons and the filter form as HTML (issue #1217). The decisions are in inbox-filter.mjs.
import { ALL, KIND_BUTTONS, STATE_BUTTONS, chipQuery } from './inbox-filter.mjs';

const chip = (group, button, count, on, href, esc) => `<a class="qf${on ? ' on' : ''}" href="${esc(href)}" data-chip="${group}:${esc(button.id)}"${on ? ' aria-current="true"' : ''}>${esc(button.label)} <span class="qf-n">${count}</span></a>`;

export function chipRows(f, counts, esc) {
  const states = [...STATE_BUTTONS, ALL].map(b => chip('state', b, counts.states[b.id], f.state === b.id, chipQuery(f, { state: b.id }), esc)).join('');
  const kinds = KIND_BUTTONS.map(b => chip('kind', b, counts.kinds[b.id], f.kind === b.id, chipQuery(f, { kind: b.id }), esc)).join('');
  return `<nav class="qf-row" aria-label="Filter by state">${states}</nav><nav class="qf-row" aria-label="Filter by kind">${kinds}</nav>`;
}

const option = (value, selected, esc, label) => `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;

export function filterForm(f, esc) {
  const states = [ALL, ...STATE_BUTTONS].map(b => option(b.id, f.state, esc, b.id === 'all' ? 'Any state' : b.label)).join('');
  const kinds = option('', f.kind, esc, 'Any kind') + KIND_BUTTONS.map(b => option(b.id, f.kind, esc, b.label)).join('');
  return `<form class="inbox-search" method="get" action="/inbox"><label>Search
<input type="search" name="search" value="${esc(f.search)}" maxlength="200" autocomplete="off" placeholder="Search Inbox"></label>
<label>Kind <select name="kind">${kinds}</select></label>
<label>State <select name="state">${states}</select></label>
<button class="btn" type="submit">Search</button></form>`;
}

export function emptyResult(parts, esc) {
  if (!parts.length) return '<div class="empty"><b>No Inbox items</b><span>No overseer proposals are waiting.</span></div>';
  return `<div class="empty"><b>No Inbox items match</b><span>Filters on: ${parts.map(esc).join(', ')}.</span><a class="btn" data-clear-filters href="/inbox?state=all">Clear filters</a></div>`;
}
