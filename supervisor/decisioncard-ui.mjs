// Issue #1156: the HTML of one decision card. Pure. Each control is its own form posting to /decision; the page's access proof is added by
// withProof like every other form. A control carries the card id and the action name only: the target is taken from the card on the server.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);

const control = (id, c) => `<form method="post" action="/decision" class="decision-form"><input type="hidden" name="card" value="${esc(id)}">`
  + `<input type="hidden" name="control" value="${esc(c.action)}"><button class="btn decision-control" type="submit" title="${esc(c.does)}">${esc(c.label)}</button></form>`;

// item: a Needs you item with its `card`; `decision` is its by-hand next step text.
export function decisionHtml(item) {
  const card = item.card;
  if (!card) return `<div class="sub">Decision: ${esc(item.decision)}</div>`;
  if (card.error) return `<div class="decision-card decision-error" role="alert"><div class="sub">Error: ${esc(card.error)}</div></div>`;
  const acts = card.controls.length ? `<div class="acts">${card.controls.map(c => control(item.id, c)).join('')}</div>` : '';
  return `<div class="decision-card" data-decision="${esc(card.type)}"><div class="sub decision-reason">Why: ${esc(card.reason)}</div>`
    + `<div class="sub decision-clears">${esc(card.clears[0].toUpperCase() + card.clears.slice(1))}.</div>`
    + (item.decision ? `<div class="sub">Decision: ${esc(item.decision)}</div>` : '')
    + acts + (card.later ? `<div class="sub decision-later">${esc(card.later)}</div>` : '') + '</div>';
}
