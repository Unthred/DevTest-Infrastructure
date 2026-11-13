// Issue #1285: resume a stopped job once, or close a stopped job that a newer head has overtaken, as the named commands job.resume and job.close.
// Neither command applies anything itself. Each records an already approved Inbox action (issue #1280) and wakes the tick, which runs the action
// and keeps every one of its refusals. What the tick did is read from the Inbox item the helper created.
import { recordApprovedAction } from '../approved-action.mjs';

const INPUTS = [{ name: 'job', type: 'string', required: true }];
const MODELS = ['inbox', 'overview', 'appbar'];
const JOB_ID = /^([a-f0-9]{8}|[a-f0-9]{32})$/;
const DEFAULT_REASON = 'The homeowner used the control for this job on the dashboard.';

const COMMANDS = {
  'job.resume': { action: 'resume_job', title: id => `Resume job ${id}`, reply: 'Approved; the next pass resumes the job once.' },
  'job.close': { action: 'close_job', title: id => `Close job ${id}`, reply: 'Approved; the next pass saves the job\'s work and closes it.' },
};

const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const condition = reason => ({
  state: 'waiting_for_homeowner', attention: 'homeowner', reason_code: 'job_stopped', reason_text: reason, since: null,
});
const targetOf = id => ({ kind: 'job', key: id, label: `Job ${id}`, title: null, source: null, project: null, url: null });

function run(name) {
  const spec = COMMANDS[name];
  return (input, context) => {
    if (typeof input.job !== 'string' || !JOB_ID.test(input.job)) return refusal('bad_job_id', 'A job id is 8 or 32 lowercase hexadecimal characters.');
    if (!context.inboxDir) return refusal('inbox_not_configured', 'The inbox is not configured, so the action cannot be recorded.');
    const id = input.job.slice(0, 8);
    const reason = context.reason?.trim() ? context.reason : DEFAULT_REASON;
    const done = recordApprovedAction({ inboxDir: context.inboxDir, action: spec.action, target: id, reason, title: spec.title(id), now: context.now });
    if (!done.ok) return refusal(/already queued/.test(done.reason) ? 'already_queued' : 'not_recorded', done.reason);
    context.wake?.(name);
    const before = condition('The job is stopped and waiting for you.');
    return { outcome: 'accepted', target: targetOf(id), before, after: condition(spec.reply), models: MODELS };
  };
}

const define = (name, tier) => ({
  name, tier, reason_required: false, reversible: false, undo_command: null, inputs: INPUTS,
  refusals: ['bad_job_id', 'inbox_not_configured', 'already_queued', 'not_recorded'], run: run(name),
});

export const commands = [define('job.resume', 'direct'), define('job.close', 'approval')];
