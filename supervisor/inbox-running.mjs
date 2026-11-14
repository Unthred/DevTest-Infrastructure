// Issue #1466: the Inbox Running view. The job rows of the prepared view (one per job, see dashboard.mjs rowOf) become Inbox-shaped
// records, so the Running button shows what runs now. Pure: no GitHub call, no clock, no writes.
import { placeholderIssue } from './inbox.mjs';

const RUNNING = new Set(['queued', 'running']);
const PAUSED = new Set(['paused_limit', 'paused_manual']);
const ROLE = { review: 'reviewer', rebase: 'rebaser', inbox: 'inbox' };   // the same rule as team.mjs roleOfType; everything else implements
const ON_PULL_REQUEST = new Set(['review', 'fix', 'cifix', 'rebase']);   // the job's ref is the pull request number
const ON_ISSUE = new Set(['implement', 'continue']);   // the job's ref is the issue number; any other kind (an inbox prompt) has neither
// The Inbox item states the Running button holds (an item with no job row of its own still shows).
export const RUNNING_ITEM_STATES = new Set(['approved', 'running', 'posting']);

const isLive = job => RUNNING.has(job?.status) || PAUSED.has(job?.status);
const validNumber = n => Number.isSafeInteger(n) && n > 0;

function sourceNumbers(job) {
  const ok = validNumber(job.ref);
  return { issue: ok && ON_ISSUE.has(job.kind) ? job.ref : null, pr: ok && ON_PULL_REQUEST.has(job.kind) ? job.ref : null };
}

// The Inbox card a job came from: an item whose own job it is (a prompt: the job holds the item's placeholder issue number), else the
// card that was posted as the issue the job works on.
function cardOf(job, records) {
  if (!validNumber(job.ref)) return null;
  const own = records.find(r => r.id && placeholderIssue(r.id) === job.ref);
  if (own) return own;
  return ON_ISSUE.has(job.kind) ? records.find(r => r.reference && r.issue === job.ref) || null : null;
}

function jobRecord(job, card) {
  const { issue, pr } = sourceNumbers(job);
  const kind = String(job.kind || 'job');
  return {
    id: String(job.fullId || job.id || ''), kind: 'job', state: PAUSED.has(job.status) ? 'paused' : 'running',
    title: String(job.name || '').trim() || `Job ${job.id || job.fullId || 'unknown'}`,
    reference: card?.reference || '', createdAt: Number.isFinite(job.startedAt) ? job.startedAt : null, issue, pr,
    job: { agent: job.agent || '', model: job.model || '', role: ROLE[kind] || 'implementer', kind, attempt: Number(job.attempts) || 0,
      href: `/jobs/${encodeURIComponent(String(job.fullId || job.id || ''))}`, hasTranscript: job.hasTranscript === true, ownItem: card?.id || null },
  };
}

// One record per running, queued or paused job, newest start first.
export function runningJobRecords(jobs, records = []) {
  return (Array.isArray(jobs) ? jobs : []).filter(isLive)
    .map(job => jobRecord(job, cardOf(job, records)))
    .sort((a, b) => (b.createdAt ?? -Infinity) - (a.createdAt ?? -Infinity));
}

// What the Running view shows: the job records, then the Inbox items in a running state that have no job row of their own.
export function runningView(jobs, records) {
  const jobRecords = runningJobRecords(jobs, records);
  const owned = new Set(jobRecords.map(r => r.job.ownItem).filter(Boolean));
  const items = records.filter(r => RUNNING_ITEM_STATES.has(r.state) && !owned.has(r.id));
  return { rows: [...jobRecords, ...items], jobsRunning: jobRecords.filter(r => r.state === 'running').length };
}
