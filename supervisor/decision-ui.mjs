const form = (esc, c) => `<form method="post" action="/decision" class="decision-form">`
  + `<input type="hidden" name="action" value="${esc(c.action)}">`
  + `<input type="hidden" name="target" value="${esc(c.target)}">`
  + `<label>Why <input name="reason" maxlength="300" required></label>`
  + `<button class="btn" type="submit">${esc(c.label)}</button></form>`;

export function decisionControls(item, esc) {
  if (item.decisionControls?.error) return `<div class="sub" role="alert">${esc(item.decisionControls.error)}</div>`;
  const controls = item.decisionControls?.controls || [];
  return controls.length ? `<div class="acts">${controls.map(c => form(esc, c)).join('')}</div>` : '';
}
