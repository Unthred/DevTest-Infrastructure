import { highlightInboxText } from '../foreman-mcp/inbox-search.mjs';
import { inboxViews } from './inbox-views.mjs';
import { decisionForms } from './dashui/inbox-views.mjs';
import { inboxAllRecords } from '../foreman-mcp/inbox-search-records.mjs';
import { applyFilters, countButtons, describeFilters, parseFilters } from './inbox-filter.mjs';
import { chipRows, emptyResult, filterForm } from './inbox-chips.mjs';

const highlighted = (text, query, esc) => highlightInboxText(text, query)
  .map(part => (part.matched ? `<mark>${esc(part.text)}</mark>` : esc(part.text)))
  .join('');

export function inboxCard(card, query, { esc, tag, form }) {
  const reference = card.reference ? `<span class="inbox-ref">${highlighted(card.reference, query, esc)}</span> ` : '';   // issue #1414
  const title = reference + highlighted(card.title || 'An inbox item that cannot be shown', query, esc);
  const why = card.why ? `<div class="sub">Why: ${highlighted(card.why, query, esc)}</div>` : '';
  const body = highlighted(card.text || '', query, esc);
  const { approve, reject } = decisionForms(card, form);
  const tagHtml = card.decision === true ? '' : tag(card.id, card.kind);
  const will = card.will ? `<div class="sub">${esc(card.will)}</div>` : '';
  const options = card.decision === true && card.body ? `<div class="sub">Decision: ${highlighted(card.body, query, esc)}</div>` : '';
  return `<li class="inbox-item" id="att-inbox-${esc(card.id)}" data-inbox="${esc(card.id)}">
<h3 class="inbox-title t">${title}</h3><div class="sub">${esc(card.kind || 'unknown')} · ${esc(card.state || 'unknown')} ${tagHtml}</div>${why}${will}
<pre class="inbox-text">${body}</pre>${options}<div class="sub">${card.hash ? `Content hash ${esc(card.hash)}` : ''}</div>
<div class="acts">${approve}${reject}</div><div class="inbox-err" role="alert" hidden></div><span class="inbox-outcome" hidden></span></li>`;
}

export function inboxSummary(view, esc) {
  const count = (view.panels.inbox || []).length;
  if (!count) return '<p class="sub">No overseer proposals are waiting.</p>';
  const plural = count === 1 ? '' : 's';
  return `<p><a href="/inbox">${esc(count)} overseer proposal${plural} waiting</a></p><p class="sub">Search every word across titles, proposal text and linked work.</p>`;
}

export function inboxPage(view, query, { card, decided, esc, form, grid, tag }) {
  const records = inboxAllRecords({ inbox: view.panels.inboxSearch || view.panels.inbox || [], approvals: view.panels.approvals || [] });
  const counts = countButtons(records);
  const current = parseFilters(query, counts);
  const visible = applyFilters(records, current);
  const highlight = text => highlighted(text, current.search, esc);
  const cardsHtml = `<ul class="panel-list">${visible.map(item => inboxCard(item, current.search, { esc, tag, form })).join('')}</ul>`;
  const result = visible.length
    ? `<p class="sub" role="status">${visible.length} matching Inbox item${visible.length === 1 ? '' : 's'}</p>${inboxViews({ records: visible, now: view.generatedAt, esc, highlight, cardsHtml, form })}`
    : emptyResult(describeFilters(current), esc);
  const body = chipRows(current, counts, esc) + filterForm(current, esc) + result + decided(view) + '<script type="module" src="/static/inbox-filter.mjs"></script>';
  return {
    title: 'Inbox',
    body: grid('inbox', card({ id: 'inbox', title: 'Inbox', span: 12, movable: false, body })),
    crumbs: [['/', 'Overview'], [null, 'Inbox']],
  };
}
