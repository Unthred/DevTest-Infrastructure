// Issue #1281: the homeowner accepts a split that Foreman proposed for an issue, as the named command work_item.accept_split.
// The command files nothing itself. It checks the proposal in the team state, leaves one accept split request in the homeowner request
// queue and wakes the tick, which files the children under the tick lock. A request the tick later refuses is reported by the tick.
import { readTeamState } from '../../dashdata.mjs';
import { queueHomeownerRequest } from '../../homeownerqueue.mjs';

const NAME = 'work_item.accept_split';
const INPUTS = [{ name: 'issue', type: 'integer', required: false }, { name: 'pull', type: 'integer', required: false }];
const MODELS = ['overview', 'appbar'];

const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const NEEDS_ISSUE = 'A split for a pull request at the fix limit is not built yet, so give the issue number of a proposed split; '
  + 'the pull request can be parked meanwhile.';

const condition = reason => ({
  state: 'waiting_for_homeowner', attention: 'homeowner', reason_code: 'split_proposed', reason_text: reason, since: null,
});
const targetOf = issue => ({
  kind: 'issue', key: String(issue), label: `Issue #${issue}`, title: null, source: null, project: null, url: null,
});

function run(input, context) {
  if (input.pull !== undefined || !Number.isSafeInteger(input.issue) || input.issue < 1) return refusal('split_needs_issue', NEEDS_ISSUE);
  const { issue } = input;
  const split = readTeamState(context.root)?.splits?.[issue];
  if (split?.status !== 'proposed') {
    const found = split ? `a split in the state ${split.status}, not proposed` : 'no split';
    return refusal('no_proposed_split', `Issue #${issue} has ${found}.`);
  }
  queueHomeownerRequest(context.root, 'accept-split', [issue], context.now);
  context.wake?.('accept-split');
  const before = condition('A split is proposed and waiting for you to accept it.');
  const after = condition('Accepted; the next pass files the child issues.');
  return { outcome: 'accepted', target: targetOf(issue), before, after, models: MODELS };
}

export const commands = [{
  name: NAME, tier: 'approval', reason_required: false, reversible: false, undo_command: null, inputs: INPUTS,
  refusals: ['no_proposed_split', 'split_needs_issue'], run,
}];
