// The Approve/Reject card of one inbox item (issue #124), moved out of dashrender.mjs for issue #1158 so the strong tier's number-and-head form
// could be added without growing that file. The item's own text is shown in full (escaped), so the click is informed. HTML only.
import { isStrongCard, strongApproveHtml } from './strongcard-ui.mjs';

const form = (esc, id, decision, label, cls) => `<form method="post" action="/inbox" class="inbox-form"><input type="hidden" name="id" value="${esc(id)}">`
  + `<input type="hidden" name="decision" value="${decision}"><button class="btn ${cls}" type="submit">${label}</button></form>`;

// A strong card (merge, approve a decision, review verdict) has no plain Approve: it asks for the pull request number on the head it shows.
const approveControl = (esc, c) => (isStrongCard(c) ? strongApproveHtml(esc, c) : form(esc, c.id, 'approve', 'Approve', 'inbox-approve'));

export const inboxBlock = (esc, c) => `<div class="inbox-item" data-inbox="${esc(c.id)}">${c.why ? `<div class="sub">Why: ${esc(c.why)}</div>` : ''}`
  + `<pre class="inbox-text">${esc(c.text || '')}</pre><div class="sub">Content hash ${esc(c.hash || '')}</div>`
  + `<div class="acts">${c.broken ? '' : approveControl(esc, c)}${form(esc, c.id, 'reject', 'Reject', 'inbox-reject')}</div>`
  + '<div class="inbox-err" role="alert" hidden></div></div>';
