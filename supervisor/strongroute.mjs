// Issue #1158: what POST /inbox reads from the form when the homeowner approves. The route calls this once; decide() then checks it.
import { liveHeadOf } from './strongtier.mjs';

export const viewOpts = (root, source, now) => ({ root, config: source(), now, configError: source.invalid, timeline: false, allTime: false });

// The typed number, the head the card showed, the tier the form claims (a lower one is refused by decide()) and the head the dashboard holds now.
// `view()` builds the current view; it is only called when the form names a head. Rejecting and undoing carry no confirmation.
export async function confirmOf(form, id, decision, view) {
  if (decision !== 'approve') return null;
  const confirm = { typed: form.get('confirm') ?? '', shownHead: form.get('head') ?? '', ...(form.has('tier') ? { tier: form.get('tier') } : {}) };
  if (confirm.shownHead) confirm.liveHead = liveHeadOf((await view()).view, id);
  return confirm;
}

// POST /inbox: undo, or decide with the confirmation the form carried. `decide`/`undo` are inbox.mjs's own.
export async function decideFor(inboxStore, dir, { id, decision, form, t }, view) {
  if (decision === 'undo') return inboxStore.undo(dir, id, t);
  return inboxStore.decide(dir, id, decision, t, await confirmOf(form, id, decision, view));
}
