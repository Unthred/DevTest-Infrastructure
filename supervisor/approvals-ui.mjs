// The "Waiting for approval" dropdown on the Now tab (issue #1101): HTML only, from the rows supervisor/approvals.mjs returns. The forms are the
// Inbox's own (post to /inbox with the page's access proof), so the existing submit handler and the existing approve and reject path decide.
import { approveAllIds } from './approvals.mjs';
export { decisionHtml } from './decisioncard-ui.mjs';
import { decisionHtml } from './decisioncard-ui.mjs';

const FORM_TAIL = '</button></form>';
const form = (esc, id, decision, label) => `<form method="post" action="/inbox" class="inbox-form"><input type="hidden" name="id" value="${esc(id)}">`
  + `<input type="hidden" name="decision" value="${decision}"><button class="btn inbox-${decision}" type="submit">${label}${FORM_TAIL}`;

const strongNote = (esc, r) => `<span class="sub">Needs the typed pull request number: <a href="#att-inbox-${esc(r.id)}">decide it on its card in Needs you</a>.</span>`;
// Issue #1156: a decision row shows the card (reason, clear condition, its routine controls); the link is context only.
const decideNote = (esc, r) => {
  const link = r.link ? ` <a href="${esc(r.link)}" rel="noopener">Open it</a>` : '';
  return `${decisionHtml({ id: r.id, card: r.card, decision: r.options })}${link}`;
};
const buttons = (esc, r) => {
  if (r.tier === 'decision') return decideNote(esc, r);
  if (r.tier === 'strong') return strongNote(esc, r);
  return (r.canApprove ? form(esc, r.id, 'approve', 'Approve') : '') + form(esc, r.id, 'reject', 'Reject');
};
const whyBlock = (esc, r) => {
  if (r.tier === 'decision') return '';
  if (!r.why && !r.options) return '';
  const why = r.why ? `<div class="sub">${esc(r.why)}</div>` : '';
  const options = r.options ? `<div class="sub">Options: ${esc(r.options)}</div>` : '';
  return `<details><summary>Why</summary>${why}${options}</details>`;
};

const row = (esc, r, age) => `<li class="inbox-item approval-row" data-inbox="${esc(r.id)}" data-tier="${r.tier}"><div class="t">${esc(r.title)}</div>`
  + `<div class="sub">${esc(r.kindLabel)}${age ? ` · ${esc(age)}` : ''}</div>`
  + whyBlock(esc, r)
  + `<div class="acts">${buttons(esc, r)}</div>`
  + '<span class="inbox-outcome" hidden></span><div class="inbox-err" role="alert" hidden></div></li>';

// rows: from pendingApprovals() (view.panels.approvals); ago(ms): the dashboard's "12 min ago" text; esc: its HTML escaper.
export function approvalsDropdown({ rows, esc, ago }) {
  const n = rows.length;
  const all = approveAllIds(rows).length;
  const body = n ? `<ul class="panel-list">${rows.map(r => row(esc, r, ago(r.since))).join('')}</ul>` : '<p class="sub">Nothing waiting for you</p>';
  const approveAll = all ? `<button type="button" class="btn inbox-approve" data-approve-all>Approve all (${all})</button>` : '';
  const badge = `<span class="badge" data-approvals-count>${n}</span>`;
  return `<details class="approvals" data-approvals><summary class="btn">Waiting for approval ${badge}</summary><div class="approvals-panel">${approveAll}${body}</div></details>`;
}

// The Now card body: the dropdown above the existing Now panel. esc and ago are the dashboard's own (ago takes a time and "now").
export const approvals = (view, nowHtml, esc, ago) => approvalsDropdown({
  rows: view.panels.approvals || [],
  esc,
  ago: ms => (Number.isFinite(ms) ? ago(ms, view.generatedAt) : ''),
}) + nowHtml;
