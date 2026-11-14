// Issue #1349: the queue contract is a pure view adapter. It deliberately reads the prepared dashboard view, the same
// snapshot foreman_why_blocked uses, so an API reader sees the planner's rank and hold rather than a second calculation.
import { waitText } from '../../dependencies.mjs';
import { classify } from '../attention.mjs';

export const name = 'queue';
export const path = 'queue';
export const schema = 'queue.schema.json';

const OPEN_CHANGE = new Set(['open', 'draft']);
const ACTIVE = new Set(['queued', 'running', 'paused_limit', 'paused_manual']);
const REVIEW = new Set(['review', 'interim-review']);
const iso = value => (Number.isFinite(value) ? new Date(value).toISOString() : null);
const list = value => (Array.isArray(value) ? value : []);
const sum = (items, field) => (items.some(item => Number.isFinite(item[field]))
  ? items.reduce((total, item) => total + (Number.isFinite(item[field]) ? item[field] : 0), 0)
  : null);
const latest = values => {
  const known = values.filter(Number.isFinite);
  return known.length ? Math.max(...known) : null;
};
const jobEnd = job => (Number.isFinite(job.startedAt) ? job.startedAt + (Number.isFinite(job.elapsedMs) ? job.elapsedMs : 0) : null);
const condition = (state, attention = 'none', reasonCode = null, reasonText = null, since = null) => ({
  state, attention, reason_code: reasonCode, reason_text: reasonText, since: iso(since),
});

function commandsOf(routes) {
  return list(routes).flatMap(route => list(route?.commands).map(command => command?.name)).filter(Boolean);
}

function attentionOf(view, kind, number, routes) {
  const known = commandsOf(routes);
  return list(view.panels?.needsYou)
    .filter(item => item?.ref?.n === number && (kind === 'change' ? item.ref.kind === 'pull' : item.ref.kind === 'issue'))
    .map(item => ({ item, classified: classify(item, known) }));
}

function dependencyOf(view, number) {
  const entry = view.dependencies?.issues?.[number];
  if (!entry) return { line_state: 'none', raw_line: null, declared: [], open: [], entry: null };
  const declared = list(entry.dependsOn).map(item => item.number).filter(Number.isSafeInteger);
  return {
    line_state: entry.malformed ? 'malformed' : 'ok',
    raw_line: typeof entry.line === 'string' ? entry.line : null,
    declared,
    open: list(entry.dependsOn).filter(item => item.state !== 'installed').map(item => item.number),
    entry,
  };
}

function rankOf(view, kind, number) {
  const keys = Object.keys(view.estimates?.items || {});
  const key = `${kind === 'change' ? 'pr' : 'issue'}:${number}`;
  const at = keys.indexOf(key);
  return { rank: at < 0 ? null : at + 1, rank_of: keys.length || null };
}

function heldByPlan(view, kind, number) {
  const types = kind === 'change' ? new Set(['review', 'interim-review', 'fix', 'cifix', 'rebase']) : new Set(['implement', 'continue']);
  return list(view.planned).find(item => item?.ref === number && item.outcome === 'held' && types.has(item.type)) || null;
}

function holdCondition({ dependency, attention, planned }) {
  if (dependency.entry?.malformed) {
    return condition('held', 'fault', 'malformed_prerequisite_line', `malformed Depends on line: ${dependency.entry.malformed}`, dependency.entry.since);
  }
  if (dependency.entry && !dependency.entry.met) {
    return condition('held', 'none', 'prerequisite_open', waitText(dependency.entry), dependency.entry.since);
  }
  const cap = attention.find(entry => entry.classified.reason_code === 'retry_capped');
  if (cap) return condition('held', cap.classified.attention, cap.classified.reason_code, cap.item.text ?? null, cap.item.since);
  if (planned) return condition('held', 'none', planned.kind ?? 'unrecorded', planned.reason ?? 'held by the last tick');
  const fault = attention.find(entry => entry.classified.attention !== 'homeowner');
  if (fault) return condition('held', fault.classified.attention, fault.classified.reason_code, fault.item.text ?? null, fault.item.since);
  const waiting = attention.find(entry => entry.classified.attention === 'homeowner');
  if (waiting) return condition('waiting_for_homeowner', 'homeowner', waiting.classified.reason_code, waiting.item.text ?? null, waiting.item.since);
  return null;
}

function stageOf({ change, jobs, condition: current, awaitingReview, parked }) {
  if (parked) return 'parked';
  if (change?.stage && ['merged', 'installed', 'verified'].includes(change.stage)) return change.stage;
  const active = jobs.find(job => ACTIVE.has(job.status));
  if (active?.kind === 'rebase') return 'rebasing';
  if (active?.kind === 'fix' || active?.kind === 'cifix') return 'fixing';
  if (active && REVIEW.has(active.kind)) return 'in_review';
  if (active) return 'implementing';
  if (awaitingReview) return 'in_review';
  if (change?.verdict === 'PASS' && change.checks === 'green') return 'ready_to_merge';
  return 'queued';
}

function roleOf(jobs, awaitingReview) {
  return awaitingReview || jobs.some(job => ACTIVE.has(job.status) && REVIEW.has(job.kind)) ? 'reviewer' : 'implementer';
}

function checksOf(value) {
  if (value === 'green') return 'passing';
  if (value === 'red') return 'failing';
  if (value === 'pending') return 'pending';
  return 'unknown';
}

function verdictOf(value) {
  if (value === 'PASS') return 'pass';
  if (value === 'CHANGES') return 'changes';
  return null;
}

function usageOf(view, jobs, fallbackTokens = null, fallbackCost = null) {
  const tokens = Number.isFinite(fallbackTokens) ? fallbackTokens : sum(jobs, 'tokens');
  const dollars = Number.isFinite(fallbackCost) ? fallbackCost : sum(jobs, 'cost');
  const rate = Number.isFinite(view.display?.gbpPerUsd) ? view.display.gbpPerUsd : 0.75;
  return { tokens, cost_pence: Number.isFinite(dollars) ? Math.round(dollars * rate * 100) : null };
}

function actionsOf(attention) {
  return attention.flatMap(entry => entry.classified.actions);
}

function labelsOf(kind, item) {
  if (kind === 'change') return item.needsHomeowner ? ['needs-homeowner'] : [];
  return list(item.labels);
}

function itemOf({ view, context, kind, item, jobs, issue = null, change = null, awaitingReview = false, mergedToday = false }) {
  const dependency = issue ? dependencyOf(view, item.number) : { line_state: 'none', raw_line: null, declared: [], open: [], entry: null };
  const attention = attentionOf(view, kind, item.number, context.routes);
  const planned = heldByPlan(view, kind, item.number);
  const current = holdCondition({ dependency, attention, planned })
    ?? (jobs.some(job => ACTIVE.has(job.status))
      ? condition('running')
      : awaitingReview
        ? condition('queued', 'none', 'waiting_for_review', 'waiting for review')
        : condition('queued'));
  const estimateKey = `${kind === 'change' ? 'pr' : 'issue'}:${item.number}`;
  const rank = mergedToday ? { rank: null, rank_of: null } : rankOf(view, kind, item.number);
  const estimate = view.estimates?.items?.[estimateKey];
  const labels = labelsOf(kind, item);
  const opened = kind === 'change' ? change?.openedAt : issue?.createdAt;
  const activity = latest([...jobs.map(jobEnd), change?.mergedAt, issue?.closedAt, opened]);
  const parent = kind === 'change' && Number.isSafeInteger(change?.issue) ? `issue-${change.issue}` : null;
  return {
    key: `${kind}-${item.number}`,
    type: kind,
    number: item.number,
    title: item.title || '',
    source: context.config.repository,
    project: context.config.repository,
    url: item.url ?? null,
    ...rank,
    agent: item.agent ?? null,
    role: roleOf(jobs, awaitingReview),
    stage: stageOf({ change, jobs, condition: current, awaitingReview, parked: labels.includes('parked') }),
    condition: current,
    prerequisites: { line_state: dependency.line_state, raw_line: dependency.raw_line, declared: dependency.declared, open: dependency.open },
    estimated_start_at: Number.isFinite(estimate?.start) ? iso(estimate.start) : null,
    change: kind === 'change' ? {
      review_rounds: change.reviewRounds ?? 0,
      fix_rounds: change.fixRounds ?? 0,
      fix_limit: context.config.limits?.max_fix_attempts ?? null,
      rebase_attempts: change.rebaseRounds ?? 0,
      verdict: verdictOf(change.verdict),
      checks: checksOf(change.checks),
      head: change.head ?? null,
    } : null,
    parent_key: parent,
    actions: actionsOf(attention),
    labels,
    usage: usageOf(view, jobs, change?.tokens, change?.costUsd),
    opened_at: iso(opened),
    last_activity_at: iso(activity),
  };
}

function jobsForIssue(view, number) {
  return list(view.jobs).filter(job => job.ref === number);
}

function jobsForChange(view, change) {
  const own = list(change.jobs);
  const early = Number.isSafeInteger(change.issue)
    ? jobsForIssue(view, change.issue).filter(job => ['implement', 'continue'].includes(job.kind) && !own.some(row => row.fullId === job.fullId))
    : [];
  return [...own, ...early];
}

function isToday(value, now, timeZone) {
  if (!Number.isFinite(value)) return false;
  const day = time => new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(time));
  return day(value) === day(now);
}

export function build(view, context) {
  const openChanges = list(view.prs).filter(change => OPEN_CHANGE.has(change.status));
  const mergedToday = list(view.prs).filter(change => (
    change.status === 'merged' && isToday(change.mergedAt, context.now, view.tz || 'UTC')
  ));
  const mergedIssueNumbers = new Set(mergedToday.map(change => change.issue));
  const issues = list(view.issues)
    .filter(issue => issue.state === 'OPEN' && !mergedIssueNumbers.has(issue.number))
    .map(issue => itemOf({
      view,
      context,
      kind: 'issue',
      item: issue,
      issue,
      jobs: jobsForIssue(view, issue.number),
      awaitingReview: list(view.prs).some(change => (
        change.issue === issue.number && OPEN_CHANGE.has(change.status) && change.awaitingReview
      )),
    }));
  const changes = [...openChanges, ...mergedToday]
    .map(change => itemOf({
      view,
      context,
      kind: 'change',
      item: change,
      change,
      jobs: jobsForChange(view, change),
      awaitingReview: change.awaitingReview,
      mergedToday: change.status === 'merged',
    }));
  const items = [...issues, ...changes].sort((left, right) => (left.rank ?? Infinity) - (right.rank ?? Infinity) || left.number - right.number);
  return {
    summary: {
      ranked: items.filter(item => item.rank !== null).length,
      held: items.filter(item => item.condition.state === 'held').length,
      parked: items.filter(item => item.stage === 'parked').length,
      open_changes: openChanges.length,
      max_open_changes: context.config.limits?.max_open_prs ?? null,
    },
    stages: ['queued', 'implementing', 'in_review', 'fixing', 'rebasing', 'ready_to_merge', 'merged', 'installed', 'verified', 'parked'],
    items,
  };
}
