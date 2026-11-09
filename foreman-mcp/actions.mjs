// Named homeowner decisions. This is shared by Foreman and its separately-installed
// MCP server, so the allowed action vocabulary has one source of truth.
export const ACTIONS = Object.freeze({
  new_review_attempt: {
    target: 'pr', noun: 'pull request', label: 'Plan one more review attempt', tier: 'click',
    will: 'Give one more review attempt at the same head of this pull request. Nothing is merged or approved; the new review decides.',
  },
  extra_fix_round: {
    target: 'pr', noun: 'pull request', label: 'Plan one more fix round', tier: 'click',
    will: 'Make room for one more ordinary fix round on this pull request. The next Foreman tick still checks the head, verdict and normal safety limits.',
  },
  clear_retry_cap: {
    target: 'pr', noun: 'pull request', label: 'Clear retry cap', tier: 'click',
    will: 'Clear the retry cap Foreman put on this pull request, so it is planned again. Refused when no cap is in place.',
  },
  close_job: {
    target: 'job', noun: 'job', label: 'Close superseded job', tier: 'click',
    will: 'Close this stopped job of a pull request that a newer head has overtaken. '
      + 'Unpushed work is saved to a branch on the remote first; the job is closed only once nothing local is unsaved.',
  },
  stop_job: {
    target: 'job', noun: 'job', label: 'Stop job', tier: 'click', will: 'Stop this running or paused job.',
  },
  resume_job: {
    target: 'job', noun: 'job', label: 'Resume job', tier: 'click', will: 'Resume this paused, blocked or failed job once, with a fresh bounded round.',
  },
  reopen: {
    target: 'issue', noun: 'issue', label: 'Reopen issue', tier: 'click', will: 'Clear the implemented mark of this issue so Foreman can start it again.',
  },
});

export const TARGET_RE = Object.freeze({
  pr: /^[1-9]\d{0,8}$/,
  issue: /^[1-9]\d{0,8}$/,
  job: /^[a-f0-9]{8}$/,
});

export const actionNames = () => Object.keys(ACTIONS);

export function validAction(action, target) {
  const spec = ACTIONS[action];
  return !!spec && TARGET_RE[spec.target].test(String(target));
}

// Each decision category needs at least one action. The dashboard derives controls
// from this table; an unknown decision category is deliberately rendered as an error.
export const DECISION_ACTIONS = Object.freeze({
  retry_cap: ['clear_retry_cap', 'new_review_attempt'],
  fix_limit: ['extra_fix_round'],
  review_limit: ['new_review_attempt'],
  superseded_job: ['close_job'],
  stopped_job: ['resume_job', 'close_job'],
  stale_issue: ['reopen'],
});

export function decisionType(item) {
  const id = String(item?.id || '');
  if (/^retrycap-/.test(id)) return 'retry_cap';
  if (/^fixlimit-/.test(id)) return 'fix_limit';
  if (/^(reviewlimit|reviewrefused)-/.test(id)) return 'review_limit';
  if (/^job-[a-f0-9]{8,}$/.test(id)) return 'stopped_job';
  if (/^stale-mark-/.test(id)) return 'stale_issue';
  return null;
}

function decisionTarget(item, type) {
  const id = String(item?.id || '');
  if (type === 'stopped_job') return /^job-([a-f0-9]{8,})$/.exec(id)?.[1].slice(0, 8) || '';
  return String(item?.ref?.n || /-(\d+)$/.exec(id)?.[1] || '');
}

export function controlsForDecision(item) {
  const type = decisionType(item);
  if (!type) return { type: null, controls: [], error: 'Foreman has no action mapping for this decision type.' };
  const target = decisionTarget(item, type);
  const controls = DECISION_ACTIONS[type].map(name => ({ action: name, ...ACTIONS[name], target }));
  return { type, controls, error: controls.every(c => validAction(c.action, c.target)) ? null : 'Foreman produced an invalid decision action.' };
}

export function assertDecisionTable() {
  for (const [type, names] of Object.entries(DECISION_ACTIONS)) {
    if (!names.length || names.some(name => !ACTIONS[name])) throw new Error(`decision type ${type} has no valid action`);
  }
  return true;
}
