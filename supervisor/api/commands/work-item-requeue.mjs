// Issue #1284: work_item.requeue, the homeowner lets Foreman start an issue again when it carries a stale implemented mark.
// The command applies nothing itself: it records an approved `reopen` action through the helper from issue #1280 and wakes the tick. The tick
// keeps its own refusals (a pull request, a live job or saved work for the issue), so the reply outcome is accepted, not applied.
import { recordApprovedAction } from '../approved-action.mjs';
import { allStatuses } from '../../inbox.mjs';
import { stateName } from '../models/inbox.mjs';

export const MIN_ISSUE = 1;
export const MAX_ISSUE = 999999999;
export const FIXED_REASON = 'The homeowner used the Requeue control to start this issue again.';

const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const refusalCodeOf = reason => (/already queued/.test(reason) ? 'already_queued' : 'not_recorded');

const targetOf = issue => ({
  kind: 'issue', key: String(issue), label: `Issue ${issue}`, title: null, source: null, project: null, url: null,
});
const conditionOf = id => {
  const state = stateName(allStatuses(id.dir).find(status => status.id === id.id)?.state);
  return { state, attention: 'none', reason_code: null, reason_text: null, since: null };
};

function run(input, context) {
  const { issue } = input;
  if (!Number.isInteger(issue) || issue < MIN_ISSUE || issue > MAX_ISSUE) {
    return refusal('bad_issue', `The issue number must be a whole number from ${MIN_ISSUE} to ${MAX_ISSUE}.`);
  }
  const dir = context.inboxDir;
  if (!dir) return refusal('inbox_not_configured', 'The inbox is not configured.');
  const reason = String(context.reason ?? '').trim() || FIXED_REASON;
  const recorded = recordApprovedAction({ inboxDir: dir, action: 'reopen', target: issue, reason, title: `Start issue ${issue} again`, now: context.now });
  if (!recorded.ok) return refusal(refusalCodeOf(recorded.reason), recorded.reason);
  context.wake?.('requeue');
  const after = conditionOf({ dir, id: recorded.id });
  return { outcome: 'accepted', target: targetOf(issue), before: null, after, undo: null, models: ['inbox', 'overview', 'appbar'] };
}

export const commands = [{
  name: 'work_item.requeue',
  tier: 'approval',
  reason_required: false,
  reversible: false,
  undo_command: null,
  inputs: [{ name: 'issue', type: 'integer', required: true }],
  refusals: ['bad_issue', 'already_queued', 'not_recorded', 'inbox_not_configured'],
  run,
}];
