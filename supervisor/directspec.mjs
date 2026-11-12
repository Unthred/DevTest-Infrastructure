// Issue #1164: what the overseer may do directly over the MCP, and what stays with the homeowner. Pure data and checks: no I/O, no clock.
// A direct control acts on work that is already in the queue or already running. Approving new work, merging, review verdicts, retry caps,
// closing or deleting, secrets, limits, the circuit breaker, host settings and restarts are listed in RESTRICTED and refused with who decides.

export const NUMBER_TARGET = /^[1-9]\d{0,8}$/;
export const JOB_TARGET = /^(?:[a-f0-9]{8}|[a-f0-9]{32})$/;   // the short id the dashboard shows, or the full id
export const PRIORITIES = ['high', 'normal', 'low'];
export const MAX_NOTES = 300;
export const MAX_EDITED_ENTRIES = 200;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const RANK = /^[1-9]\d{0,3}$/;
const MOVE = /^(before|after) ([1-9]\d{0,8})$/;
const DEPENDS = /^#[1-9]\d{0,8}(?:, ?#[1-9]\d{0,8}){0,9}$/;

// target: what the target field holds. value: how the value field is read (absent = the action takes none).
export const DIRECT = {
  start_job: { target: 'job', does: 'start or resume a paused or waiting job' },
  pause_job: { target: 'job', does: 'pause a job' },
  stop_job: { target: 'job', does: 'stop a job' },
  park: { target: 'number', does: 'park an issue or pull request' },
  unpark: { target: 'number', does: 'unpark an issue or pull request' },
  remove_entry: { target: 'number', does: 'remove a queued entry from the queue (the issue stays open, parked)' },
  set_rank: { target: 'number', value: 'rank', does: 'set the rank of a queued entry' },
  move_entry: { target: 'number', value: 'move', does: 'move a queued entry before or after another' },
  set_priority: { target: 'number', value: 'priority', does: 'set the priority of a queued entry' },
  set_depends_on: { target: 'number', value: 'depends', does: 'set the Depends on line of a queued entry' },
  assign: { target: 'number', value: 'agent', does: 'assign a queued entry to an agent' },
  set_notes: { target: 'number', value: 'notes', does: 'set the notes of a queued entry' },
};

// Names that are not direct controls, and who decides them. A control item naming one is refused with this sentence and audited.
export const RESTRICTED = {
  approve_prompt: 'approving new work to run (an Inbox prompt) is the homeowner\'s decision on the dashboard',
  approve_issue_draft: 'approving a new issue draft is the homeowner\'s decision on the dashboard',
  approve_proposal: 'a proposal is approved only by the homeowner on the dashboard, never by the overseer',
  merge: 'merging is the homeowner\'s decision',
  approve_review: 'approving a review is the homeowner\'s decision',
  override_verdict: 'overriding a review verdict is the homeowner\'s decision',
  new_review_attempt: 'granting a review attempt is an Inbox action the homeowner approves',
  clear_retry_cap: 'clearing a retry cap is an Inbox action the homeowner approves',
  clear_upgrade_latch: 'clearing the upgrade latch is the homeowner\'s decision',
  reopen: 'reopening an implemented issue is an Inbox action the homeowner approves',
  close_job: 'closing a job is an Inbox action the homeowner approves',
  close_issue: 'closing an issue is the homeowner\'s decision',
  delete_issue: 'deleting an issue is the homeowner\'s decision',
  close_pr: 'closing a pull request is the homeowner\'s decision',
  delete_pr: 'deleting a pull request is the homeowner\'s decision',
  set_limit: 'limits are the homeowner\'s to change',
  edit_secret: 'secrets are never touched by the overseer',
  resume_breaker: 'the circuit breaker is resumed by the homeowner on the dashboard',
  change_host_setting: 'host settings are the homeowner\'s to change',
  restart: 'restarts are the homeowner\'s decision',
  reboot: 'reboots are the homeowner\'s decision',
};

export const targetPattern = action => (DIRECT[action].target === 'job' ? JOB_TARGET : NUMBER_TARGET);

// Why a name is not a direct control, as one sentence for the audit and the response; null when it is one.
export function notDirectReason(action) {
  if (Object.hasOwn(DIRECT, action)) return null;
  if (Object.hasOwn(RESTRICTED, action)) return `${action} is not a direct control: ${RESTRICTED[action]}`;
  return `${action} is not a direct control (accepted: ${Object.keys(DIRECT).join(', ')})`;
}

const numbersOf = text => [...String(text).matchAll(/#(\d+)/g)].map(m => Number(m[1]));
const READ = {
  rank: v => (RANK.test(v) ? { rank: Number(v) } : null),
  move: v => { const m = MOVE.exec(v); return m ? { place: m[1], other: Number(m[2]) } : null; },
  priority: v => (PRIORITIES.includes(v) ? { priority: v } : null),
  depends: v => (v === 'none' ? { dependsOn: [] } : DEPENDS.test(v) ? { dependsOn: [...new Set(numbersOf(v))] } : null),
  agent: v => (v === 'none' ? { agent: null } : AGENT_NAME.test(v) ? { agent: v } : null),
  notes: v => (v.length <= MAX_NOTES && !/[\r\n]/.test(v) ? { notes: v } : null),
};
const SHAPE = {
  rank: 'a rank such as 1 (1 is the front of the queue)', move: '"before N" or "after N" with an issue number', priority: `one of ${PRIORITIES.join(', ')}`,
  depends: '"none" or a list such as "#12, #15"', agent: 'an agent name, or "none" to clear', notes: `one line of at most ${MAX_NOTES} characters`,
};

// The parsed value of a direct action: { ok:true, parsed } or { ok:false, reason }. An action without a value takes none.
export function readValue(action, value) {
  const kind = DIRECT[action]?.value;
  if (!kind) return value === undefined ? { ok: true, parsed: {} } : { ok: false, reason: `${action} takes no value` };
  if (typeof value !== 'string' || !value.trim()) return { ok: false, reason: `${action} needs a value: ${SHAPE[kind]}` };
  const parsed = READ[kind](value.trim());
  return parsed ? { ok: true, parsed } : { ok: false, reason: `the value for ${action} must be ${SHAPE[kind]}` };
}
