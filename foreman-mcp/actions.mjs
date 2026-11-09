// The vocabulary, decision classification and controls share this one source of truth.
// Keeping the matcher beside the table makes a newly-raised decision fail visibly until it
// is deliberately assigned an action.
export const ACTIONS = Object.freeze({
  new_review_attempt: { target: 'pr', noun: 'pull request', label: 'Plan one more review attempt', tier: 'click', will: 'Give this pull request one more review attempt at its current head.' },
  extra_fix_round: { target: 'pr', noun: 'pull request', label: 'Plan one more fix round', tier: 'click', will: 'Make room for one more ordinary fix round on this pull request.' },
  clear_retry_cap: { target: 'number', noun: 'work item', label: 'Clear retry cap', tier: 'click', will: 'Clear Foreman’s retry cap so the affected work can be planned again.' },
  close_job: { target: 'job', noun: 'job', label: 'Close superseded job', tier: 'click', will: 'Close this superseded or stopped job.' },
  stop_job: { target: 'job', noun: 'job', label: 'Stop job', tier: 'click', will: 'Stop this running or paused job.' },
  resume_job: { target: 'job', noun: 'job', label: 'Resume job', tier: 'click', will: 'Resume this paused, blocked or failed job once.' },
  reopen: { target: 'issue', noun: 'issue', label: 'Reopen issue', tier: 'click', will: 'Clear this issue’s implemented mark so Foreman can start it again.' },
  park: { target: 'number', noun: 'work item', label: 'Park this work', tier: 'click', will: 'Keep this work parked until its cause is resolved.' },
  resume_breaker: { target: 'number', noun: 'work item', label: 'Resume breaker', tier: 'click', will: 'Request that Foreman resumes the halted breaker scope.' },
  merge: { target: 'pr', noun: 'pull request', label: 'Merge pull request', tier: 'strong', will: 'Record a homeowner merge override for this pull request.' },
  approve: { target: 'pr', noun: 'pull request', label: 'Approve pull request', tier: 'strong', will: 'Record a homeowner approval override for this pull request.' },
  review_verdict: { target: 'pr', noun: 'pull request', label: 'Record review verdict', tier: 'strong', will: 'Record a homeowner review-verdict override for this pull request.' },
});

export const TARGET_RE = Object.freeze({ pr: /^[1-9]\d{0,8}$/, issue: /^[1-9]\d{0,8}$/, number: /^[1-9]\d{0,8}$/, job: /^[a-f0-9]{8}$/ });
export const actionNames = () => Object.keys(ACTIONS);
export function validAction(action, target) {
  const spec = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : null;
  return !!spec && TARGET_RE[spec.target].test(String(target));
}

// One row for every decision Foreman emits. `target` uses the item's explicit ref;
// no UI module owns a parallel list of id prefixes.
export const DECISION_ACTIONS = Object.freeze([
  { type: 'retry_cap', match: /^retrycap-/, actions: ['clear_retry_cap', 'new_review_attempt'] },
  { type: 'fix_limit', match: /^fixlimit-/, actions: ['extra_fix_round'] },
  { type: 'review_limit', match: /^(reviewlimit|reviewrefused)-/, actions: ['new_review_attempt'] },
  { type: 'stopped_job', match: /^job-[a-f0-9]{8,}$/, actions: ['resume_job', 'close_job'] },
  { type: 'superseded_job', match: /^superseded-job-[a-f0-9]{8,}$/, actions: ['close_job'] },
  { type: 'stale_issue', match: /^stale-mark-/, actions: ['reopen'] },
  { type: 'split', match: /^split-/, actions: ['park'] },
  { type: 'decision', match: /^decision-/, actions: ['approve', 'review_verdict', 'park'] },
  { type: 'homeowner_issue', match: /^homeowner-\d+$/, actions: ['reopen', 'park'] },
  { type: 'homeowner_pr', match: /^homeowner-pr-/, actions: ['approve', 'merge', 'park'] },
  { type: 'no_reviewer', match: /^noreviewer(?:-refused)?-/, actions: ['new_review_attempt', 'park'] },
  { type: 'closed_pr', match: /^prclosed-/, actions: ['reopen', 'park'] },
  { type: 'stalled', match: /^stalled-/, actions: ['merge', 'approve', 'park'] },
  { type: 'breaker', match: /^breaker-halt$/, actions: ['resume_breaker'] },
]);

const targetOf = item => String(item?.ref?.n || /-(\d+)$/.exec(String(item?.id || ''))?.[1] || '');
export function decisionType(item) { return DECISION_ACTIONS.find(rule => rule.match.test(String(item?.id || '')))?.type || null; }
export function controlsForDecision(item) {
  const rule = DECISION_ACTIONS.find(entry => entry.match.test(String(item?.id || '')));
  if (!rule) return { type: null, controls: [], error: 'Foreman has no action mapping for this decision type.' };
  const target = rule.type.includes('job') ? String(item.id).slice(4, 12) : targetOf(item);
  const names = rule.type === 'retry_cap' && item?.ref?.kind === 'issue' ? ['clear_retry_cap'] : rule.actions;
  const controls = names.map(action => ({ action, ...ACTIONS[action], target }));
  return { type: rule.type, controls, error: controls.every(control => validAction(control.action, control.target)) ? null : 'Foreman produced an invalid decision action.' };
}
export function assertDecisionTable() {
  for (const row of DECISION_ACTIONS) if (!row.actions.length || row.actions.some(name => !Object.hasOwn(ACTIONS, name))) throw new Error(`decision type ${row.type} has no valid action`);
  return true;
}
