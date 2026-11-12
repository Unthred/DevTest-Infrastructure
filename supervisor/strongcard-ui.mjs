// Issue #1158: the approve control of a strong inbox card. It shows the exact head the action will act on and asks for the pull request number
// to be typed; the form posts the typed number, that head and the tier to the same /inbox route, which re-checks all three. HTML only.
import { isStrongAction } from './strongtier.mjs';

export const isStrongCard = c => c.kind === 'action' && isStrongAction(c.action);

// esc: the page's HTML escaper. Without a readable head there is no Approve control at all, because nothing could be confirmed.
export function strongApproveHtml(esc, c) {
  if (!c.head) return `<div class="sub">The head of pull request ${esc(c.target)} cannot be read (it may be closed), so this cannot be approved. Reject it.</div>`;
  return `<div class="sub">Acts on pull request ${esc(c.target)} at head <code>${esc(c.head)}</code>. Refused if the head has moved by the time you approve.</div>`
    + `<form method="post" action="/inbox" class="inbox-form inbox-strong"><input type="hidden" name="id" value="${esc(c.id)}"><input type="hidden" name="decision" value="approve">`
    + `<input type="hidden" name="tier" value="strong"><input type="hidden" name="head" value="${esc(c.head)}">`
    + `<label class="sub">Type ${esc(c.target)} to confirm <input type="text" name="confirm" inputmode="numeric" autocomplete="off" required pattern="${esc(c.target)}" size="8"></label> `
    + '<button class="btn inbox-approve" type="submit">Approve</button></form>';
}
