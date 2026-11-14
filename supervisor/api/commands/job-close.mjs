// Issue #1335: job.close records one approved close_job action; the tick, rather than this command, decides whether the overtaken job closes.
import { recordApprovedAction } from '../approved-action.mjs';
import { allStatuses } from '../../inbox.mjs';
import { stateName } from '../models/inbox.mjs';

export const FIXED_REASON = 'The homeowner used the Close control on this job.';

const JOB_ID = /^(?:[a-f0-9]{8}|[a-f0-9]{32})$/;
const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const refusalCodeOf = reason => (/already queued/.test(reason) ? 'already_queued' : 'not_recorded');

const targetOf = id => ({
  kind: 'job', key: id, label: `Job ${id}`, title: null, source: null, project: null, url: null,
});
const conditionOf = (dir, id) => {
  const state = stateName(allStatuses(dir).find(status => status.id === id)?.state);
  return { state, attention: 'none', reason_code: null, reason_text: null, since: null };
};

function run(input, context) {
  if (!JOB_ID.test(input.job)) return refusal('bad_job_id', 'A job id is 8 or 32 lowercase hexadecimal characters.');
  const dir = context.inboxDir;
  if (!dir) return refusal('inbox_not_configured', 'The inbox is not configured.');
  const job = input.job.slice(0, 8);
  const reason = String(context.reason ?? '').trim() || FIXED_REASON;
  const recorded = recordApprovedAction({ inboxDir: dir, action: 'close_job', target: job, reason, title: `Close job ${job}`, now: context.now });
  if (!recorded.ok) return refusal(refusalCodeOf(recorded.reason), recorded.reason);
  context.wake?.('job.close');
  const after = conditionOf(dir, recorded.id);
  return { outcome: 'accepted', target: targetOf(job), before: null, after, undo: null, models: ['inbox', 'overview', 'appbar'] };
}

export const commands = [{
  name: 'job.close',
  tier: 'approval',
  reason_required: false,
  reversible: false,
  undo_command: null,
  inputs: [{ name: 'job', type: 'string', required: true }],
  refusals: ['bad_job_id', 'inbox_not_configured', 'already_queued', 'not_recorded'],
  run,
}];
