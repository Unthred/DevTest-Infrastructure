import { highlightInboxText } from '../foreman-mcp/inbox-search.mjs';
import { decisionControls, inboxViews } from './inbox-views.mjs';
import { decisionForms } from './dashui/inbox-views.mjs';
import { inboxAllRecords } from '../foreman-mcp/inbox-search-records.mjs';
import { applyFilters, countButtons, describeFilters, parseFilters } from './inbox-filter.mjs';
import { chipRows, emptyResult, filterForm } from './inbox-chips.mjs';
import { runningView } from './inbox-running.mjs';
import { jobCard, runningLine } from './inbox-job-row.mjs';

const highlighted = (text, query, esc) => highlightInboxText(text, query)
  .map(part => (part.matched ? `<mark>${esc(part.text)}</mark>` : esc(part.text)))
  .join('');

// Issue #1477: the Inbox address a decision post returns to without script: the same state, kind and search. A search too long for the
// route's address check is left out, so the viewer still lands on the page.
const returnPath = ({ state, kind, search }) => {
  const q = new URLSearchParams({ state });
  if (kind) q.set('kind', kind);
  if (search && encodeURIComponent(search).length <= 150) q.set('search', search);
  return `/inbox?${q}`;
};

export function inboxCard(card, query, { esc, tag, form, returnTo = '' }) {
  const reference = card.reference ? `<span class="inbox-ref">${highlighted(card.reference, query, esc)}</span> ` : '';   // issue #1414
  const title = reference + highlighted(card.title || 'An inbox item that cannot be shown', query, esc);
  const why = card.why ? `<div class="sub">Why: ${highlighted(card.why, query, esc)}</div>` : '';
  const body = highlighted(card.text || '', query, esc);
  const { approve, reject } = decisionForms(card, form);
  const tagHtml = card.decision === true ? '' : tag(card.id, card.kind);
  const isDecision = card.decision === true;
  // Issue #1477: the card's own controls stand in place of the plain Decision text.
  const asRow = { id: card.id, card: card.card, options: card.body };
  const decisionPart = isDecision ? decisionControls(asRow, { returnTo, withText: true }) : '';
  const actions = isDecision ? '' : `<div class="acts">${approve}${reject}</div>`;
  const will = card.will ? `<div class="sub">${esc(card.will)}</div>` : '';
  return `<li class="inbox-item" id="att-inbox-${esc(card.id)}" data-inbox="${esc(card.id)}">
<h3 class="inbox-title t">${title}</h3><div class="sub">${esc(card.kind || 'unknown')} · ${esc(card.state || 'unknown')} ${tagHtml}</div>${why}${will}
<pre class="inbox-text">${body}</pre>${decisionPart}<div class="sub">${card.hash ? `Content hash ${esc(card.hash)}` : ''}</div>
${actions}<div class="inbox-err" role="alert" hidden></div><span class="inbox-outcome" hidden></span></li>`;
}

export function inboxSummary(view, esc) {
  const count = (view.panels.inbox || []).length;
  if (!count) return '<p class="sub">No overseer proposals are waiting.</p>';
  const plural = count === 1 ? '' : 's';
  return `<p><a href="/inbox">${esc(count)} overseer proposal${plural} waiting</a></p><p class="sub">Search every word across titles, proposal text and linked work.</p>`;
}

export function inboxPage(view, query, { card, decided, esc, form, grid, tag }) {
  const records = inboxAllRecords({ inbox: view.panels.inboxSearch || view.panels.inbox || [], approvals: view.panels.approvals || [] });
  const running = runningView(view.jobs, records);   // issue #1466: the Running button counts the rows its view shows
  const counts = countButtons(records);
  counts.states.running = running.rows.length;
  const current = parseFilters(query, counts);
  const visible = current.state === 'running' ? applyFilters(running.rows, { ...current, state: 'all' }) : applyFilters(records, current);
  const highlight = text => highlighted(text, current.search, esc);
  const returnTo = returnPath(current);
  const cardOf = item => (item.kind === 'job' ? jobCard(item, view.generatedAt, { esc, highlight }) : inboxCard(item, current.search, { esc, tag, form, returnTo }));
  const cardsHtml = `<ul class="panel-list">${visible.map(cardOf).join('')}</ul>`;
  const result = visible.length
    ? `<p class="sub" role="status">${visible.length} matching Inbox item${visible.length === 1 ? '' : 's'}</p>${inboxViews({ records: visible, now: view.generatedAt, esc, highlight, cardsHtml, form, returnTo })}`
    : emptyResult(describeFilters(current), esc, current.state === 'running' && !current.kind && !current.search);
  const script = '<script type="module" src="/static/inbox-filter.mjs"></script>';
  const body = runningLine(running.jobsRunning, esc) + chipRows(current, counts, esc) + filterForm(current, esc) + result + decided(view) + script;
  return {
    title: 'Inbox',
    body: grid('inbox', card({ id: 'inbox', title: 'Inbox', span: 12, movable: false, body })),
    crumbs: [['/', 'Overview'], [null, 'Inbox']],
  };
}
