// Issue #1224: one row per open issue and open pull request (and per item finished today), built from the dashboard view: the same data
// foreman_why_blocked reads (queues, the last tick's planned ledger, attention items, the dependency record, estimates, issues,
// pull requests and jobs). Pure: the view in, plain JSON out. The table, the board and the side panel in the browser run on these rows
// (dashui/worktable.mjs).
import { formatCost } from './money.mjs';

const ACTIVE = new Set(['running']);
const BLOCKED = /^(blocked by|needs the homeowner|stuck:|waiting on|waits:)/;
const NEEDS_YOU = /needs the homeowner|waiting for the homeowner/;
const RETRY_CAP = /^retrycap-/;
const OPEN_PR = /^PR open|^reassigned.*PR #\d+ open/;

const dayOf = (ms, tz) => (Number.isFinite(ms) ? new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(ms)) : null);
const sum = (xs, key) => (xs.some(x => Number.isFinite(x[key])) ? xs.reduce((s, x) => s + (Number.isFinite(x[key]) ? x[key] : 0), 0) : null);
const jobEnd = j => (Number.isFinite(j.startedAt) ? j.startedAt + (Number.isFinite(j.elapsedMs) ? j.elapsedMs : 0) : null);
const latest = xs => {
  const known = xs.filter(Number.isFinite);
  return known.length ? Math.max(...known) : null;
};

// Where each item sits in the queue: the order the estimates use (next first, then lowest number), blocked items included.
function rankIndex(view) {
  const keys = Object.keys(view.estimates?.items || {});
  return { rankOf: keys.length, rankOfKey: key => (keys.includes(key) ? keys.indexOf(key) + 1 : null) };
}

// Why an item is held, and since when (null when Foreman keeps no start time for that kind of hold).
function holdOf({ kind, ref, entries, planned, attention, wait }) {
  if (wait) return { reason: wait.reason, since: wait.since };
  const cap = attention.find(a => a.ref.n === ref && RETRY_CAP.test(a.id || ''));
  if (cap) return { reason: cap.text, since: Number.isFinite(cap.since) ? cap.since : null };
  const held = planned.find(p => p.ref === ref && p.outcome === 'held');
  if (held) return { reason: held.reason || 'held by the last tick', since: null };
  const entry = entries.find(e => e.type === kind && BLOCKED.test(e.reason || '') && !NEEDS_YOU.test(e.reason));
  return entry ? { reason: entry.reason, since: null } : null;
}

function stateOf({ done, running, needsYou, hold, awaitingReview }) {
  if (done) return 'done';
  if (running) return 'running';
  if (needsYou) return 'waiting-you';
  if (hold) return 'held';
  if (awaitingReview) return 'waiting-review';
  return 'planned';
}

const jobDetail = j => ({
  id: j.id, kind: j.kind, status: j.status, agent: j.agent, cause: j.desc || '', tokens: j.tokens ?? null, cost: j.cost ?? null, costText: formatCost(j.cost),
  startedAt: j.startedAt ?? null, page: `/work/job/${encodeURIComponent(j.id)}`, transcript: j.hasTranscript ? `/jobs/${encodeURIComponent(j.fullId)}` : null
});
const verdictDetail = v => ({
  reviewer: v.reviewer, model: v.model, verdict: v.verdict, head: v.head, at: v.at, findings: (v.findings || []).slice(0, 5), followUpIssue: v.followUpIssue
});

// The prerequisites of an issue, nearest first, from the tick's dependency record (the Depends on line, issue #1103): each with its state
// (open, merged but not installed, installed, ...) and whether it still blocks. Cycles and depth are bounded.
export function dependencyChain(view, start, limit = 40) {
  const byNo = new Map((view.issues || []).map(i => [i.number, i]));
  const record = view.dependencies?.issues || {};
  const out = [], seen = new Set([start]);
  const walk = (n, depth) => {
    for (const d of record[n]?.dependsOn || []) {
      if (seen.has(d.number) || out.length >= limit) continue;
      seen.add(d.number);
      out.push({ ref: d.number, depth, title: byNo.get(d.number)?.title ?? null, state: d.state, blocking: d.state !== 'installed' });
      walk(d.number, depth + 1);
    }
  };
  walk(start, 1);
  return out;
}
// What an issue waits for, from the same record: the prerequisites not yet installed, why, and since when.
export function dependencyWait(view, number) {
  const e = view.dependencies?.issues?.[number];
  if (!e || e.met) return null;
  const refs = e.dependsOn.filter(d => d.state !== 'installed').map(d => d.number);
  return { refs, reason: `waiting for ${e.reasons.join('; ')}`, since: Number.isFinite(e.since) ? e.since : null };
}

// One row and its detail from what the caller found out about the item. `item` is the issue or pull request, `entries` its queue entries.
function makeRow(ctx, item, entries, extra) {
  const { view, now, planned, attention, rankOf, rankOfKey } = ctx;
  const key = `${item.kind}:${item.ref}`, est = view.estimates?.items?.[key] || null;
  const hold = holdOf({ kind: item.kind, ref: item.ref, entries, planned, attention, wait: extra.wait });
  const asked = attention.some(a => a.ref.n === item.ref && a.severity === 'action' && !RETRY_CAP.test(a.id || ''));
  const needsYou = item.needsHomeowner || entries.some(e => NEEDS_YOU.test(e.reason || '')) || (asked && !hold);
  const state = stateOf({ done: item.finishedToday, running: extra.running, needsYou, hold, awaitingReview: extra.awaitingReview });
  const held = state === 'held' && hold;
  const row = {
    key, ref: item.ref, kind: item.kind, title: item.title || '', agent: item.agent || null,
    role: extra.role || (state === 'waiting-review' ? 'reviewer' : 'implementer'), state,
    rank: item.finishedToday ? null : rankOfKey(key), rankOf: item.finishedToday ? null : rankOf,
    waitsOn: extra.wait?.refs || item.waitsOn || [], waitsText: (est?.waits || []).map(w => w.text),
    holdReason: held ? hold.reason : null, holdSince: held ? hold.since : null,
    estStart: Number.isFinite(est?.start) ? est.start : null, estText: est?.text || '',
    reviewRounds: item.reviewRounds ?? null, fixRounds: item.fixRounds ?? null, rebaseRounds: item.rebaseRounds ?? null,
    checks: item.checks || null, verdict: item.verdict || null, labels: extra.labels,
    tokens: extra.tokens, cost: extra.cost, costText: formatCost(extra.cost),
    age: Number.isFinite(item.createdAt) ? Math.max(0, now - item.createdAt) : null, lastActivity: extra.lastActivity,
    url: item.url, page: `/work/${item.kind}/${item.ref}`, reason: entries[0]?.reason || item.reason || ''
  };
  const assignment = item.kind === 'issue' ? (view.assignments || []).find(a => a.number === item.ref)?.rule ?? null : null;
  const detail = {
    jobs: extra.jobs.slice(0, 40).map(jobDetail), verdicts: extra.verdicts.map(verdictDetail), chain: extra.chain,
    holdReason: row.holdReason, holdSince: row.holdSince, estText: row.estText, basis: est?.basis || [], assignment
  };
  return { row, detail };
}

function issueRow(ctx, i) {
  const { view, tz, today, queues } = ctx;
  const open = i.state === 'OPEN', doneToday = i.state === 'CLOSED' && dayOf(i.closedAt, tz) === today;
  if (!open && !doneToday) return null;
  const own = (view.jobs || []).filter(j => j.ref === i.number);
  const pr = (view.prs || []).find(p => p.issue === i.number && (p.status === 'open' || p.status === 'draft'));
  const entries = queues.filter(q => q.type === 'issue' && q.ref === i.number);
  const running = own.some(j => ACTIVE.has(j.status));
  const item = { ...i, kind: 'issue', ref: i.number, finishedToday: doneToday, waitsOn: i.blockedBy };
  return makeRow(ctx, item, entries, {
    wait: open && !running ? dependencyWait(view, i.number) : null, running, awaitingReview: !!pr?.awaitingReview,
    labels: i.labels || [], tokens: sum(own, 'tokens'), cost: sum(own, 'cost'), lastActivity: latest([...own.map(jobEnd), i.closedAt]),
    jobs: own, verdicts: pr ? pr.verdicts.slice(0, 10) : [], chain: dependencyChain(view, i.number)
  });
}

function pullRow(ctx, p) {
  const { view, tz, today, queues } = ctx;
  const open = p.status === 'open' || p.status === 'draft', doneToday = p.status === 'merged' && dayOf(p.mergedAt, tz) === today;
  if (!open && !doneToday) return null;
  const entries = queues.filter(q => (q.type === 'pr' || q.type === 'review') && q.ref === p.number);
  const early = Number.isSafeInteger(p.issue) ? (view.jobs || []).filter(j => j.ref === p.issue && ['implement', 'continue'].includes(j.kind)) : [];
  const all = [...p.jobs, ...early.filter(j => !p.jobs.some(x => x.fullId === j.fullId))];
  const item = { ...p, kind: 'pr', ref: p.number, finishedToday: doneToday, waitsOn: [], createdAt: p.openedAt, reason: p.status };
  return makeRow(ctx, item, entries, {
    running: all.some(j => ACTIVE.has(j.status)), awaitingReview: !!p.awaitingReview || entries.some(e => e.type === 'review'),
    labels: p.needsHomeowner ? ['needs-homeowner'] : [], tokens: p.tokens ?? sum(all, 'tokens'), cost: p.costUsd ?? sum(all, 'cost'),
    lastActivity: latest([...all.map(jobEnd), ...p.verdicts.map(v => v.at), p.mergedAt]), jobs: all, verdicts: p.verdicts.slice(0, 10),
    chain: Number.isSafeInteger(p.issue) ? dependencyChain(view, p.issue) : []
  });
}

export function buildWorkRows(view) {
  const tz = view.tz || 'UTC', now = view.generatedAt;
  const queues = Object.entries(view.queues || {}).flatMap(([agent, items]) => (items || []).map(i => ({ ...i, agent })));
  const attention = (view.attention || []).filter(a => a.ref && Number.isSafeInteger(a.ref.n));
  const ctx = { view, tz, now, today: dayOf(now, tz), queues, attention, planned: Array.isArray(view.planned) ? view.planned : [], ...rankIndex(view) };
  const made = [...(view.issues || []).map(i => issueRow(ctx, i)), ...(view.prs || []).map(p => pullRow(ctx, p))].filter(Boolean);
  const rows = made.map(m => m.row), details = Object.fromEntries(made.map(m => [m.row.key, m.detail]));
  // An issue whose pull request is open waits where the pull request waits: one state per piece of work.
  for (const r of rows) {
    if (r.kind !== 'issue' || r.state !== 'planned' || !OPEN_PR.test(r.reason)) continue;
    const pr = rows.find(x => x.kind === 'pr' && (view.prs || []).find(p => p.number === x.ref)?.issue === r.ref);
    if (pr) r.state = pr.state;
  }
  rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9) || a.ref - b.ref);
  return { rows, details, generatedAt: now, tz };
}
