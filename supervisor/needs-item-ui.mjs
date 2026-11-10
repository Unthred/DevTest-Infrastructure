export function needsItemInner(a, ui) {
  const { badge, cmdBlock, decisionControls, esc, escT, ext, inboxBlock, inboxTag, overseerBtn, refOf, watchLink } = ui;
  const title = `<div class="t">${badge('action')} ${escT(a.text)} ${refOf(a.ref)}${a.inboxId ? ` ${inboxTag(a.inboxId, a.inboxKind)}` : ''}${a.inbox ? ' <span class="inbox-outcome" hidden></span>' : ''}</div>`;
  const tried = a.tried ? `<div class="sub">Tried: ${esc(a.tried)}</div>` : '';
  const decision = `<div class="sub">Decision: ${esc(a.decision)}</div>${decisionControls(a, esc)}`;
  const causes = (a.causes || []).length > 1 ? `<details class="causes"><summary>${a.causes.length} causes</summary><ul>${a.causes.map(c => `<li>${escT(c.text)}${c.action ? ` <span class="sub">Action: ${esc(c.action)}</span>` : ''}</li>`).join('')}</ul></details>` : '';
  const links = (a.links || []).length ? `<div class="sub">${a.links.map(l => (l.url.startsWith('/') ? `<a href="${esc(l.url)}">${esc(l.text)}</a>` : ext(l.url, l.text))).join(' · ')}</div>` : '';
  const inbox = a.inbox ? inboxBlock(a.inbox) : '';
  const command = a.command ? cmdBlock(a.command) : '';
  const watch = a.watch ? `<div class="acts">${watchLink(a.watch, 'Replay transcript')}</div>` : '';
  const overseer = a.overseer ? `<div class="acts">${overseerBtn(a.overseer)}</div>` : '';
  return title + tried + decision + causes + links + inbox + command + watch + overseer;
}

export function decidedBlock(view, ui) {
  const { esc, inboxTag, outcomeSpan, undoForm } = ui;
  const list = view.panels.inboxDecided || [];
  const pending = view.panels.needsYou.some(a => a.inbox);
  if (!list.length && !pending) return '';
  const rows = list.map(c => `<li id="inbox-${esc(c.id)}" data-decided="${esc(c.id)}"><span class="inbox-title">${esc(c.title || 'Overseer proposal')}</span> ${inboxTag(c.id, c.kind)}${c.issue ? ` ${ui.issueLink(c.issue)}` : ''} ${outcomeSpan(c.decision, c.decidedAt, c.state, c)} ${undoForm(c)}</li>`).join('');
  return `<details class="inbox-decided"${list.length ? '' : ' hidden'}><summary>Decided today (<span class="inbox-decided-n">${list.length}</span>)</summary><ul class="inbox-decided-list">${rows}</ul></details>`;
}
