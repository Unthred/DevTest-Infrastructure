// Issue #1310: the live board read model, as a pure builder. It turns the dashboard view, the configuration and the time it is given into
// the reply a screen needs to draw the board: the agents with their allowance, the lanes, the waiting work, the running jobs and the
// jobs that landed in the last 24 hours, each with the box it landed in. No GitHub call, no clock of its own, no stored state.
// The box table is fixed and documented in docs/api-contract.md; the first row that matches wins.
import { agentEntries } from './api/models/appbar.mjs';
import { MIN_SAMPLES } from './estimate.mjs';
import { KNOWN_STATUSES } from './dashdata.mjs';

export const LANDED_HOURS = 24;
export const LAPS_DAYS = 7;
export const LANDED_LIMIT = 300;
export const BOXES = ['merged', 'needs_you', 'passed', 'changes_asked', 'out_of_allowance', 'failed', 'stopped', 'to_review', 'done'];

const HOUR_MS = 3600000;
const LAP_BOXES = new Set(['changes_asked', 'failed', 'out_of_allowance']);
const WRITING_KINDS = new Set(['implement', 'continue', 'fix', 'cifix', 'ci-fix', 'rebase', 'split']);
const ISSUE_KINDS = new Set(['implement', 'continue']);
// Work that goes back to the agent that wrote the pull request (a fix returns to its writer); implement and review may go to any agent.
const TIED_TYPES = new Set(['fix', 'cifix', 'ci-fix', 'continue', 'rebase']);
const SKIPPED_STATUSES = new Set(['waiting_on']);
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const list = value => (Array.isArray(value) ? value : []);

// Lookups the other parts share: the item a job or plan entry belongs to, by the pull request when it has one.
function lookupsOf(view) {
  const prs = new Map(list(view.prs).map(p => [p.number, p]));
  const issues = new Map(list(view.issues).map(i => [i.number, i]));
  const prOfIssue = new Map(list(view.prs).filter(p => Number.isSafeInteger(p.issue)).map(p => [p.issue, p.number]));
  const keyOf = (number, isIssue) => (isIssue && !prOfIssue.has(number) ? `issue-${number}` : `pr-${isIssue ? prOfIssue.get(number) : number}`);
  const titleOf = (number, isIssue) => (isIssue ? issues.get(number)?.title : prs.get(number)?.title) ?? null;
  return { prs, keyOf, titleOf };
}

// Each job as the board reads it. A job with a status Foreman does not know is counted, not drawn.
function jobsOf(view, look) {
  const rows = [...list(view.jobs), ...list(view.olderJobs)];
  const jobs = [];
  let skipped = 0;
  for (const row of rows) {
    if (!KNOWN_STATUSES.includes(row.status)) { skipped += 1; continue; }
    if (row.status === 'queued' || SKIPPED_STATUSES.has(row.status) || !Number.isFinite(row.startedAt)) continue;
    const isIssue = ISSUE_KINDS.has(row.kind);
    const running = row.status === 'running';
    jobs.push({
      row, running, isIssue, number: Number.isSafeInteger(row.ref) ? row.ref : null,
      item: Number.isSafeInteger(row.ref) ? look.keyOf(row.ref, isIssue) : null,
      startedAt: row.startedAt, endedAt: running ? null : row.startedAt + (row.elapsedMs || 0),
    });
  }
  return { jobs, skipped };
}

// The verdict a review job produced: the one recorded on the job, else (older jobs) the first on its pull request from its start until the next review job of that pull request starts.
function verdictOf(job, all, verdicts) {
  if (job.row.verdict === 'PASS' || job.row.verdict === 'CHANGES') return job.row.verdict; // recorded on the job itself
  const next = all.filter(j => j.row.kind === 'review' && j.row.ref === job.number && j.startedAt > job.startedAt).map(j => j.startedAt);
  const until = next.length ? Math.min(...next) : Infinity;
  const mine = verdicts.filter(v => v.pr === job.number && Number.isFinite(v.at) && v.at >= job.startedAt && v.at < until);
  return mine.sort((a, b) => a.at - b.at)[0]?.verdict ?? null;
}

// The fixed table. `named` is the set of items in the current Needs you list; null leaves that row out (the lap count ignores it).
export function boxOf(job, { verdict, merged, named }) {
  const { status, kind } = job.row;
  if (kind === 'review' && verdict === 'PASS' && merged) return 'merged';
  if (named && job.item && named.has(job.item)) return 'needs_you';
  if (kind === 'review' && verdict === 'PASS') return 'passed';
  if (kind === 'review' && verdict === 'CHANGES') return 'changes_asked';
  if (status === 'paused_limit') return 'out_of_allowance';
  if (status === 'failed' || status === 'blocked') return 'failed';
  if (status === 'stopped' || status === 'paused_manual') return 'stopped';
  return status === 'completed' && WRITING_KINDS.has(kind) ? 'to_review' : 'done';
}

function namedItems(view, look) {
  const out = new Set();
  for (const item of list(view.panels?.needsYou)) {
    const n = item?.ref?.n;
    if (Number.isSafeInteger(n) && (item.ref.kind === 'pull' || item.ref.kind === 'issue')) out.add(look.keyOf(n, item.ref.kind === 'issue'));
  }
  return out;
}

const lanePair = (agent, model) => `${agent}\u0000${model ?? ''}`;
const laneId = (agent, model) => `${agent}/${model ?? 'default'}`;

// One lane per agent and model the configuration can launch, then any pair a running or landed job used. The job types come from both.
function lanesOf(config, view, used) {
  const lanes = new Map();
  const add = (agent, model, type) => {
    const key = lanePair(agent, model);
    if (!lanes.has(key)) lanes.set(key, { id: laneId(agent, model), agent, model: model ?? null, job_types: new Set() });
    if (type) lanes.get(key).job_types.add(type);
  };
  const agents = list(view.agents).map(a => a.name);
  for (const agent of agents) {
    const table = config?.models?.agents?.[agent] || {};
    for (const [type, entry] of Object.entries(table)) {
      if (type === 'review_candidates') list(entry).forEach(e => add(agent, e?.model, 'review'));
      else if (type !== 'low' && type !== 'strong') add(agent, entry?.model, type === 'ci-fix' ? 'cifix' : type);
    }
    if (!Object.keys(table).length) add(agent, null, null);
  }
  for (const u of used) add(u.agent, u.model, u.kind);
  return [...lanes.values()].map(l => ({ ...l, job_types: [...l.job_types].sort() }));
}

function agentsOf(view, now) {
  const jobs = list(view.agents).flatMap(a => [...list(a.jobs), ...(a.job ? [a.job] : [])].map(j => ({ agent: a.name, ...j })));
  return agentEntries(view, now, []).map(e => {
    const out = outOf(e.id, jobs, view, now);
    const { id, display_name, condition, weekly, short, reading } = e;
    return { id, display_name, condition, weekly, short, reading, out_until: iso(out.until), out_reason: out.reason };
  });
}

// An agent is out when a job of its own is paused for a usage limit (until the reported reset), or its allowance mode holds work back.
function outOf(agent, jobs, view, now) {
  const paused = jobs.filter(j => j.agent === agent && j.status === 'paused_limit');
  if (paused.length) {
    const times = paused.map(j => j.resetAt ?? j.nextAttemptAt).filter(Number.isFinite);
    const reason = 'a job is paused on a usage limit';
    return { until: times.length ? Math.max(...times) : null, reason: times.length ? reason : `${reason}; the reset time is not reported` };
  }
  const b = view.budget?.[agent];
  if (b && b.mode && b.mode !== 'normal' && Number.isFinite(b.until) && b.until > now) {
    return { until: b.until, reason: b.mode === 'reviews_only' ? 'allowance hold: reviews only' : 'allowance hold: waiting for the reset' };
  }
  return { until: null, reason: null };
}

function waitingOf(view, look) {
  const ledger = list(view.planned);
  const issues = new Map(list(view.issues).map(i => [i.number, i]));
  // A continue action carries the issue and the pull request; the next list keys it by the issue, the plan ledger by the pull request.
  const prOfIssue = new Map(list(view.prs).filter(x => Number.isSafeInteger(x.issue)).map(x => [x.issue, x.number]));
  const ledgerRefs = p => (p.type === 'continue' && prOfIssue.has(p.ref) ? [p.ref, prOfIssue.get(p.ref)] : [p.ref]);
  const entryOf = p => {
    const row = ledger.find(l => l.type === p.type && (l.agent ?? null) === (p.agent ?? null) && ledgerRefs(p).includes(l.ref));
    return { p, row };
  };
  return list(view.panels?.next).map(entryOf).filter(({ row }) => row?.outcome !== 'launched').map(({ p, row }, index) => {
    const pinned = p.type === 'implement' ? issues.get(p.ref)?.agent ?? null : null;
    return {
      place: index + 1, number: Number.isSafeInteger(p.ref) ? p.ref : null, title: look.titleOf(p.ref, ISSUE_KINDS.has(p.type)), job_type: p.type,
      tied_agent: (TIED_TYPES.has(p.type) ? p.agent : pinned) ?? null,
      held: row?.outcome === 'held' ? { kind: String(row.kind ?? 'unexplained'), reason: String(row.reason ?? '') } : null,
    };
  });
}

const typicalOf = (stats, kind) => {
  const s = stats?.[kind];
  return s && s.n >= MIN_SAMPLES && Number.isFinite(s.p50) ? Math.round(s.p50 / 1000) : null;
};
const pence = (usd, rate) => (Number.isFinite(usd) && Number.isFinite(rate) ? Math.round(usd * rate * 100) : null);

export function buildBoard(view, now, config = null) {
  const look = lookupsOf(view);
  const { jobs, skipped } = jobsOf(view, look);
  const verdicts = list(view.verdicts);
  const named = namedItems(view, look);
  const boxOfJob = (job, withNeeds) => boxOf(job, {
    verdict: verdictOf(job, jobs, verdicts), merged: look.prs.get(job.number)?.status === 'merged', named: withNeeds ? named : null,
  });
  const lapsFrom = now - LAPS_DAYS * 24 * HOUR_MS;
  const lapsOf = job => jobs.filter(j => !j.running && j.item !== null && j.item === job.item
    && j.startedAt < job.startedAt && j.startedAt >= lapsFrom && LAP_BOXES.has(boxOfJob(j, false))).length;
  const laneOfJob = job => laneId(job.row.agent, job.row.model ?? null);
  const base = job => ({
    job_id: job.row.id, lane_id: laneOfJob(job), job_type: job.row.kind, number: job.number,
    title: job.number === null ? null : look.titleOf(job.number, job.isIssue), laps: lapsOf(job),
  });
  const running = jobs.filter(j => j.running).sort((a, b) => a.startedAt - b.startedAt || String(a.row.id).localeCompare(String(b.row.id)))
    .map(j => ({ ...base(j), started_at: iso(j.startedAt), typical_seconds: typicalOf(view.estimates?.stats, j.row.kind) }));
  const qualifying = jobs.filter(j => !j.running && j.endedAt >= now - LANDED_HOURS * HOUR_MS)
    .sort((a, b) => b.endedAt - a.endedAt || String(a.row.id).localeCompare(String(b.row.id)))
    .map(j => ({
      ...base(j), ended_at: iso(j.endedAt), box: boxOfJob(j, true), tokens: Number.isFinite(j.row.tokens) ? j.row.tokens : null,
      cost_pence: pence(j.row.cost, view.display?.gbpPerUsd), used: j,
    }));
  const counts = Object.fromEntries(BOXES.map(b => [b, qualifying.filter(q => q.box === b).length]));
  const shown = qualifying.slice(0, LANDED_LIMIT);
  const used = [...jobs.filter(j => j.running), ...shown.map(q => q.used)].map(j => ({ agent: j.row.agent, model: j.row.model ?? null, kind: j.row.kind }));
  return {
    agents: agentsOf(view, now),
    lanes: lanesOf(config, view, used),
    waiting: waitingOf(view, look),
    running,
    landed: shown.map(({ used: _used, ...q }) => q),
    counts,
    truncated: qualifying.length > LANDED_LIMIT,
    skipped_jobs: skipped,
  };
}
