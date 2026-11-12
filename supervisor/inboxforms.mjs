// Issue #1154: the homeowner's forms on an Inbox Needs you line: resolve a failed item (done another way, drop) or keep a changed setting.
// They post to the same /inbox write route as Approve and Reject, so the access proof, origin and cooldown checks all apply.
// The ids are 32 hex characters taken from Foreman's own status files, so they need no escaping.
const form = (id, decision, label, placeholder) => `<form method="post" action="/inbox" class="inbox-form"><input type="hidden" name="id" value="${id}"><input type="hidden" name="decision" value="${decision}"><input type="text" name="note" maxlength="300" required placeholder="${placeholder}" aria-label="${label}: note"><button class="btn" type="submit">${label}</button></form>`;

const FORMS = {
  failure: id => `${form(id, 'done_elsewhere', 'Done another way', 'what did it')}${form(id, 'drop', 'Drop', 'why')}`,
  setting: id => form(id, 'keep_setting', 'Keep the new value', 'why'),
};

// The tag the Needs you line already shows (`tag(id, kind)` from the renderer) plus the resolve forms when the line can be resolved.
export function needsInboxTag(a, tag) {
  const forms = FORMS[a.resolvable];
  return `${tag(a.inboxId, a.inboxKind)}${forms && /^[a-f0-9]{32}$/.test(a.inboxId) ? `<div class="acts">${forms(a.inboxId)}</div>` : ''}`;
}
