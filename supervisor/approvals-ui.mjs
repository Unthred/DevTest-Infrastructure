// The "Waiting for approval" dropdown on the Now tab (issue #1101): HTML only, from the rows supervisor/approvals.mjs returns. The forms are the
// Inbox's own (post to /inbox with the page's access proof), so the existing submit handler and the existing approve and reject path decide.
import { approveAllIds, approvalsOfView } from './approvals.mjs';

const form = (esc, id, decision, label) => `<form method="post" action="/inbox" class="inbox-form"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="decision" value="${decision}"><button class="btn inbox-${decision}" type="submit">${label}</button></form>`;

const row = (esc, r, age) => `<li class="inbox-item approval-row" data-inbox="${esc(r.id)}" data-tier="${r.tier}"><div class="t">${esc(r.title)}</div>`
  + `<div class="sub">${esc(r.kindLabel)} · ${esc(age)}</div>`
  + (r.why ? `<details><summary>Why</summary><div class="sub">${esc(r.why)}</div></details>` : '')
  + `<div class="acts">${r.tier === 'click' && r.canApprove ? form(esc, r.id, 'approve', 'Approve') : ''}${r.tier === 'strong' ? '<span class="sub">Needs the typed pull request number; decide it on its pull request.</span>' : form(esc, r.id, 'reject', 'Reject')}</div>`
  + '<span class="inbox-outcome" hidden></span><div class="inbox-err" role="alert" hidden></div></li>';

// rows: from pendingApprovals(); ago(ms): the dashboard's "12 min ago" text; esc: its HTML escaper.
export function approvalsDropdown({ rows, esc, ago }) {
  const n = rows.length, all = approveAllIds(rows).length;
  const body = n ? `<ul class="panel-list">${rows.map(r => row(esc, r, ago(r.since))).join('')}</ul>` : '<p class="sub">Nothing waiting for you</p>';
  const approveAll = all ? `<button type="button" class="btn inbox-approve" data-approve-all>Approve all (${all})</button>` : '';
  return `<details class="approvals" data-approvals><summary class="btn">Waiting for approval <span class="badge" data-approvals-count>${n}</span></summary><div class="approvals-panel">${approveAll}${body}</div></details>`;
}

// The Now card body: the dropdown above the existing Now panel. esc and ago are the dashboard's own (ago takes a time and "now").
export const approvals = (view, nowHtml, esc, ago) => approvalsDropdown({ rows: approvalsOfView(view), esc, ago: ms => ago(ms, view.generatedAt) }) + nowHtml;
