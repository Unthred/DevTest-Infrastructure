// Issue #1156: the HTML of one decision card. Pure. Each control is its own form posting to /decision; the page's access proof is added by
// withProof like every other form. A control carries the card id and the action name only: the target is taken from the card on the server.
// Issue #1185: a form also carries `back`, the anchor of the card it sits in, so without script the post returns to the same card; the script
// (dashui/decision-ui.mjs) sends the same form in the background. A control whose click is recorded and waiting for the tick shows as working.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);

// Issue #1337: close_superseded takes one input, the superseding numbers.
const input = c => (c.input === 'superseded_by'
  ? '<input class="decision-input" type="text" name="superseded_by" required maxlength="60" placeholder="superseded by, e.g. 12, 13" aria-label="Superseded by (issue or pull request numbers)">'
  : '');
const control = (id, c, anchor) => `<form method="post" action="/decision" class="decision-form"><input type="hidden" name="card" value="${esc(id)}">`
  + `<input type="hidden" name="control" value="${esc(c.action)}"><input type="hidden" name="back" value="${esc(anchor)}">${input(c)}`
  + `<button class="btn decision-control" type="submit" title="${esc(c.does)}">${esc(c.label)}</button></form>`;

const status = (pending, controls) => {
  const waiting = controls.filter(c => pending.includes(c.action));
  const text = waiting.length ? `Working: ${waiting.map(c => c.label).join(', ')} recorded. Foreman applies it on the next pass.` : '';
  const state = waiting.length ? 'working' : 'idle';
  return `<div class="sub decision-status" role="status" aria-live="polite" data-state="${state}"${text ? '' : ' hidden'}>${esc(text)}</div>`;
};

// Issue #1306: the control of the closed-noreason item is a text box and a button, not a card control. It sends the named command
// work_item.close_reason for every issue the item lists (dashui/close-reason-ui.mjs); the page's access proof is added by withProof.
const closeReasonForm = item => `<form method="post" action="/api/v1/commands/work_item.close_reason" class="close-reason-form" data-issues="${esc((item.issues || []).join(','))}">`
  + '<label class="sub">Why were these dropped? <textarea name="reason" rows="2" maxlength="500"></textarea></label> '
  + '<button class="btn close-reason-button" type="submit">Record reason</button>'
  + '<div class="sub close-reason-status" role="status" aria-live="polite" hidden></div></form>';

// Issue #1368: the control of the upgrade-blocked item is one button that sends the named command upgrade.retry_install
// (dashui/retry-install-ui.mjs); the page's access proof is added by withProof.
const retryInstallForm = '<form method="post" action="/api/v1/commands/upgrade.retry_install" class="retry-install-form">'
  + '<button class="btn retry-install-button" type="submit" title="Makes the next install skip its wait and starts one more attempt of the refused commit.">Retry install now</button>'
  + '<div class="sub retry-install-status" role="status" aria-live="polite" hidden></div></form>';

// item: a Needs you item with its `card`; `decision` is its by-hand next step text; `anchor` is the id of the element the card sits in.
export function decisionHtml(item, anchor = '') {
  const card = item.card;
  if (!card) return `<div class="sub">Decision: ${esc(item.decision)}</div>`;
  if (card.error) return `<div class="decision-card decision-error" role="alert"><div class="sub">Error: ${esc(card.error)}</div></div>`;
  const pending = card.pending || [];
  const open = card.controls.filter(c => !pending.includes(c.action));
  const form = card.type === 'closed-noreason' && item.issues?.length ? closeReasonForm(item) : '';
  const retry = card.type === 'upgrade-blocked' ? retryInstallForm : '';
  const acts = open.length ? `<div class="acts">${open.map(c => control(item.id, c, anchor)).join('')}</div>` : '';
  return `<div class="decision-card" data-decision="${esc(card.type)}"><div class="sub decision-reason">Why: ${esc(card.reason)}</div>`
    + `<div class="sub decision-clears">${esc(card.clears[0].toUpperCase() + card.clears.slice(1))}.</div>`
    + (item.decision ? `<div class="sub">Decision: ${esc(item.decision)}</div>` : '')
    + form + retry + acts + status(pending, card.controls) + (card.later ? `<div class="sub decision-later">${esc(card.later)}</div>` : '') + '</div>';
}
