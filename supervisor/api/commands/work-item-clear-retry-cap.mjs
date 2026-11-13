// Issue #1289: work_item.clear_retry_cap, the homeowner clears the retry cap Foreman put on a pull request.
// The command applies nothing itself: it records an approved `clear_retry_cap` action through the helper from issue #1280 and wakes the tick.
// The tick keeps its own refusals (for example, no cap in place), so the reply outcome is accepted, not applied.
// The key is the Needs you id after its retrycap prefix, such as rebase-1189: the job kind, a hyphen, the pull request number.
import { recordApprovedAction } from '../approved-action.mjs';
import { allStatuses } from '../../inbox.mjs';
import { stateName } from '../models/inbox.mjs';

export const MAX_KEY = 60;
export const FIXED_REASON = 'The homeowner used the Clear retry cap control on this pull request.';

const KEY_SHAPE = /^(.+)-(\d{1,9})$/;
const ISSUE_JOB_KIND = 'implement';

const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const refusalCodeOf = reason => (/already queued/.test(reason) ? 'already_queued' : 'not_recorded');

const targetOf = pull => ({
  kind: 'pull', key: String(pull), label: `Pull request ${pull}`, title: null, source: null, project: null, url: null,
});
const conditionOf = (dir, id) => {
  const state = stateName(allStatuses(dir).find(status => status.id === id)?.state);
  return { state, attention: 'none', reason_code: null, reason_text: null, since: null };
};

// Pure: the key to { kind, pull }, or null when it has no job kind or no number after its last hyphen.
export function parseKey(key) {
  if (typeof key !== 'string' || key.length > MAX_KEY) return null;
  const found = KEY_SHAPE.exec(key);
  const pull = found ? Number(found[2]) : 0;
  return pull >= 1 ? { kind: found[1], pull } : null;
}

function run(input, context) {
  const parsed = parseKey(input.key);
  if (!parsed) return refusal('bad_key', `The key must be a job kind, a hyphen and a pull request number, at most ${MAX_KEY} characters, like rebase-1189.`);
  if (parsed.kind === ISSUE_JOB_KIND) {
    return refusal('cap_on_issue', `The cap in ${input.key} is on an issue, and this control clears caps on pull requests only.`);
  }
  const dir = context.inboxDir;
  if (!dir) return refusal('inbox_not_configured', 'The inbox is not configured.');
  const reason = String(context.reason ?? '').trim() || FIXED_REASON;
  const title = `Clear the retry cap on pull request ${parsed.pull}`;
  const recorded = recordApprovedAction({ inboxDir: dir, action: 'clear_retry_cap', target: parsed.pull, reason, title, now: context.now });
  if (!recorded.ok) return refusal(refusalCodeOf(recorded.reason), recorded.reason);
  context.wake?.('clear-retry-cap');
  const after = conditionOf(dir, recorded.id);
  return { outcome: 'accepted', target: targetOf(parsed.pull), before: null, after, undo: null, models: ['inbox', 'overview', 'appbar'] };
}

export const commands = [{
  name: 'work_item.clear_retry_cap',
  tier: 'approval',
  reason_required: false,
  reversible: false,
  undo_command: null,
  inputs: [{ name: 'key', type: 'string', required: true }],
  refusals: ['bad_key', 'cap_on_issue', 'already_queued', 'not_recorded', 'inbox_not_configured'],
  run,
}];
