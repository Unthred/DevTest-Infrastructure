// Issue #1156: the HTML of one decision card. Pure. Each control is its own form posting to /decision; the page's access proof is added by
// withProof like every other form. A control carries the card id and the action name only: the target is taken from the card on the server.
// Issue #1185: a form also carries `back`, the anchor of the card it sits in, so without script the post returns to the same card; the script
// (dashui/decision-ui.mjs) sends the same form in the background. A control whose click is recorded and waiting for the tick shows as working.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);

const control = (id, c, anchor) => `<form method="post" action="/decision" class="decision-form"><input type="hidden" name="card" value="${esc(id)}">`
  + `<input type="hidden" name="control" value="${esc(c.action)}"><input type="hidden" name="back" value="${esc(anchor)}">`
  + `<button class="btn decision-control" type="submit" title="${esc(c.does)}">${esc(c.label)}</button></form>`;

const status = (pending, controls) => {
  const waiting = controls.filter(c => pending.includes(c.action));
  const text = waiting.length ? `Working: ${waiting.map(c => c.label).join(', ')} recorded. Foreman applies it on the next pass.` : '';
  const state = waiting.length ? 'working' : 'idle';
  return `<div class="sub decision-status" role="status" aria-live="polite" data-state="${state}"${text ? '' : ' hidden'}>${esc(text)}</div>`;
};

// item: a Needs you item with its `card`; `decision` is its by-hand next step text; `anchor` is the id of the element the card sits in.
export function decisionHtml(item, anchor = '') {
  const card = item.card;
  if (!card) return `<div class="sub">Decision: ${esc(item.decision)}</div>`;
  if (card.error) return `<div class="decision-card decision-error" role="alert"><div class="sub">Error: ${esc(card.error)}</div></div>`;
  const pending = card.pending || [];
  const open = card.controls.filter(c => !pending.includes(c.action));
  const acts = open.length ? `<div class="acts">${open.map(c => control(item.id, c, anchor)).join('')}</div>` : '';
  return `<div class="decision-card" data-decision="${esc(card.type)}"><div class="sub decision-reason">Why: ${esc(card.reason)}</div>`
    + `<div class="sub decision-clears">${esc(card.clears[0].toUpperCase() + card.clears.slice(1))}.</div>`
    + (item.decision ? `<div class="sub">Decision: ${esc(item.decision)}</div>` : '')
    + acts + status(pending, card.controls) + (card.later ? `<div class="sub decision-later">${esc(card.later)}</div>` : '') + '</div>';
}
