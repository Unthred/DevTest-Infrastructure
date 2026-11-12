import { highlightInboxText, matchesInboxSearch } from '../foreman-mcp/inbox-search.mjs';

const KINDS = ['prompt', 'issue_draft', 'action', 'host_value'];
const STATES = ['pending', 'approved', 'rejected', 'running', 'posting', 'done', 'failed', 'refused'];

const highlighted = (text, query, esc) => highlightInboxText(text, query)
  .map(part => (part.matched ? `<mark>${esc(part.text)}</mark>` : esc(part.text)))
  .join('');

export function inboxCard(card, query, { esc, tag, form }) {
  const title = highlighted(card.title || 'An inbox item that cannot be shown', query, esc);
  const why = card.why ? `<div class="sub">Why: ${highlighted(card.why, query, esc)}</div>` : '';
  const body = highlighted(card.text || '', query, esc);
  const approve = card.state === 'pending' && !card.broken ? form(card.id, 'approve', 'Approve', 'inbox-approve') : '';
  const reject = card.state === 'pending' ? form(card.id, 'reject', 'Reject', 'inbox-reject') : '';
  return `<article class="inbox-item" id="att-inbox-${esc(card.id)}" data-inbox="${esc(card.id)}">
<h3 class="inbox-title">${title}</h3><div class="sub">${esc(card.kind || 'unknown')} · ${esc(card.state || 'unknown')} ${tag(card.id, card.kind)}</div>${why}
<pre class="inbox-text">${body}</pre><div class="sub">Content hash ${esc(card.hash || '')}</div>
<div class="acts">${approve}${reject}</div><div class="inbox-err" role="alert" hidden></div><span class="inbox-outcome" hidden></span></article>`;
}

const option = (value, selected, esc, label = value) => {
  return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
};

function filters(query) {
  const search = String(query.get('search') || '').slice(0, 200);
  const kind = KINDS.includes(query.get('kind')) ? query.get('kind') : '';
  const state = STATES.includes(query.get('state')) ? query.get('state') : '';
  return { search, kind, state };
}

function searchForm(current, esc) {
  const kinds = KINDS.map(kind => option(kind, current.kind, esc)).join('');
  const states = STATES.map(state => option(state, current.state, esc)).join('');
  return `<form class="inbox-search" method="get" action="/inbox"><label>Search
<input type="search" name="search" value="${esc(current.search)}" maxlength="200" autocomplete="off" placeholder="Search Inbox"></label>
<label>Kind <select name="kind">${option('', current.kind, esc, 'Any kind')}${kinds}</select></label>
<label>State <select name="state">${option('', current.state, esc, 'Any state')}${states}</select></label>
<button class="btn" type="submit">Search</button></form>`;
}

export function inboxSummary(view, esc) {
  const count = (view.panels.inbox || []).length;
  if (!count) return '<p class="sub">No overseer proposals are waiting.</p>';
  const plural = count === 1 ? '' : 's';
  return `<p><a href="/inbox">${esc(count)} overseer proposal${plural} waiting</a></p><p class="sub">Search every word across titles, proposal text and linked work.</p>`;
}

export function inboxPage(view, query, { card, decided, esc, form, grid, tag }) {
  const current = filters(query);
  const inbox = view.panels.inboxSearch || view.panels.inbox || [];
  const visible = inbox.filter(item => {
    return (current.state || item.state !== 'refused')
      && (!current.kind || item.kind === current.kind)
      && (!current.state || item.state === current.state)
      && matchesInboxSearch(item, current.search);
  });
  const result = visible.length
    ? `<p class="sub" role="status">${visible.length} of ${inbox.length} proposals</p>${visible.map(item => inboxCard(item, current.search, { esc, tag, form })).join('')}`
    : `<div class="empty"><b>No Inbox items match</b><span>${current.search ? `No items match “${esc(current.search)}”.` : 'No overseer proposals are waiting.'}</span></div>`;
  const body = searchForm(current, esc) + result + decided(view);
  return {
    title: 'Inbox',
    body: grid('inbox', card({ id: 'inbox', title: 'Inbox', span: 12, movable: false, body })),
    crumbs: [['/', 'Overview'], [null, 'Inbox']],
  };
}
