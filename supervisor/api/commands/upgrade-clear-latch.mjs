// Issue #1290: upgrade.clear_latch, the homeowner clears the upgrade latch after understanding why it was set.
// The command applies nothing itself: it records an approved `clear_latch` action through the helper from issue #1280 and wakes the tick. The tick
// keeps its own refusals (no latch set, an install running), so the reply outcome is accepted and what the tick did is read from the Inbox item.
import { recordApprovedAction } from '../approved-action.mjs';
import { allStatuses } from '../../inbox.mjs';
import { stateName } from '../models/inbox.mjs';

export const LATCH_TARGET = 'latch';

const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const refusalCodeOf = reason => (/already queued/.test(reason) ? 'already_queued' : 'not_recorded');

const TARGET = {
  kind: 'upgrade', key: LATCH_TARGET, label: 'Upgrade latch', title: null, source: null, project: null, url: null,
};
const conditionOf = id => {
  const state = stateName(allStatuses(id.dir).find(status => status.id === id.id)?.state);
  return { state, attention: 'none', reason_code: null, reason_text: null, since: null };
};

function run(input, context) {
  const dir = context.inboxDir;
  if (!dir) return refusal('inbox_not_configured', 'The inbox is not configured.');
  const reason = String(context.reason ?? '').trim();
  const recorded = recordApprovedAction({
    inboxDir: dir, action: 'clear_latch', target: LATCH_TARGET, reason, title: 'Clear the upgrade latch', now: context.now,
  });
  if (!recorded.ok) return refusal(refusalCodeOf(recorded.reason), recorded.reason);
  context.wake?.('clear_latch');
  const after = conditionOf({ dir, id: recorded.id });
  return { outcome: 'accepted', target: TARGET, before: null, after, undo: null, models: ['inbox', 'overview', 'appbar'] };
}

export const commands = [{
  name: 'upgrade.clear_latch',
  tier: 'person_only',
  reason_required: true,
  reversible: false,
  undo_command: null,
  inputs: [],
  refusals: ['already_queued', 'not_recorded', 'inbox_not_configured'],
  run,
}];
