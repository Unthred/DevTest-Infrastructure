// Issue #1156: the one decision table. Every Needs you item type Foreman raises maps to a plain reason, the condition that clears it, and the
// routine controls the card offers. Pure: no I/O. An id that matches no entry is an explicit error card, never a silent default.
// Controls are limited to actions that already exist (inbox ACTIONS plus park); strong actions belong to later slices and are only named.
import { redact } from './redact.mjs';
import { BREAKER_SCOPE } from './inbox.mjs';

// What a control needs from the item, how it is labelled, and what it does in one sentence (the button's tooltip).
export const CONTROLS = {
  clear_retry_cap: { label: 'Clear retry cap', target: 'pull', does: 'Lets Foreman plan the stopped job again. Refused when no cap is in place.' },
  new_review_attempt: { label: 'Allow one more review', target: 'pull', does: 'Gives one more review attempt at this head. Refused while attempts are left.' },
  resume_job: { label: 'Resume job', target: 'job', does: 'Resumes this job once with a fresh bounded round.' },
  stop_job: { label: 'Stop job', target: 'job', does: 'Stops this job; it will not restart.' },
  close_job: { label: 'Close job', target: 'job', does: 'Closes this overtaken job after saving its work to a branch on the remote.' },
  reopen: { label: 'Reopen issue', target: 'issue', does: 'Clears the implemented mark so Foreman can start the issue again.' },
  approve_split: { label: 'Approve split', target: 'pull', does: 'Files the proposed smaller items once and links them to the parked pull request. Nothing is filed before this.' },
  reject_split: { label: 'Reject split', target: 'pull', does: 'Files nothing. The pull request stays parked and the standing options remain.' },
  unpark: { label: 'Unpark', target: 'any', does: 'Removes the parked label so the planner may take it again.' },
  clear_latch: { label: 'Clear upgrade latch', target: 'latch', does: 'Clears the upgrade latch so the next tick may install merged work. Refused when no latch is set or an install is running.' },
  resume_breaker: { label: 'Resume breaker', target: 'scope', does: 'Resumes this halted breaker cause exactly as `team breaker resume` does, recorded with who and why. Refused when it is no longer halted.' },
  extra_fix_round: { label: 'Extra fix round', target: 'pull',
    does: 'Allows exactly one more fix job on the current head, past the fix limit and the churn stop, written by the agent that owns the branch; '
      + 'the limits apply again after it. Refused without a CHANGES verdict or red CI on the head, while a fix job has not ended, or when this head already had its round.' },
  close_superseded: { label: 'Close as superseded', target: 'any', input: 'superseded_by', does: 'Saves a pull request branch under saved/, then closes this pull request or issue with a comment naming the numbers you enter. Refused when it is not open, a number does not exist, or a job is running on it.' },
  park: { label: 'Park', target: 'any', does: 'Holds this work back from the planner until you unpark it.' },
};

const LATER_FIX = 'Merge, approve and verdict arrive with slice 3 of #1111.';
const LATER_VERDICT = 'Recording a review verdict from the dashboard arrives with slice 3 of #1111; until then review it on the pull request.';
const STOPPED_PR = ['extra_fix_round', 'close_superseded', 'park'];   // issues #1337 and #1339: what a stopped pull request card offers
const NO_BUTTON = 'Decided on the item itself; there is no routine control for it.';

// type -> { clears, actions, later?, reason? }. `clears` is the plain-words end condition; `reason(item)` overrides the default text.
const T = {
  'no-tick': { clears: 'clears when the dispatcher records its first tick', actions: [] },
  'tick-failed': { clears: 'clears when a tick succeeds; nothing is dispatched until then', actions: [] },
  'tick-stale': { clears: 'clears when the next tick is recorded', actions: [] },
  breaker: { clears: 'clears when a later job of the halted type completes, or when you resume the breaker with the control on this card', actions: ['resume_breaker'],
    later: 'The control resumes only the top halt cause; a second, lower halt is resumed with the Resume button on the breaker card or ai-supervisor team breaker resume.' },
  'split-stuck': { clears: 'clears when you approve or reject the proposed split of this parked pull request', actions: ['approve_split', 'reject_split'] },
  'split-wait': { clears: 'clears when the close as superseded item closes the pull request, or you unpark it', actions: [], later: 'The close of the parked pull request arrives with the close as superseded item of the split work.' },
  'split-parked': { clears: 'clears when you unpark the pull request or decide another way forward; the split is not offered again', actions: [] },
  'split-plan': { clears: 'clears when the planning job ends and the split is proposed or refused', actions: [] },
  fixlimit: { clears: 'clears when a new head is reviewed PASS; no more fix jobs start', actions: STOPPED_PR, later: LATER_FIX },
  churn: { clears: 'clears when the current head is no longer a CHANGES verdict (a new head reviewed PASS); no more fix jobs start', actions: STOPPED_PR, later: LATER_FIX },
  retrycap: { clears: 'clears when you clear the retry cap or the head changes; Foreman starts no more of that job until then', actions: ['clear_retry_cap', 'park'] },
  reviewlimit: { clears: 'clears when a review records a verdict, or a new head starts a fresh review', actions: ['new_review_attempt', 'park'] },
  reviewrefused: { clears: 'clears when a review at this head records a valid verdict, or a new head is pushed', actions: ['new_review_attempt', 'park'] },
  'noreviewer-refused': { clears: 'clears when an independent reviewer records a verdict at this head, or a new head is pushed', actions: ['park'], later: LATER_VERDICT },
  noreviewer: { clears: 'clears when a reviewer that is independent and available records a verdict, or you review it by hand', actions: ['park'], later: LATER_VERDICT },
  'selfcheck-job': { clears: 'clears when the job is stopped, reconciled or its process returns', actions: ['stop_job'] },
  'selfcheck-review': { clears: 'clears when a review records a verdict at this head or a new head is pushed', actions: ['new_review_attempt', 'park'] },
  selfcheck: { clears: 'clears when the host condition passes the next check', actions: [] },
  'homeowner-pr': { clears: 'clears when the needs-homeowner label is removed: the holding job is resumed, or a new head moves past it', actions: ['park'] },
  'after-install': { clears: 'clears when the After install checks of the pull request are marked done', actions: [], later: NO_BUTTON },
  'homeowner-steps': { clears: 'clears when the pull request is merged, closed or its head changes', actions: [], later: NO_BUTTON },
  homeowner: { clears: 'clears when you answer on the issue and the needs-homeowner label is removed', actions: [], later: NO_BUTTON },
  'decision-proposal': { clears: 'clears when the decision (a register entry or its docs/decisions file) is homeowner-approved with your recorded approval, or the pull request is closed', actions: [], later: NO_BUTTON },
  decision: { clears: 'clears when the register entry reads homeowner-approved on main', actions: [], later: NO_BUTTON },
  stalled: { clears: 'clears when the pull request makes progress, merges or closes', actions: STOPPED_PR },
  'stall-check-error': { clears: 'clears when the next stalled-PR check succeeds', actions: [] },
  job: { clears: 'clears when the job is resumed or closed, or a newer job for the same work starts', actions: ['resume_job', 'close_job'] },
  split: { clears: 'clears when you accept the split, or reshape the issue by hand', actions: [], later: 'Accept the split with the command shown; it has no button yet.' },
  prclosed: { clears: 'clears when the pull request is open again or the item is dropped on the next pass', actions: [] },
  'rebase-lost': { clears: 'clears when the dropped commits are restored on the branch or the head moves', actions: [], later: NO_BUTTON },
  'stale-mark': { clears: 'clears when the issue is reopened for Foreman, or a pull request exists for it', actions: ['reopen'] },
  ci: { clears: 'clears when the checks on the current head are green or the head moves', actions: STOPPED_PR },
  inbox: { clears: 'clears when you approve or reject the proposal on this card', actions: [] },
  inboxfail: { clears: 'clears three days after it failed, or sooner when the work is done another way', actions: [] },
  inboxrefused: { clears: 'clears three days after the latest refusal; the overseer can propose again', actions: [] },
  'closed-noreason': { clears: 'clears when a reason is recorded for every issue the item lists', actions: [] },
  'closed-noreason-unreadable': { clears: 'clears when the record of close reasons can be read again', actions: [] },
  'hand-deploy': { clears: 'clears when the installed commit moves past the change', actions: [] },
  'upgrade-latched': { clears: 'clears when you clear the latch with the control on this card (or ai-supervisor self-upgrade clear-latch on Tower)', actions: ['clear_latch'] },
  'upgrade-refused': { clears: 'clears when a later main is installed or the refusal no longer applies', actions: [] },
  'dashboard-restart-failed': { clears: 'clears when the dashboard restarts on the installed commit', actions: [] },
  'dashboard-stale': { clears: 'clears when the dashboard is restarted on the installed commit', actions: [] },
  drift: { clears: 'clears when the installed supervisor reaches main', actions: [] },
  'config-invalid': { clears: 'clears when team.local.json is valid again', actions: [] },
  'migration-failed': { clears: 'clears when the configuration migration succeeds on a later tick', actions: [] },
  'cap-deadlock': { clears: 'clears when one of the open pull requests can move or is closed', actions: [] },
  'hold-cycle': { clears: 'clears when the prompt that was waiting has run or is undone', actions: [] },
  'stalled-hold': { clears: 'clears when the hold ends or its control is used', actions: [] },
  'foreman-idle': { clears: 'clears when Foreman starts the waiting work', actions: [] },
  idle: { clears: 'clears when the agent starts the waiting work', actions: [] },
  pause: { clears: 'clears when the agent resumes or the pause is confirmed', actions: [] },
  escalating: { clears: 'clears when the final fix round finishes', actions: [] },
  'alert-failed': { clears: 'clears when an alert is delivered', actions: [] },
  'alert-warning': { clears: 'clears when the alert channel is healthy', actions: [] },
  'register-unreadable': { clears: 'clears when docs/DECISIONS.md can be read again', actions: [] },
  'history-storage': { clears: 'clears when the history storage is back under its limit', actions: [] },
  'paused-new-work': { clears: 'clears when new work is allowed again', actions: [] },
  'status-issue-failed': { clears: 'clears when the status issue is updated', actions: [] },
  'unknown-job-records': { clears: 'clears when the job records can be read', actions: [] },
  'assignment-fault': { clears: 'clears when each open issue has an implementer or a stated reason', actions: [] },
  agentfault: { clears: 'clears when Foreman\'s own check of the agent passes', actions: [] },
  dependency: { clears: 'clears when the Depends on line is fixed', actions: [] },
  resets: { clears: 'clears when you mark the reset used on the Limit resets card, or the advice no longer says to use it', actions: [], later: NO_BUTTON },
  'board-paused': { clears: 'clears when the GitHub rate limit ends', actions: [] },
};

export const DECISION_TYPES = Object.freeze(Object.keys(T));
// The longest matching type wins, so `homeowner-pr-12` is homeowner-pr and `homeowner-12` is homeowner.
export const typeOf = id => {
  const s = String(id ?? '');
  return DECISION_TYPES.filter(p => s === p || s.startsWith(`${p}-`)).sort((a, b) => b.length - a.length)[0] ?? null;
};

const clean = (t, n) => redact(String(t ?? '').replace(/\s+/g, ' ').trim(), n);
// The reason is never empty: the item's explanation and what it says, then a plain fallback naming the type.
export function reasonOf(item, type) {
  const parts = [clean(item.text, 700), clean(item.tried, 300)].filter(Boolean);
  return parts.length ? parts.join(' ') : `Foreman stopped on a "${type}" item and recorded no further detail.`;
}

const JOB_ID = /^(?:job|selfcheck-job)-([a-f0-9]{8})/;
// The target is always taken from the item, never from the request.
function targetFor(item, spec) {
  if (spec.target === 'latch') return item.id === 'upgrade-latched' ? 'latch' : null;   // no target: a fixed word
  if (spec.target === 'scope') return typeof item.scope === 'string' && BREAKER_SCOPE.test(item.scope) ? item.scope : null;   // issue #1332: the top halt cause
  if (spec.target === 'job') return JOB_ID.exec(String(item.id))?.[1] ?? null;
  const ref = item.ref;
  if (!ref || !Number.isSafeInteger(ref.n) || ref.n < 1) return null;
  if (spec.target === 'any') return String(ref.n);
  return ref.kind === spec.target ? String(ref.n) : null;
}

// Whether a control can apply to this item now. `ctx.parked` is the set of numbers carrying the parked label; `ctx.appConfigured` says park may run.
function applies(action, target, ctx) {
  const parked = ctx.parked.has(Number(target));
  if (action === 'park') return ctx.appConfigured && !parked;
  if (action === 'unpark') return parked;
  return true;
}

// Returns { type, reason, clears, controls, later } or { error } for a type with no entry.
export function decisionCard(item, ctx = {}) {
  const c = { parked: ctx.parked instanceof Set ? ctx.parked : new Set(), appConfigured: !!ctx.appConfigured };
  const type = typeOf(item?.id);
  if (!type) return { type: null, error: `Foreman raised "${clean(item?.id, 60)}", which this dashboard has no decision entry for. This is a bug; nothing can be done from this card.` };
  const entry = T[type];
  const wanted = [...entry.actions, 'unpark'];
  const controls = [];
  for (const action of wanted) {
    const spec = CONTROLS[action];
    const target = targetFor(item, spec);
    if (target && applies(action, target, c)) controls.push({ action, target, label: spec.label, does: spec.does, ...(spec.input ? { input: spec.input } : {}) });
  }
  return { type, reason: reasonOf(item, type), clears: entry.clears, controls, later: entry.later ?? null };
}
