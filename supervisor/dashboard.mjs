// View model of the team dashboard (issue #32). Pure functions over data the tick already stored: supervisor job records,
// the team state, the GitHub cache and the snapshot history. No GitHub call, no model call, no write.
import { DEFAULT_GBP_PER_USD, formatCost } from './money.mjs';
import fs from 'node:fs';
import { headlineStats } from './headline.mjs';
import { summarize as failCausesOf } from './failcause.mjs';
import { normalize as breakerStateOf, haltView as breakerHaltView, byCause as breakerByCause, COST_LABEL as BREAKER_COST_LABEL } from './breaker.mjs';
import { typeOfKind } from './models.mjs';
import { readStatusIssueState } from './statusissue.mjs';
import path from 'node:path';
import { homeownerQuestion } from './homeowner-question.mjs';
import { stoppedAttention, rearmView, endNote, withEndNote } from './faultview.mjs';
import { keptText, CAUSE_TEXT, Team, overallCap, capNotes, FIX_LIMIT_OPTIONS, CARRIED_HOLD_OPTIONS, ROLES, decisionInfo, INDEPENDENCE_DECISION, agentOfBranch, checksState, retriedIn, waitingOnText, waitingOnRefs, stuckChecks, carryRecordOf, loneCancelled, prerequisites, roleOfType, roleCount } from './team.mjs';
import { transcriptExists } from './transcript.mjs';
import { describeWatch, historyOf, resolve as resolveWatch } from './watchlist.mjs';
import { latchCardText, stopLines } from './latchaction.mjs';
import { STALE_TICK_MS, isUnknownJob, agentStates, latestAllowance, redact, readVersion } from './dashdata.mjs';
import { planningInputs, readHeadRegister } from './planning.mjs';
import { proposalsAdded } from './decisions.mjs';
import { readMigrationState, readIncidents } from './migrations.mjs';
import { STALL_DEFAULT_HOURS } from './stall.mjs';
import { severityOf, tmark } from './dashui/logic.mjs';
import { consolidateNeedsYou } from './needsyou.mjs';
import { collectAssignments, idleRuleText, assignmentFields } from './issueassign.mjs';
import { faultAttention } from './dashassign.mjs';
import { hasReading, windowExpired } from './allowance.mjs';
import { afterInstallAttention, installedPrsOf } from './afterinstall-view.mjs';
import { attentionOverseer, cardOverseer, jobOverseer, supervisorHealth, verdictIndex } from './suphealth.mjs';
import { stageOf, readVerification } from './livechecks.mjs';
import { MODE_LABEL, budgetSettings, DEFAULT_BUDGET } from './budget.mjs';
import { budgetView, usageReading } from './budgetview.mjs';
import { hasProbe } from './probe.mjs';
import { annotateQueues, nextWhyFields } from './holdreason.mjs';
import { hostPressureView } from './hostpressure.mjs';
import { defaultRegistry, processStart } from './core.mjs';
import { estimateQueue } from './estimate.mjs';
import { idleReport } from './idlecause.mjs';
import { wakeView } from './wake.mjs';
import { sinceView } from './since.mjs';
import { decidedCards as decidedInboxCards, approvedItems as approvedInboxItems } from './inbox.mjs';
import { inboxSearchView, inboxView } from './inbox-panel.mjs';
import { describeJob, jobSubject, makeNamer, shortCommit, shortJob } from './naming.mjs';

const sha7 = s => String(s || '').slice(0, 7);
const ACTIVE = ['queued', 'running', 'paused_limit', 'paused_manual'];
// Issue #1103: only what a stopped job reported as open still holds an issue besides its Depends on line.
const reportedWaits = (S, n, byNo, prs) => waitingOnRefs({ body: '' }, byNo, prs, S.waitingOn?.[n]?.items || []);
export const EXHAUSTED = 0.995;       // a window at or above this fraction used counts as exhausted
export const windowLabel = (w, provider) => {
  if (w.type === 'five_hour') return '5-hour';
  if (w.type === 'seven_day') return 'weekly';
  if (w.windowMinutes === 300) return '5-hour';
  if (w.windowMinutes === 10080) return 'weekly';
  return String(w.type || provider).replace(/_/g, ' ');
};

const DEAD = ['rejected', 'blocked', 'exhausted', 'limit_reached'];
const fullWindow = (w, exhaustedAt = EXHAUSTED) => (Number.isFinite(w.utilization) && w.utilization >= exhaustedAt) || DEAD.includes(w.status);
const utcTime = ms => new Date(ms).toISOString().slice(11, 16) + ' UTC';
// "5-hour window 98% used, resets 14:30 UTC (in 1h 5m)": one window in plain words.
const windowPhrase = (w, provider, now) => `${windowLabel(w, provider)} window ${Math.round(w.utilization * 100)}% used${Number.isFinite(w.resetsAt) && w.resetsAt > 0 ? `, resets ${utcTime(w.resetsAt)} (in ${age(w.resetsAt - now)})` : ', reset time not reported'}`;
export const age = ms => { const m = Math.max(0, Math.floor(ms / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`; };
const PREDATES_MS = 2 * 60000;        // a reading this much older than the pause was taken before it
// When the job went into its pause: its own allowance record is written at that moment (even an empty one), else its update.
const pausedAt = job => Math.min(Number.isFinite(job?.allowance?.observedAt) ? job.allowance.observedAt : Infinity, Number.isFinite(job?.updatedAt) ? job.updatedAt : Infinity);

// The last known reading in words, with its age and any expired window (issue #75, #76): "weekly 100%, 5-hour 26%
// (expired: reset 4h 38m ago); reported 8h 17m ago".
export function readingText(allowance, now) {
  if (!hasReading(allowance)) return 'no reading has been reported';
  const parts = allowance.windows.map(w => {
    const used = `${windowLabel(w, allowance.provider)} ${Number.isFinite(w.utilization) ? `${Math.round(w.utilization * 100)}%` : 'unknown'}`;
    return windowExpired(w, now) ? `${used} (expired: reset ${age(now - w.resetsAt)} ago)` : used;
  });
  return `${parts.join(', ')}; reported ${Number.isFinite(allowance.observedAt) && allowance.observedAt > 0 ? `${age(now - allowance.observedAt)} ago` : 'at an unknown time'}`;
}

// The rule behind "a usage pause that disagrees with the provider's own reported allowance".
// Returns null when the pause is consistent or cannot be judged, else a finding. `allowance` is the newest reading the
// provider reported. Expired windows (reset time passed) are evidence of nothing (issue #75). A live full window or an
// exhausted status confirms the pause; a live window below the threshold is evidence of capacity, but only in a reading
// taken at or after the pause: an older reading cannot contradict a limit hit later.
//
// `limits` carries the thresholds Foreman itself uses (budget `exhausted_at` and `high_water`), so the page and the scheduler agree
// on what counts as used up. A live window at or above `high_water` that is not used up is "nearly full": the provider's own pause
// is plausible, so it is described by its limiting window and never called "capacity left" (issue #367).
export function pauseDisagreement(job, allowance, now, limits = {}) {
  const exhaustedAt = limits.exhaustedAt ?? EXHAUSTED, nearlyFull = limits.nearlyFull ?? DEFAULT_BUDGET.high_water;
  if (!job || job.status !== 'paused_limit' || job.lastEvent !== 'usage_limit') return null;
  if (!hasReading(allowance)) return { kind: 'unverifiable', text: 'paused on a usage limit but the provider has reported no allowance data to confirm it' };
  const last = `last reading: ${readingText(allowance, now)}`;
  const full = allowance.windows.filter(w => fullWindow(w, exhaustedAt));
  if (full.some(w => !windowExpired(w, now))) return null;
  if (full.length) {
    const reset = Math.max(...full.map(w => w.resetsAt));
    return { kind: 'expired', text: `paused on a usage limit, but the full ${full.map(w => windowLabel(w, allowance.provider)).join(' and ')} window reset ${age(now - reset)} ago, so the limit may be over (${last})` };
  }
  const live = allowance.windows.filter(w => !windowExpired(w, now));
  // Same exhausted-status semantics as limitFromAllowance(): a rejected/blocked/exhausted allowance confirms the pause,
  // unless every window of that reading has since reset.
  if (DEAD.includes(allowance.status) && live.length) return null;
  if (!live.length) return { kind: 'expired', text: `paused on a usage limit; every window in the last reading has reset since, so it cannot confirm the pause (${last})` };
  const known = live.filter(w => Number.isFinite(w.utilization));
  if (!known.length) return { kind: 'unverifiable', text: `paused on a usage limit but the reported allowance has no utilisation figures to confirm it (${last})` };
  if ((allowance.observedAt || 0) < pausedAt(job) - PREDATES_MS) return { kind: 'unverifiable', text: `paused on a usage limit; the newest provider reading is older than the pause, so it cannot confirm it (${last})` };
  const limiting = [...known].sort((a, b) => b.utilization - a.utilization)[0];
  if (limiting.utilization >= nearlyFull) return { kind: 'nearly_full', window: limiting, text: `paused on a usage limit; the limiting window is nearly full: ${windowPhrase(limiting, allowance.provider, now)}, so the pause is plausible` };
  const used = known.map(w => `${windowLabel(w, allowance.provider)} ${Math.round(w.utilization * 100)}%`).join(', ');
  const at = allowance.observedAt ? ` (reported ${tmark(allowance.observedAt)})` : '';
  return { kind: 'disagrees', text: `paused on a usage limit but no window is near its limit: ${used} used; highest is ${windowPhrase(limiting, allowance.provider, now)}${at}` };
}

// What the Usage card says about a limit pause: when the limit resets and on what basis. Never an invented time.
function limitView(job, allowance, now) {
  const top = (allowance?.windows || []).filter(w => !windowExpired(w, now) && Number.isFinite(w.utilization)).sort((a, b) => b.utilization - a.utilization)[0];
  const limiting = top ? windowPhrase(top, allowance.provider, now) : null;   // the window nearest its limit, in words (issue #367)
  if (job.resetAt) return { limiting, since: pausedAt(job), resetsAt: job.resetAt, basis: 'reported with the limit', retryAt: job.nextAttemptAt || null };
  const full = (allowance?.windows || []).filter(w => fullWindow(w) && !windowExpired(w, now) && Number.isFinite(w.resetsAt));
  const w = full.sort((a, b) => b.resetsAt - a.resetsAt)[0];
  return { limiting, since: Number.isFinite(pausedAt(job)) ? pausedAt(job) : null, resetsAt: w ? w.resetsAt : null, basis: w ? `${windowLabel(w, allowance.provider)} window in the last reading` : null, retryAt: job.nextAttemptAt || null };
}

function cacheBackedTeam(config, root, cache, jobs, state, snapshots = [], now = Date.now(), events = [], register = '', tz = undefined) {
  const gh = { listPulls: async () => cache.pulls || [], listIssues: async () => (cache.issues || []).map(i => ({ ...i, labels: i.labels || [] })),
    // delivered-work issue numbers the tick cached, in the shape Team.plan() reads, so the page matches `team tick --dry-run`
    // plus every merged PR number the tick saw, so a follow-up waiting on a merged PR is not mistaken for one closed unmerged (issue #212)
    listMergedPulls: async () => [{ headRefName: '', closingIssuesReferences: (cache.delivered || []).map(number => ({ number })) }, ...[...new Set([...(cache.mergedNumbers || []), ...(cache.merged || []).map(m => m.number)])].filter(Number.isSafeInteger).map(number => ({ number, headRefName: '', closingIssuesReferences: [] }))] };
  gh.listPullFiles = async n => { const f = cache.pullFiles?.[n]; if (f === null) throw new Error('file list unreadable'); return f || []; };   // the tick's file lists
  const jobsApi = { listActive: async () => jobs.filter(j => ACTIVE.includes(j.status)).map(j => ({ id: j.id, provider: j.provider, status: j.status })) };
  // The same planning inputs as the tick (issues #56, #121): probes included, so the page shows the allowance modes, holds and
  // reassignments `team tick --dry-run` would.
  const { allowanceOf, limitedOf, usage } = planningInputs({ config, jobs, probes: cache.probes, snapshots, events, now });
  const team = new Team({ config, root, gh, jobs: jobsApi, git: null, register, allowanceOf, limitedOf, usage, clock: { now: () => now }, timeZone: tz });
  team.s = { ...team.s, ...state }; team.dependencies = Team.dependencyTools.fromPlain(cache.dependencies); // the state the caller read
  team.depFromCache = !!team.dependencies;   // issue #1103: without tick data plan() works it out from the issues it was given
  for (const k of ['verdicts', 'jobs', 'fixAttempts', 'continueAttempts', 'reviewAttempts', 'reviewRefusals', 'notified', 'posted', 'merged', 'implemented', 'budget', 'rebaseAttempts', 'escalations', 'unusable', 'unblock', 'refusedReviews']) team.s[k] ||= {};
  for (const k of ['pr', 'day', 'limit', 'flags', 'resumed', 'escalated', 'queued']) team.s.unblock[k] ||= {};
  team.s.unblock.log ||= [];
  return team;
}

function reasons(team, cache, jobs, plan, states, names, now = Date.now()) {
  const c = team.c, S = team.s, prs = cache.pulls || [], issues = cache.issues || [];
  const byNo = new Map(issues.map(i => [i.number, i]));
  const planned = new Set(plan.map(a => `${a.agent}:${a.type}:${a.issue ?? a.pr}`));
  const queues = Object.fromEntries(Object.keys(c.agents).map(n => [n, []]));
  const activeJobs = jobs.filter(j => ACTIVE.includes(j.status));
  const busy = agent => states[agent].state !== 'idle' && states[agent].state !== 'blocked';
  const label = pr => names.pr(pr.number).text;
  const noReviewer = new Map(team.unreviewable(prs).map(u => [u.pr, u.reasons.join('; ')]));   // issue #258: each agent's real reason
  const titleOfPr = pr => names.titleOf(names.issueOfPr(pr.number)?.number) ?? pr.title;   // the issue's title, not the pull request's
  for (const pr of prs) {
    const author = agentOfBranch(c, pr.headRefName);
    const key = `${pr.number}:${pr.headRefOid}`;
    const v = S.verdicts?.[key];
    const checks = team.ciState(pr);
    if (!author) continue;
    let reason;
    if (pr.isDraft) reason = planned.has(`${author}:continue:${pr.number}`) ? 'draft; the agent continues it next' : (S.continueAttempts?.[pr.number] || 0) >= c.limits.max_fix_attempts ? 'draft; continue limit reached, needs the homeowner' : 'draft';
    else if (team.carryPending(pr)) reason = 'the rebase carry is waiting for CI; no review starts for this head until it is recorded or refused';
    else if (checks === 'pending') reason = waitingOnText(pr.statusCheckRollup, now);
    else if (checks === 'red') reason = 'CI failing';
    else if (checks === 'none') reason = 'no CI checks reported';
    else if (!v && team.reReviewOf?.(pr.number, pr.headRefOid)?.status === 'pending') reason = `re-review requested by the homeowner (decision ${team.reReviewOf(pr.number, pr.headRefOid).decision}); waiting for a reviewer on a different model for ${sha7(pr.headRefOid)}`;
    else if (v?.verdict === 'CHANGES' && team.reReviewOf?.(pr.number, pr.headRefOid)?.status === 'done') reason = `the requested re-review (decision ${team.reReviewOf(pr.number, pr.headRefOid).decision}) also gave CHANGES from ${v.reviewer} on ${sha7(pr.headRefOid)}; waiting for the homeowner`;
    else if (v?.verdict === 'CHANGES') reason = `CHANGES from ${v.reviewer} on ${sha7(pr.headRefOid)}; ${team.fixCount(pr.number) >= c.limits.max_fix_attempts && !planned.has(`${author}:fix:${pr.number}`) && !team.escalationPending(pr.number, pr) ? `fix limit reached (${c.limits.max_fix_attempts} rounds): Foreman has stopped fixing this PR and needs the homeowner` : `fix ${planned.has(`${author}:fix:${pr.number}`) ? 'is next' : 'waits for a free slot'}`}`;
    else if (v?.verdict === 'PASS' && v.carriedFrom && !team.carryOk(v, pr)) reason = `PASS carried from ${sha7(v.carriedFrom)} but its record does not match this head; not merged`;
    else if (v?.verdict === 'PASS') reason = pr.mergeable === 'MERGEABLE' ? (c.second_opinion && team.secondOpinionPending(pr) ? `PASS from ${v.reviewer}; ${team.secondOpinionWaitText(pr) || 'waiting for the second-opinion review'}` : `PASS from ${v.reviewer}${v.carry ? ` (${carryText(v.carry)})` : ''}; merges on the next tick`) : `PASS from ${v.reviewer} but not mergeable (${String(pr.mergeable || 'unknown').toLowerCase()})`;
    else reason = `waiting for a reviewer on a different model: review of ${sha7(pr.headRefOid)}${noReviewer.get(pr.number) ? `; no reviewer can take it: ${noReviewer.get(pr.number)}` : ''}`;
    queues[author].push({ type: 'pr', ref: pr.number, title: titleOfPr(pr), reason, next: planned.has(`${author}:fix:${pr.number}`) || planned.has(`${author}:continue:${pr.number}`), url: pr.url });
    if (!pr.isDraft && checks === 'green' && !v && !team.carryPending(pr)) for (const reviewer of Object.keys(c.agents).filter(n => !team.reviewRefusal(n, pr, `${key}:${n}`))) {   // agents whose review model is not a model that wrote the head
      const isNext = planned.has(`${reviewer}:review:${pr.number}`);
      const attempts = S.reviewAttempts?.[`${key}:${reviewer}`] || 0;
      queues[reviewer].push({ type: 'review', ref: pr.number, title: titleOfPr(pr), reason: `review ${label(pr)} at ${sha7(pr.headRefOid)}${isNext ? ' (next)' : attempts >= c.limits.max_review_attempts ? ' (attempt limit reached)' : (team.heldPr?.[`${reviewer}:review:${pr.number}`] || team.held?.[reviewer]?.review) ? ` (held: ${team.heldPr?.[`${reviewer}:review:${pr.number}`] || team.held[reviewer].review})` : busy(reviewer) ? ' (after the running job)' : ''}`, next: isNext, url: pr.url });
    }
  }
  for (const [agent, a] of Object.entries(c.agents)) for (const n of a.issues) {
    const issue = byNo.get(n);
    if (!issue || issue.state !== 'OPEN' || team.delivered?.has(n)) continue;
    const prOf = prs.find(p => agentOfBranch(c, p.headRefName) && new RegExp(`/issue-${n}(\\D|$)`).test(p.headRefName));
    const hasPr = !!prOf && agentOfBranch(c, prOf.headRefName) === agent;
    const taker = plan.find(x => x.type === 'implement' && x.issue === n && x.reassignedFrom === agent);
    const moved = Object.values(S.jobs || {}).find(j => j.kind === 'implement' && j.issue === n && j.reassignedFrom === agent);
    const mode = team.modes?.[agent];
    const running = activeJobs.some(j => ['implement', 'continue'].includes(j.kind) && j.issue === n);
    let reason, waits, dep = Team.dependencyTools.exclusion(team, n)?.text;   // issue #1103
    if (dep) reason = dep; else if (issue.labels.includes('needs-homeowner')) reason = 'needs the homeowner';
    else if ((waits = reportedWaits(S, n, byNo, prs)).length) reason = `waiting on ${waits.map(d => names.issue(d).text).join(', ')}`;   // issue #1023
    else if (running) reason = 'being implemented now';
    else if (hasPr) reason = 'PR open';
    else if (prOf || moved) reason = `reassigned for allowance to ${moved?.agent || agentOfBranch(c, prOf.headRefName)}${prOf ? `; ${names.pr(prOf.number).text} open` : ''}`;
    else if (team.staleText?.(n)) reason = team.staleText(n);
    else if (S.implemented?.[n]) reason = 'started earlier; no PR yet';
    else if (taker) reason = `next: reassigned for allowance from ${agent} to ${taker.agent}: ${agent} has no allowance${untilText(team.ownerOut(agent)?.until, team)} (${taker.agent} takes it; ${agent} keeps ownership)`;
    else if (planned.has(`${agent}:implement:${n}`)) reason = 'next: implement';
    else if (mode && mode.mode !== 'normal') reason = `waits: ${agent} is ${MODE_LABEL[mode.mode]} (${mode.reason}); no agent with headroom can take it`;
    else if (team.held?.[agent]?.implement) reason = `waits: ${team.held[agent].implement}`;
    else if (busy(agent)) reason = 'ready; waits behind the running job';
    else { const ahead = plan.find(x => x.agent === agent); reason = ahead ? `ready; waits behind ${ahead.type} ${['implement', 'continue'].includes(ahead.type) ? names.issue(ahead.issue).text : names.pr(ahead.pr).text}` : 'ready; waits for a free slot'; }
    queues[agent].push({ type: 'issue', ref: n, title: issue.title, reason, next: planned.has(`${agent}:implement:${n}`) });
  }
  // Issue #971: an approved prompt waits in the inbox lane, shown in the queue of the agent the planner picked (the first agent when none).
  const inboxDir = c.inbox?.dir, inboxPlan = plan.find(a => a.type === 'inbox');
  if (inboxDir) for (const st of approvedInboxItems(inboxDir, 'prompt')) {
    if (Object.values(S.jobs).some(j => j.inboxId === st.id)) continue;
    const owner = inboxPlan && queues[inboxPlan.agent] ? inboxPlan.agent : Object.keys(queues)[0]; if (!owner) continue;
    queues[owner].push({ type: 'inbox', ref: 0, title: st.title || 'approved prompt', reason: `approved prompt in the inbox lane${inboxPlan?.inboxId === st.id ? ' (starts this tick)' : ' (waits for the inbox slot)'}; waited ${Math.max(0, Math.round((now - (st.decidedAt || now)) / 1000))} s`, next: inboxPlan?.inboxId === st.id });
  }
  // Issue #405: reviews are listed in the order the planner takes them (closest to merge, then age), with the reason.
  for (const [reviewer, q] of Object.entries(queues)) {
    const order = new Map(team.reviewQueue(reviewer, prs).map(r => [r.pr.number, r]));
    for (const e of q) { const o = e.type === 'review' ? order.get(e.ref) : null; if (o) { e.order = o.position; e.reason += ` [review order ${o.position} of ${o.of}: ${o.reason}]`; } }
  }
  for (const q of Object.values(queues)) q.sort((x, y) => (y.next - x.next) || (x.type === 'review' && y.type === 'review' && x.order && y.order ? x.order - y.order : x.ref - y.ref));
  return annotateQueues(team, queues);
}

// Why an idle agent is idle, in plain words (issue #50). Homeowner waits first, then what is in flight, then drafts, then blocked issues.
// Returns { text, links } where links are { text, url } for the PRs and issues named; null when the agent is not idle or has a planned job.
export function idleReason({ agent, config, team, cache, plan, state, now = Date.now(), hold = null, names = makeNamer({ repo: config.repository, issues: cache.issues, pulls: cache.pulls, merged: cache.merged }) }) {
  if (state !== 'idle') return null;
  if (config.enabled === false) return { text: 'the team loop is switched off', links: [] };
  const next = plan.find(a => a.agent === agent);
  // Issue #487: name the hold from the last tick's record for this agent; "on the next tick" only when no hold applied to it.
  const held = team.hostHolds?.[agent] ?? (hold?.cause === 'upgrade' ? 'an install is in progress' : hold?.cause === 'named-hold' ? hold.hold : null);   // issue #1151: the host's reason first
  if (next) return { text: `about to start ${next.type === 'cifix' ? 'fix CI on' : next.type} ${['implement', 'continue'].includes(next.type) ? names.issue(next.issue).text : names.pr(next.pr).text} ${held ? `once the hold clears; held: ${held}` : 'on the next tick'}`, links: [] };
  // A slot or cap hold stops the planner too, so the live plan has no work for this agent: name the hold anyway.
  if (held) return { text: `held: ${held}`, links: [] };
  const c = team.c, a = c.agents[agent], L = c.limits, S = team.s, prs = cache.pulls || [], issues = cache.issues || [];
  const byNo = new Map(issues.map(i => [i.number, i]));
  const url = (kind, n) => `https://github.com/${config.repository}/${kind}/${n}`;
  const parts = [], links = [];
  const m = team.modes?.[agent];
  if (m && m.mode !== 'normal') parts.push({ rank: 0, text: `${MODE_LABEL[m.mode]}: ${m.reason}` });
  const part = (rank, text, kind, n) => { parts.push({ rank, text }); links.push({ text: (kind === 'pull' ? names.pr(n) : names.issue(n)).text, url: url(kind, n) }); };
  const mine = prs.filter(p => agentOfBranch(c, p.headRefName) === agent);
  for (const p of mine) {
    const v = S.verdicts?.[`${p.number}:${p.headRefOid}`], checks = team.ciState(p);
    if (p.isDraft) {
      if ((S.continueAttempts?.[p.number] || 0) >= L.max_fix_attempts) part(0, `waiting for homeowner: continue limit reached on draft ${names.pr(p.number).text}`, 'pull', p.number);
      else part(2, `only work is draft ${names.pr(p.number).text}`, 'pull', p.number);
    } else if (!v && team.reReviewOf?.(p.number, p.headRefOid)?.status === 'pending') part(1, `waiting for the re-review the homeowner requested of ${names.pr(p.number).text}`, 'pull', p.number);
    else if ((v?.verdict === 'CHANGES' || checks === 'red') && team.fixCount(p.number) >= L.max_fix_attempts) {
      if (team.escalationPending(p.number, p)) part(1, `fix limit reached on ${names.pr(p.number).text}: final round pending`, 'pull', p.number);
      else part(0, `waiting for homeowner: fix limit reached on ${names.pr(p.number).text}`, 'pull', p.number);
    }
    else if (p.mergeable === 'CONFLICTING') part(1, `waiting to rebase ${names.pr(p.number).text}`, 'pull', p.number);
    else if (checks === 'pending') part(1, waitingOnText(p.statusCheckRollup, now).replace('waiting on CI', () => 'waiting on CI for ' + names.pr(p.number).text), 'pull', p.number);
    else if (v?.verdict === 'PASS') part(1, `${names.pr(p.number).text} has a PASS and merges on the next tick`, 'pull', p.number);
    else part(1, `waiting for review of ${names.pr(p.number).text}`, 'pull', p.number);
  }
  const blockers = new Set();
  let openIssues = 0;
  for (const n of a.issues) {
    const issue = byNo.get(n);
    if (!issue || issue.state !== 'OPEN' || team.delivered?.has(n)) continue;
    if (issue.labels.includes('needs-homeowner')) { part(0, `waiting for homeowner: ${names.issue(n).text} needs the homeowner`, 'issue', n); continue; }
    if (mine.some(p => new RegExp(`/issue-${n}(\\D|$)`).test(p.headRefName))) continue;
    openIssues++;
    (Team.dependencyTools.exclusion(team, n)?.refs || []).forEach(d => blockers.add(d));   // issue #1103: the Depends on line
  }
  if (openIssues && blockers.size) { parts.push({ rank: 3, text: `all issues blocked by ${[...blockers].sort((x, y) => x - y).map(d => names.issue(d).text).join(', ')}` }); for (const d of blockers) links.push({ text: names.issue(d).text, url: url('issues', d) }); }
  else if (openIssues && !(m && m.mode !== 'normal')) parts.push({ rank: 3, text: idleRuleText(agent, a.issues.length, team.assignments) });   // issue #1121
  if (!parts.length) return { text: idleRuleText(agent, a.issues.length, team.assignments), links: [] };
  parts.sort((x, y) => x.rank - y.rank);
  return { text: parts.slice(0, 3).map(x => x.text).join('; '), links: links.slice(0, 6) };
}

// Issue #141: a Needs you card says what happened (text), what Foreman tried, the one action needed and where to look.
// x = { tried, action, links: [{ text, url }] }. Same shape as the event-log cards of #100/#106 will use.
const cleanLinks = links => (links || []).filter(l => l && typeof l.url === 'string').slice(0, 6).map(l => ({ text: redact(String(l.text), 140), url: l.url }));
// Issue #296: one line for a carried verdict: old head, new head and the evidence it was carried on.
// Issue #804: the second opinions recorded for a PR (one per pr:head); a carried one (D-025) is an avoided review, not a review.
const secondOpinionsOf = (state, n) => Object.entries(state.secondOpinions || {}).filter(([k]) => k.startsWith(`${n}:`)).map(([, v]) => v);
export const carryText = c => `carried from ${sha7(c.oldHead)} to ${sha7(c.newHead)} over a clean rebase: ${c.evidence?.resolvedConflicts === false ? 'no conflict resolved' : 'conflict check not met'}, ${c.evidence?.patchUnchanged === true ? 'patch unchanged' : 'patch not shown unchanged'}, CI ${c.evidence?.ci || 'unknown'}`;
// Issue #303: proposals that open pull requests add to the register and that main does not have yet. Never throws: an unreadable head adds none.
export function pendingProposals(config, pulls, mainRegister, read = readHeadRegister) {
  const out = [];
  for (const p of pulls || []) {
    if (p.isDraft) continue;
    let text = ''; try { text = read(config, p) || ''; } catch { text = ''; }
    for (const e of proposalsAdded(mainRegister, text)) out.push({ ...e, pr: p.number });
  }
  return out;
}
// Issue #414: where a held issue is listed. 'needs': a question the homeowner can answer today. 'later': parked or staged work, with what it waits
// for and who or what ends the wait. Foreman applied the label only when state or the issue's own marker says so (stock text only then).
const foremanApplied = (i, state) => Object.keys(state.unblock?.flags?.[i.number] || {}).length > 0 || !!state.splits?.[i.number] || i.foremanFiled === true;
export function heldIssues({ cache, state = {}, splitting = new Set(), pauseText = null, config = {} }) {
  const byNo = new Map((cache?.issues || []).map(i => [i.number, i])), out = [];
  for (const i of (cache?.issues || []).slice().sort((x, y) => x.number - y.number)) {
    const labels = i.labels || [], parked = labels.includes('parked'), held = labels.includes('needs-homeowner');
    if (i.state !== 'OPEN' || (!parked && !held) || splitting.has(i.number)) continue;
    const eligible = !['epic', 'tracking', 'parked'].some(l => labels.includes(l));
    const starts = held && !parked ? ` Removing the needs-homeowner label ${eligible ? 'makes the issue eligible for Foreman to start, so remove it only when you want work to begin.' : 'does not start work: another label keeps it out of the plan.'}` : '';
    if (parked) { out.push({ number: i.number, where: 'later', waits: 'parked: held back on purpose', ends: 'the homeowner removing the parked label; Foreman then treats it as eligible unless it waits on something else' }); continue; }
    const flags = Object.entries(state.unblock?.flags?.[i.number] || {}), applied = foremanApplied(i, state);
    const q = i.question ?? homeownerQuestion(i.body);
    if (q && !(q.yes && q.no)) {
      out.push({ number: i.number, where: 'later', waits: `labelled needs-homeowner; the issue asks "${q.question}" but does not state what each answer does (a Yes: and a No: effect)`, ends: `someone adding the Yes: and No: effects to the question on the issue, which moves it to Needs you; removing the label ${eligible ? 'would make it eligible for Foreman to start' : 'would not start work'}` });
      continue;
    }
    if (q) {
      out.push({ number: i.number, where: 'needs', question: q.question, tried: applied ? 'Foreman labelled this issue needs-homeowner and starts no new job on it while the label is on.' : 'Labelled needs-homeowner; no record of who applied it.',
        action: `Answer on the issue. Yes: ${q.yes} No: ${q.no}${starts}` });
      continue;
    }
    if (flags.length && i.state === 'OPEN') {
      const why = flags.map(([k, c]) => c.kind || k).filter((v, n, a2) => a2.indexOf(v) === n), clears = why.map(k => CAUSE_TEXT[k] || k).join('; ');
      out.push({ number: i.number, where: 'needs', question: `Foreman stopped work (${why.join(', ')}): fix the cause or close the issue?`, tried: 'Foreman applied the needs-homeowner label and starts no new job on this issue while it is on.',
        action: `Fix the cause: Foreman removes the label itself once ${clears}. Close the issue instead: no further work.` });
      continue;
    }
    if (i.foremanFiled) {
      out.push({ number: i.number, where: 'needs', question: 'Do the blocking findings listed on this issue need a fix?', tried: 'Foreman filed this issue from a review of a merged PR and labelled it needs-homeowner.',
        action: `Yes: ask for a fix PR. No: close the issue.${starts}` });
      continue;
    }
    const open = (i.prerequisites || []).filter(d => byNo.get(d)?.state !== 'CLOSED');
    if (open.length) out.push({ number: i.number, where: 'later', waits: `waits for ${open.map(d => '#' + d).join(', ')} to close`, ends: `#${open.join(', #')} closing (a merged PR closes it); no decision is needed from you before then` });
    else if (pauseText) out.push({ number: i.number, where: 'later', waits: `waits for the open PR backlog to clear (${pauseText})`, ends: 'PRs merging until open PRs fall below the cap; Foreman ends the wait, no decision is needed from you before then' });
    else out.push({ number: i.number, where: 'later', waits: 'labelled needs-homeowner; no question is stated on the issue and no record shows who applied the label', ends: 'someone stating the question on the issue (a line "Question: ...?"), or the label being removed (which would make it eligible for Foreman to start)' });
  }
  return out;
}
function attentionItems({ config, cache, jobs, states, plan, snapshots, now, allowance, teamEnabled, state = {}, limits = {}, names, gated = null, unreviewed = [], escalating = new Set(), held = new Set(), withheld = new Map(), proposals = [], fixCount, pauseText = null }) {
  const planName = a => (['implement', 'continue'].includes(a.type) ? names.issue(a.issue ?? a.ref) : names.pr(a.pr ?? a.ref)).text;
  const items = [], add = (id, text, ref, x = {}) => items.push({ id, text: redact(text, 300), ref: ref || null, ...(x.tried ? { tried: redact(x.tried, 300) } : {}), ...(x.action ? { action: redact(x.action, 300) } : {}), ...(x.links?.length ? { links: cleanLinks(x.links) } : {}), ...(Number.isFinite(x.since) ? { since: x.since } : {}) });
  const web = (kind, n) => `https://github.com/${config.repository}/${kind === 'pull' ? 'pull' : 'issues'}/${n}`;
  const heldJobs = n => Object.values(state.unblock?.flags?.[n] || {}).filter(x => x.kind === 'job').map(x => x.job);   // issue #583: jobs holding the label
  // Issue #610: `resume` refuses a stopped job, so the card offers the command only for held jobs that can be resumed (an unknown job keeps it).
  const resumeHint = n => { const ids = heldJobs(n).filter(id => ![...jobs].find(j => j.id === id && j.status === 'stopped')); return ids.length ? `To clear it now: ${ids.map(id => `ai-agent --supervisor resume ${id}`).join(' or ')} (uses allowance), or ` : 'A stopped job cannot be resumed. To clear it now: '; };
  const prCarded = new Set();   // PRs that already have a limit or needs-homeowner card; a failed job on one folds into it
  const openPulls = new Set((cache?.pulls || []).map(p => p.number));
  const fixLimited = new Set();
  const t = cache?.tick;
  if (!t) add('no-tick', 'No tick has ever been recorded: the dispatcher has not run since the dashboard was installed.');
  else {
    if (t.status === 'error') add('tick-failed', `Last tick failed at ${tmark(t.at)}: ${t.error || 'no detail recorded'}`);
    // Issue #881: a GitHub rate limit pauses project board moves; it is a notice, not a failed tick.
    if (Number.isFinite(state.board?.pausedUntil) && state.board.pausedUntil > now) add('board-paused', `Board updates paused until ${tmark(state.board.pausedUntil)} (GitHub rate limit); ${Object.keys(state.board.pending || {}).length} move(s) will be applied afterwards.`);
    if (teamEnabled !== false && t.status !== 'disabled' && now - t.at > STALE_TICK_MS) add('tick-stale', `No tick for ${Math.round((now - t.at) / 60000)} minutes (last ${tmark(t.at)}); the reconcile cron may have stopped.`);
  }
  const maxFix = limits.max_fix_attempts, maxReview = limits.max_review_attempts;
  // Issue #244: an implement job that ran out of context is not restarted; its proposed split is the one decision needed.
  const splitting = new Set(Object.entries(state.splits || {}).filter(([, sp]) => ['drafting', 'proposed'].includes(sp.status)).map(([n]) => Number(n)));
  const splitJobs = new Set(Object.values(state.splits || {}).map(sp => sp.implementJob));
  for (const [n, sp] of Object.entries(state.splits || {})) if (sp.status === 'proposed' && (cache?.issues || []).some(i => i.number === Number(n) && i.state === 'OPEN')) {
    const spent = sp.wasted?.tokens ? `${sp.wasted.tokens.toLocaleString('en-GB')} tokens${Number.isFinite(sp.wasted.cost) ? ` (about ${formatCost(sp.wasted.cost)})` : ''} spent on the failed attempt` : 'the failed attempt used an unknown number of tokens';
    add(`split-${n}`, `${names.issue(Number(n)).text} was too large for one session; a split into ${sp.children?.length || 0} issues is proposed`, { kind: 'issue', n: Number(n) },
      { tried: `The implement job ran out of context (${spent}). Foreman did not restart it with the same scope; a cheap session drafted the split and posted it on the issue.`, action: `Accept split: run ai-agent --supervisor team accept-split ${n} to file the children and queue them, or reshape the issue by hand (removing the needs-homeowner label then makes the issue eligible for Foreman to start).`, links: [{ text: names.issue(Number(n)).text, url: web('issue', n) }] });
  }
  // Issue #414: Needs you holds only labelled issues with a question the homeowner can answer today; the rest are in Later (laterOf).
  for (const h of heldIssues({ cache, state, splitting, pauseText, config })) if (h.where === 'needs') add(`homeowner-${h.number}`, `${names.issue(h.number).text}: ${h.question}`, { kind: 'issue', n: h.number },
    { tried: h.tried, action: h.action, links: [{ text: names.issue(h.number).text, url: web('issue', h.number) }] });
  // One card per open PR that is labelled needs-homeowner or has hit the fix or review limit (the label and the notice are the same event).
  for (const pr of cache?.pulls || []) {
    const verdict = state.verdicts?.[`${pr.number}:${pr.headRefOid}`]?.verdict;
    const fixes = fixCount(pr.number);
    // Attempts are counted when a job is created, so the limit cards wait until the last such job has finished.
    const activeKinds = new Set([...jobs].filter(j => j.issue === pr.number && ACTIVE.includes(j.status)).map(j => j.kind));
    const rejected = verdict === 'CHANGES' || checksState(pr.statusCheckRollup, retriedIn(state.cancelWatch, pr, now)) === 'red';
    const fixLimit = !pr.isDraft && Number.isFinite(maxFix) && fixes >= maxFix && rejected && !['fix', 'cifix', 'rebase'].some(k => activeKinds.has(k));
    const reviewLimit = !pr.isDraft && Number.isFinite(maxReview) && !verdict && !activeKinds.has('review') && Object.entries(state.reviewAttempts || {}).some(([k, v]) => k.startsWith(`${pr.number}:${pr.headRefOid}:`) && v >= maxReview);
    // Issue #405: the label alone is not a decision. A PR that reached the fix limit earlier but now has a new head with no verdict, passing or
    // pending CI and no CHANGES is only awaiting review: it is queued (see the review order), not Needs you.
    const awaiting = !pr.isDraft && Number.isFinite(maxFix) && fixes >= maxFix && !verdict && !fixLimit && !reviewLimit && checksState(pr.statusCheckRollup, retriedIn(state.cancelWatch, pr, now)) !== 'red';
    const labelled = pr.labels?.includes('needs-homeowner') && !awaiting;
    const refusal = !verdict && !activeKinds.has('review') ? Object.values(state.reviewRefusals || {}).find(r => r && r.pr === pr.number && r.head === pr.headRefOid) : null;
    if (!fixLimit && !reviewLimit && !labelled) continue;
    if (fixLimit) fixLimited.add(pr.number);
    // Issue #211: the dispatcher already has a next step (one final fix round), so nothing is asked of the homeowner yet.
    if (fixLimit && escalating.has(pr.number) && !labelled) {
      add(`escalating-${pr.number}`, `${names.pr(pr.number).text} is still rejected after ${fixes} fix rounds (limit ${maxFix}). Foreman is handling: one final fix round, a fresh session on the same model with the full review history, no action needed`, { kind: 'pull', n: pr.number },
        { tried: 'Foreman escalates once before it asks the homeowner; it asks only if that round fails.', links: [{ text: names.pr(pr.number).text, url: web('pull', pr.number) }] });
      continue;
    }
    prCarded.add(pr.number);
    const links = [{ text: names.pr(pr.number).text, url: web('pull', pr.number) }, ...[...jobs].filter(j => j.issue === pr.number && ['fix', 'cifix', 'rebase', 'review'].includes(j.kind)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 2).map(j => ({ text: names.job(j).text, url: names.job(j).url }))];
    if (fixLimit) add(`fixlimit-${pr.number}`, `${names.pr(pr.number).text} is still rejected after ${fixes} fix rounds (limit ${maxFix})`, { kind: 'pull', n: pr.number },
      { tried: `${fixes} fix round${fixes === 1 ? '' : 's'} on this PR; ${verdict === 'CHANGES' ? 'the reviewer still asks for changes' : 'CI is still red'}. Foreman starts no further fix jobs and posted a needs-homeowner notice on the PR.${held.has(pr.number) ? ' The CHANGES verdict was carried across a rebase and no fix commit has answered it, so the PR is held from rebase and review until you decide.' : ''} Each round was a fresh session on the same model; the final round could split out-of-scope findings. Foreman never moves a fix to a stronger model.${withheld.get(pr.number) ? ` No further round can run because ${withheld.get(pr.number)}.` : ''}`, action: held.has(pr.number) ? `Choose one: ${CARRIED_HOLD_OPTIONS}. The hold ends on a new head, a raised max_fix_attempts, a closed PR or a requested re-review; removing the needs-homeowner label does not release it.` : `Choose one: ${FIX_LIMIT_OPTIONS}. Remove the needs-homeowner label when done.`, links });
    else if (refusal) add(`reviewrefused-${pr.number}`, `${names.pr(pr.number).text}: the review's verdict file was refused (${refusal.error})${reviewLimit ? `, and the review limit of ${maxReview} attempts is reached` : ''}`, { kind: 'pull', n: pr.number },
      { tried: `A review job finished without a valid verdict file (${refusal.count} time${refusal.count === 1 ? '' : 's'} at this head), so no verdict reached GitHub. The reason: ${refusal.error}. The refused file is ${refusal.file}. A refused file records no verdict, so it does not use up the review attempts unless the refusals pass the review limit.`, action: `Read the verdict file and the review job ${String(refusal.job).slice(0, 8)} output, then review the PR by hand or push a new head to start a fresh review; remove the needs-homeowner label when done.`, links });
    else if (reviewLimit) add(`reviewlimit-${pr.number}`, `${names.pr(pr.number).text} could not be reviewed within ${maxReview} attempts`, { kind: 'pull', n: pr.number },
      { tried: `Review jobs ran ${maxReview} times at this head without recording a verdict, so Foreman stopped reviewing it.`, action: 'Read the review job output, then review the PR by hand or push a new head to start a fresh review.', links });
    else add(`homeowner-pr-${pr.number}`, `${names.pr(pr.number).text} needs the homeowner`, { kind: 'pull', n: pr.number },
      { tried: heldJobs(pr.number).length ? `Foreman labelled this PR needs-homeowner because ${heldJobs(pr.number).map(id => `job ${String(id).slice(0, 8)}`).join(' and ')} stopped (blocked, failed or stopped) and holds the label.` : 'Foreman labelled this PR needs-homeowner and posted the reason as a notice on it.',
        action: heldJobs(pr.number).length ? `The label clears by itself once ${heldJobs(pr.number).length === 1 ? 'that job is' : 'those jobs are'} resumed, or once the PR head has moved past the job's head and the job's worktree has no uncommitted or unpushed work. ${resumeHint(pr.number)}inspect the job's worktree and push or discard its work; Foreman then removes the label. Otherwise remove the needs-homeowner label by hand when it is handled.` : 'Read the notice on the PR and decide; remove the needs-homeowner label when it is handled.', links });
  }
  // Issue #249: an unapproved decision that holds green, passed PRs back is one item naming it, what it unblocks and how to approve.
  if (gated?.prs.length && gated.info?.status === 'agent-proposal') {
    const { info, prs } = gated, n = prs.length;
    add(`decision-${info.id}`, `${info.id} (${info.title}) is not approved and holds ${n} reviewed PR${n === 1 ? '' : 's'} back from merging: ${prs.map(p => names.pr(p.number).text).join(', ')}`, null,
      { tried: `${info.summary} Each has an independent PASS, green checks and no conflict, but merges only once the register says homeowner-approved.`, action: `To approve, edit docs/DECISIONS.md on main so the ${info.id} entry reads "Status: homeowner-approved".`, links: prs.slice(0, 6).map(p => ({ text: names.pr(p.number).text, url: web('pull', p.number) })) });
  }
  // Issue #303: one item per decision proposal awaiting the homeowner's sign-off, naming the entry and the pull request that adds it.
  for (const p of proposals) add(`decision-proposal-${p.id}-${p.pr}`, `Decision ${p.id} (${redact(p.title, 120)}) is an agent proposal awaiting your sign-off, added by ${names.pr(p.pr).text}`, { kind: 'pull', n: p.pr },
    { tried: 'Agents may only propose decisions; the entry does not bind until you approve it. CI fails any agent PR that marks an entry homeowner-approved without a recorded approval from you.', action: `To approve, comment "homeowner-approval: ${p.id}" on the pull request and set the entry to "Status: homeowner-approved" with its Source linking that comment, or reject the PR.`, links: [{ text: names.pr(p.pr).text, url: web('pull', p.pr) }] });
  // Issue #855: a step that truly cannot be automated is listed by the PR under "Homeowner steps"; it shows here, not in a job report.
  for (const [n, h] of Object.entries(state.homeownerSteps || {})) {
    const pr = Number(n), open = (cache?.pulls || []).some(p => p.number === pr && p.headRefOid === h?.head);
    if (!open || !Array.isArray(h.steps) || !h.steps.length) continue;
    add(`homeowner-steps-${pr}`, `${names.pr(pr).text} lists steps only you can do: ${h.steps.slice(0, 3).join('; ')}`, { kind: 'pull', n: pr },
      { tried: 'The pull request says under "Homeowner steps" that these cannot be automated (they need your credentials or a physical action). Foreman does not defer anything else to you.', action: 'Do the steps after the install, or reject the pull request if one of them could be automated.', links: [{ text: names.pr(pr).text, url: web('pull', pr) }] });
  }
  // Issue #258: one item per PR that no configured agent can review, with the real reason of each agent.
  for (const u of unreviewed) {
    const what = names.pr(u.pr).text, uniq = x => [...new Set(x)];
    const unblock = u.writerUnknown ? `Writer unknown: there is no job record and no session-log or worktree evidence for ${sha7(u.head)}. It becomes known when Foreman finds the writing session's log, or the writing inbox job's worktree reflog, for this exact head on this host, or when Foreman writes the next head. ${u.waits?.length ? uniq(u.waits).join(' and ') + ' having allowance again would also unblock it. ' : ''}You can also review it by hand` : u.unblock?.length ? `Approving ${uniq(u.unblock).join(' or ')} as a review model would unblock it` : u.waits?.length ? `No configured review model can be approved: every one wrote this head (naming a different model in review_candidates would need a decision). ${uniq(u.waits).join(' and ')} having allowance again would unblock it` : 'No configured review model can be approved to unblock it: every one wrote this head, and there is no other agent to review it';
    const tried = `Foreman tried every configured review model of every agent: ${(u.tried?.length ? u.tried : u.reasons).join('; ')}.`;
    if (u.conflicting) add(`noreviewer-${u.pr}`, `${what} at ${sha7(u.head)} conflicts with main and has no reviewer that is independent and available: ${u.reasons.join('; ')}`, { kind: 'pull', n: u.pr },
      { tried: `${tried} The rebase comes first (${u.rebaseAttempts} of ${u.maxRebase} attempts used at this head). ${u.rebaseCapped ? 'The rebase is held by the retry cap, so Foreman will not rebase it again until the cap is cleared.' : u.rebaseAttempts >= u.maxRebase ? 'Attempts are used up, so Foreman will not rebase it again by itself.' : 'Foreman rebases it next; the rebased head is a new head and is then held for a reviewer.'}`,
        action: `Rebase it by hand if Foreman cannot. ${unblock}.`, links: [{ text: what, url: web('pull', u.pr) }] });
    else add(`noreviewer-${u.pr}`, `${what} at ${sha7(u.head)} has no reviewer that is independent and available: ${u.reasons.join('; ')}`, { kind: 'pull', n: u.pr },
      { tried, action: `${unblock}, or review the PR by hand.`, links: [{ text: what, url: web('pull', u.pr) }] });
  }
  // Issue #212: exclusions are listed on the Work page; #1103: a bad Depends on line needs the homeowner.
  for (const x of Team.dependencyTools.attention(cache)) add(x.id, x.text, x.ref, { action: x.action });
  for (const j of jobs) if (['blocked', 'failed'].includes(j.status) && !splitJobs.has(j.id) && now - (j.updatedAt || 0) < 48 * 3600000 && !jobs.some(k => k.id !== j.id && k.provider === j.provider && k.issue === j.issue && (k.createdAt || 0) > (j.createdAt || 0))) {
    const kind = ['implement', 'continue'].includes(j.kind) ? 'issue' : 'pull';
    // Issue #297: an issue that is closed, labelled epic or has an accepted split has nothing left to decide.
    const known = (cache?.issues || []).find(i => i.number === j.issue);   // the cache is the newest 200 issues of any state: a populated cache lacking the issue means it is older than that window; an empty cache proves nothing (#186)
    const closed = kind === 'issue' ? (known ? (known.state !== 'OPEN' || known.labels?.includes('epic')) : (cache?.issues || []).length > 0) || state.splits?.[j.issue]?.status === 'accepted' : Array.isArray(cache?.pulls) && !openPulls.has(j.issue);   // closed or merged: nothing left to decide (also when no PR is open at all)
    if (closed) continue;
    // Issue #186: the PR's own limit card already links this job, so it is not a second card for the same event.
    if (kind === 'pull' && prCarded.has(j.issue)) continue;
    add(`job-${j.id}`, `${names.job(j).text} (${j.provider}) is ${j.status}: ${redact(j.lastEvent || 'unknown reason', 60)}.`, { kind, n: j.issue },
      { tried: `The ${j.kind || 'job'} job ran ${j.attempts || 1} attempt${(j.attempts || 1) === 1 ? '' : 's'} and ended ${j.status}; Foreman starts no new job for it.`, action: 'Read the job record, then retry it or close the issue.', since: j.updatedAt, links: [{ text: (kind === 'pull' ? names.pr(j.issue) : names.issue(j.issue)).text, url: web(kind, j.issue) }, { text: names.job(j).text, url: names.job(j).url }] });
  }
  // issue #158: a rebase that dropped commits, while the PR still sits on that rebased head
  for (const [id, tj] of Object.entries(state.jobs || {})) {
    const pr = (cache?.pulls || []).find(x => x.number === tj.pr);
    if (tj.kind === 'rebase' && tj.rebase?.lost?.length && pr && pr.headRefOid === tj.rebase.newHead)
      add(`rebase-lost-${id.slice(0, 8)}`, `${names.job({ id, kind: 'rebase', pr: tj.pr }).text} dropped ${tj.rebase.lost.length} commit(s): ${tj.rebase.lost.map(c => `${shortCommit(c.sha)} ${c.subject}`).join('; ')}`, { kind: 'pull', n: tj.pr });
    if (tj.kind === 'rebase' && tj.rebase?.lostChanges?.length && pr && pr.headRefOid === tj.rebase.newHead)
      add(`rebase-lost-changes-${id.slice(0, 8)}`, `${names.job({ id, kind: 'rebase', pr: tj.pr }).text} lost ${tj.rebase.lostChanges.length} change(s): ${tj.rebase.lostChanges.slice(0, 5).map(c => `${c.file} ${c.kind === 'unreferenced' ? c.text + ' (unreferenced)' : c.text}`).join('; ')}`, { kind: 'pull', n: tj.pr });
  }
  for (const pr of cache?.pulls || []) if (!pr.isDraft && !fixLimited.has(pr.number) && checksState(pr.statusCheckRollup, retriedIn(state.cancelWatch, pr, now)) === 'red') add(`ci-${pr.number}`, `CI is red on ${names.pr(pr.number).text}`, { kind: 'pull', n: pr.number });
  // Issue #331: a check run whose state contradicts itself for too long. One item per head and check; it clears when the check finishes or the head moves.
  for (const pr of cache?.pulls || []) if (!pr.isDraft) for (const c of stuckChecks(pr.statusCheckRollup, now, stuckSeenFor(pr))) add(`ci-stuck-${pr.number}-${String(pr.headRefOid).slice(0, 7)}-${c.name.replace(/[^A-Za-z0-9]+/g, '-')}`, `Check stuck: "${c.name}" on ${names.pr(pr.number).text} has been inconsistent for ${Math.round(c.ageMs / 60000)} min; re-run that job.`, { kind: 'pull', n: pr.number });
  // issue #149: a cancelled check that was rerun once and is still cancelled
  for (const pr of cache?.pulls || []) if (!pr.isDraft && state.cancelWatch?.[`${pr.number}:${pr.headRefOid}`]?.noticed && loneCancelled(pr.statusCheckRollup, retriedIn(state.cancelWatch, pr, now)).length) add(`ci-cancelled-${pr.number}`, `CI was cancelled and, after one rerun, is still not green on ${names.pr(pr.number).text}`, { kind: 'pull', n: pr.number });
  // idle while there is work: the same plan was present, with the agent idle, in every snapshot of the last 9+ minutes
  const recent = snapshots.filter(s => now - s.at <= 30 * 60000).sort((a, b) => a.at - b.at);
  for (const [agent, s] of Object.entries(states)) {
    if (s.state !== 'idle') continue;
    const work = plan.filter(a => a.agent === agent);
    if (!work.length) continue;
    if (teamEnabled === false) { add(`idle-${agent}`, `${agent} is idle with work waiting (${work.map(a => `${a.type} ${planName(a)}`).join(', ')}) and the team loop is disabled.`); continue; }
    const mine = recent.filter(x => x.agents?.[agent] === 'idle' && x.plan?.some(a => a.agent === agent));
    if (mine.length >= 2 && mine.at(-1).at - mine[0].at >= 9 * 60000) add(`idle-${agent}`, `${agent} has been idle for ${Math.round((now - mine[0].at) / 60000)}+ minutes while ${work.map(a => `${a.type} ${planName(a)}`).join(', ')} waits.`);
  }
  for (const [agent, s] of Object.entries(states)) {
    if (s.state !== 'paused') continue;
    const a = config.agents[agent];
    const own = hasReading(s.job?.allowance) ? s.job.allowance : null, fresh = allowance[a.provider] || null;   // judge by the newest reading the provider reported
    const bs = budgetSettings(config);
    const finding = pauseDisagreement(s.job, own && (!fresh || (own.observedAt || 0) >= (fresh.observedAt || 0)) ? own : fresh, now, { exhaustedAt: bs.exhausted_at, nearlyFull: bs.high_water });
    if (finding && finding.kind !== 'nearly_full') add(`pause-${agent}`, `${agent}: ${finding.text}.${finding.kind === 'disagrees' ? ' Check the provider yourself; the pause may be wrong.' : ''}`, { kind: 'issue', n: s.job.issue });
  }
  stallItems({ items, state, cache, gated, names, now, web, limits });
  return items;
}

// Issue #995: job liveness (limit and last activity per running job), retry counts by cause, and what a recovery re-armed.
export function robustnessView(state, team, jobs, now) {
  const live = team.livenessView?.() || { limitMs: 0, running: {}, cancelled: [] };
  const running = (jobs || []).filter(j => j.status === 'running').map(j => {
    const id = String(j.id).slice(0, 8), at = live.running?.[id]?.lastActivityAt ?? null;
    return { id, kind: j.kind ?? null, lastActivityAt: at, idleMs: Number.isFinite(at) ? Math.max(0, now - at) : null };
  });
  const retries = Object.entries(state.sameCause || {}).map(([k, v]) => ({ key: k, cause: v.cause, count: v.count, capped: (team.retryCapItems?.() || []).some(i => i.subject === k.slice(k.indexOf(':') + 1) && i.type === k.slice(0, k.indexOf(':'))) }));
  const rearm = state.rearm || null, up = (() => { try { return JSON.parse(fs.readFileSync(path.join(team.root || '', 'team', 'self-upgrade.json'), 'utf8')).rearmed || null; } catch { return null; } })();
  return { limitMinutes: Math.round((live.limitMs || 0) / 60000), running, cancelled: (live.cancelled || []).slice(-5), retries, rearm: rearmView(rearm, up), infraFaults: team.faults?.summary?.() ?? null };
}
// Issue #259: PRs that made no progress past the limit. Read from the stored result of the tick's stall check, so a PR that has since
// moved, merged or closed is dropped here at once. PRs stalled for the same set of reasons share one item, and a PR that already has an
// item of its own (any item whose ref is that PR, or the decision hold) gets none. A failed check is its own item.
function stallItems({ items, state, cache, gated, names, now, web, limits }) {
  const st = state.stalls;
  if (!st) return;
  if (st.error) items.push({ id: 'stall-check-error', text: redact(`The stalled-PR check failed: ${st.error}. PRs that stopped making progress may not be reported; this is a bug in Foreman.`, 400), ref: null });
  const open = new Map((cache?.pulls || []).filter(p => !p.isDraft).map(p => [p.number, p]));
  const covered = new Set([...items.filter(i => i.ref?.kind === 'pull').map(i => i.ref.n), ...(gated?.prs || []).map(p => p.number)]);
  const span = ms => { const m = Math.round(ms / 60000), h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
  const hours = Number.isFinite(limits?.stall_hours) ? limits.stall_hours : STALL_DEFAULT_HOURS;
  // One item per PR. Only a reason that names the homeowner asks anything of them; a PR Foreman itself will move on (allowance, a rebase,
  // a reviewer becoming free) is a notice, and a PR with no known reason is a Foreman bug the homeowner can only report.
  for (const it of [...(st.items || [])].sort((a, b) => a.pr - b.pr)) {
    const pr = open.get(it.pr);
    if (!pr || pr.headRefOid !== it.head || covered.has(it.pr)) continue;
    const reasons = it.reasons?.length ? it.reasons : null, homeowner = (reasons || []).some(r => r.code === 'homeowner');
    const why = reasons ? reasons.map(r => r.text).join('; ') : 'Foreman knows no reason it is waiting. That is a bug in Foreman; please report it';
    items.push({ id: `stalled-${it.pr}`, text: redact(`${names.pr(it.pr).text} (head ${String(it.head).slice(0, 7)}) has made no progress for ${span(now - it.since)} (limit ${hours} hours); last: ${it.last}`, 400), ref: { kind: 'pull', n: it.pr }, since: it.since, homeowner: homeowner || !reasons,
      tried: redact(`No new head, no new review verdict and no running job. Current reason${reasons?.length > 1 ? 's' : ''}: ${why}.`, 800),
      action: homeowner ? 'Merge it, or decide what to do with it; Foreman will not act on this branch.' : reasons ? 'Nothing is needed from you: Foreman moves it on when the reason clears.' : 'Open the PR and decide; report the missing reason as a Foreman bug.',
      links: [{ text: redact(names.pr(it.pr).text, 140), url: web('pull', it.pr) }] });
  }
}

function usageView(config, jobs, states, allowance, now) {
  const out = {};
  for (const [agent, a] of Object.entries(config.agents)) {
    const al = allowance[a.provider];
    const mine = jobs.filter(j => j.provider === a.provider && j.usage);
    const st = states[agent], limited = st?.state === 'paused' && st.job?.status === 'paused_limit' && st.job.lastEvent === 'usage_limit';
    const windows = al ? al.windows.map(w => ({ label: windowLabel(w, a.provider), utilization: Number.isFinite(w.utilization) ? w.utilization : null, resetsAt: w.resetsAt || null, expired: windowExpired(w, now) })) : [];
    out[agent] = {
      observedAt: al?.observedAt || null, ageMs: al?.observedAt ? now - al.observedAt : null, source: al?.source || null,
      canProbe: hasProbe(defaultRegistry, a.provider), ...usageReading(al, now, budgetSettings(config)),
      allExpired: windows.length > 0 && windows.every(w => w.expired),
      limit: limited ? limitView(st.job, al, now) : null,
      windows,
      jobs: mine.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, 200).map(j => ({ id: j.id.slice(0, 8), kind: j.kind || 'job', ref: j.issue, status: j.status, inputTokens: j.usage.inputTokens, outputTokens: j.usage.outputTokens, costUsdEstimate: j.usage.costUsdEstimate })),
      totalTokens: mine.reduce((s, j) => s + j.usage.inputTokens + j.usage.outputTokens, 0), jobsWithUsage: mine.length
    };
  }
  return out;
}

// Tokens per job type and model, so the homeowner can see whether the routing pays off (issue #64). Counts only.
// Issue #244: what failed attempts cost. A job that ended failed or blocked produced no deliverable; its tokens and CLI cost estimate
// are shown on their own so wasted work is visible. Totals count only what the CLI reported (unknown stays unknown, not zero).
export function failedSpend(rows) {
  const failed = rows.filter(r => ['failed', 'blocked'].includes(r.status));
  const known = failed.filter(r => Number.isFinite(r.tokens)), priced = failed.filter(r => Number.isFinite(r.cost));
  return { jobs: failed.length, tokens: known.length ? known.reduce((s, r) => s + r.tokens, 0) : null, cost: priced.length ? priced.reduce((s, r) => s + r.cost, 0) : null,
    rows: failed.map(r => ({ id: r.id, name: r.name, kind: r.kind, status: r.status, attempts: r.attempts, tokens: r.tokens, cost: r.cost, startedAt: r.startedAt })) };
}
export function modelUsage(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.kind}|${r.model || ''}|${r.effort || ''}`;
    const g = groups.get(key) || { kind: r.kind, model: r.model || 'CLI default', effort: r.effort || 'default', jobs: 0, inTokens: 0, outTokens: 0, cost: null };
    g.jobs++; g.inTokens += r.inTokens || 0; g.outTokens += r.outTokens || 0;
    if (Number.isFinite(r.cost)) g.cost = (g.cost || 0) + r.cost;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (b.inTokens + b.outTokens) - (a.inTokens + a.outTokens));
}

const DAY = 86400000;
function graphs({ config, jobs, state, snapshots, now, windowMs = 30 * DAY }) {
  const agents = Object.keys(config.agents);
  // Allowance % over time per agent. A sample is drawn only while its reading is current: once the reported reset time has
  // passed, the line ends and an "expected reset" marker is placed at that time (issue #75), instead of holding a stale value
  // up to now. A new reading after the reset starts a new segment (gap). "resets" are reset-time changes seen between
  // snapshots that no expiry already explains.
  const allowance = {};
  for (const agent of agents) {
    const samples = {};
    for (const s of snapshots.filter(x => now - x.at <= windowMs).sort((a, b) => a.at - b.at)) {
      const al = s.allowance?.[agent]; if (!al) continue;
      for (const w of al.windows || []) if (Number.isFinite(w.utilization)) (samples[windowLabel(w, agent)] ||= []).push({ at: s.at, v: w.utilization, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null });
    }
    const series = {}, resets = [], expected = [];
    const expect = (at, window) => { if (!expected.some(e => e.at === at && e.window === window)) expected.push({ at, window }); };
    for (const [k, xs] of Object.entries(samples)) {
      const pts = []; let open = null, gap = false, seen = null;
      for (const x of xs) {
        if (open && open <= x.at) { expect(open, k); open = null; gap = true; }
        if (x.resetsAt && seen && x.resetsAt > seen && !gap) resets.push({ at: x.at, window: k });
        if (x.resetsAt) seen = x.resetsAt;
        if (windowExpired(x, x.at)) { if (x.resetsAt) expect(x.resetsAt, k); gap = true; continue; }
        pts.push(gap && pts.length ? { at: x.at, v: x.v, gap: true } : { at: x.at, v: x.v });
        gap = false; open = x.resetsAt;
      }
      if (open && open <= now) expect(open, k);
      series[k] = pts;
    }
    allowance[agent] = { series, resets, expected: expected.sort((a, b) => a.at - b.at) };
  }
  const days = {};
  for (const j of jobs) {
    if (!j.createdAt || now - j.createdAt > windowMs) continue;
    const day = new Date(j.createdAt).toISOString().slice(0, 10);
    const k = `${j.kind || 'job'}/${ACTIVE.includes(j.status) ? 'active' : j.status}`;
    ((days[day] ||= {})[k] = (days[day][k] || 0) + 1);
  }
  const verdicts = Object.fromEntries(agents.map(a => [a, { PASS: 0, CHANGES: 0 }]));
  for (const v of Object.values(state.verdicts || {})) if (verdicts[v.reviewer] && verdicts[v.reviewer][v.verdict] !== undefined) verdicts[v.reviewer][v.verdict]++;
  const merges = (state.mergeLog || []).map(m => ({ pr: m.pr, issue: m.issue, agent: m.agent, mergedAt: m.mergedAt, hours: m.startedAt && m.mergedAt >= m.startedAt ? (m.mergedAt - m.startedAt) / 3600000 : null }));
  const tokensPerPr = (state.mergeLog || []).map(m => {
    const related = Object.entries(state.jobs || {}).filter(([, tj]) => (['implement', 'continue'].includes(tj.kind) && m.issue && tj.issue === m.issue) || (tj.kind === 'fix' && tj.pr === m.pr));
    const used = related.map(([id]) => jobs.find(j => j.id === id)?.usage).filter(Boolean);
    return { pr: m.pr, agent: m.agent, tokens: used.length ? used.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0) : null };
  });
  return { allowance, jobsPerDay: days, verdicts, merges, tokensPerPr };
}

// One-line description of a job (issue #204), from the job record, the dispatcher record, the verdicts and the PRs Foreman knows.
// No model call: the same data every other view reads.
export function describeFor(j, { names, state }) {
  const rec = state.jobs?.[j.id] || null, kind = rec?.kind || j.kind;
  let verdict = null, opened = null;
  if (kind === 'review') {
    const pr = rec?.pr ?? j.issue, start = j.createdAt || 0;
    verdict = (verdictIndex(state.verdicts).get(String(pr)) || []).map(([, v]) => v).filter(v => !v.at || v.at >= start).reduce((best, v) => (!best || (v.at || 0) < (best.at || 0) ? v : best), null);
  } else if (['implement', 'continue'].includes(kind)) opened = rec?.pr ?? names.prOfIssue(rec?.issue ?? j.issue);
  return redact(withEndNote(describeJob({ ...j, kind }, { names, rec, verdict, opened }), endNote(j, rec)), 400);   // issue #1109
}

// Which model made a decision (issue #140): provider, model and effort of the job that produced it, as recorded on the job.
const modelOf = j => (j ? [j.provider || 'unknown provider', j.model || 'CLI default', j.effort || 'default effort'].map(x => redact(String(x), 40)).join(' · ') : null);
// Raw events kept before idle ticks collapse (issue #76): idle ticks are the bulk of the history and fold into a few rows.
export const ACTIVITY_LIMIT = 400;
const OUTCOME = { created: 'queued', started: 'started', completed: 'completed', usage_limit: 'paused', manual_pause: 'paused', transient_rate_limit: 'paused', recovered: 'recovered', incomplete: 'blocked', waiting_on: 'waiting', retry_exhausted: 'blocked', blocked: 'blocked', crash: 'failed', auth_error: 'failed', approval_required: 'blocked', manual_stop: 'stopped', checkpoint_failed: 'failed' };
function activity({ config, jobs, events, state, cache, snapshots, now, incidents = [], names, root }) {
  const repo = config.repository, rows = [];
  const jobById = new Map(jobs.map(j => [j.id, j]));
  const link = (kind, n) => (n ? { url: `https://github.com/${repo}/${kind === 'pull' ? 'pull' : 'issues'}/${n}`, text: (kind === 'pull' ? names.pr(n) : names.issue(n)).text } : null);
  const jobLink = j => (['implement', 'continue'].includes(j.kind) ? link('issue', j.issue) : link('pull', j.issue));
  const agentName = j => Object.entries(config.agents).find(([, a]) => a.provider === j.provider)?.[0] || j.provider;
  const eventNames = { created: 'job queued', started: 'job started', completed: 'job finished', usage_limit: 'paused on usage limit', manual_pause: 'paused by hand', recovered: 'job recovered', incomplete: 'ended without its post-condition', waiting_on: 'waiting on an open prerequisite', retry_exhausted: 'blocked: retries exhausted', transient_rate_limit: 'paused on transient rate limit', manual_stop: 'stopped by hand', checkpoint_failed: 'stopped: progress checkpoint failed' };
  for (const e of events) {
    if (!eventNames[e.kind] && !['blocked', 'crash', 'auth_error', 'approval_required', 'issue_closed', 'stale_handover', 'checkpoint_failed'].includes(e.kind)) continue;
    const j = jobById.get(e.job); if (!j) continue;
    const done = ['completed', 'blocked', 'retry_exhausted', 'crash', 'manual_stop', 'checkpoint_failed'].includes(e.kind);
    const what = e.kind === 'completed' ? describeFor(j, { names, state }) : `${names.job(j).text}: ${eventNames[e.kind] || redact(e.kind, 40)}`;
    rows.push({ at: e.at, kind: 'job', agent: agentName(j), outcome: OUTCOME[e.kind] || 'other', jobKind: j.kind || null, durationMs: done && j.updatedAt >= j.createdAt ? j.updatedAt - j.createdAt : null, tokens: done && j.usage ? j.usage.inputTokens + j.usage.outputTokens : null,
      text: `${agentName(j)}: ${what}`, link: { url: names.job(j).url, text: names.job(j).text }, ...(root && transcriptExists(root, j.id) ? { transcript: j.id } : {}) });
  }
  for (const [id, tj] of Object.entries(state.jobs || {})) if (tj.kind === 'rebase' && tj.rebase && Number.isFinite(tj.at))
    rows.push({ at: tj.at, kind: 'job', agent: tj.agent || null, outcome: tj.rebase.lost?.length ? 'blocked' : 'completed', jobKind: 'rebase', text: `${names.job({ id, kind: 'rebase', pr: tj.pr }).text}: ${shortCommit(tj.rebase.oldHead)} -> ${shortCommit(tj.rebase.newHead)}, ${tj.rebase.commits.length} commit(s): ${tj.rebase.commits.slice(0, 8).map(c => sha7(c.sha)).join(' ')}${tj.rebase.lost?.length ? `; LOST ${tj.rebase.lost.map(c => sha7(c.sha)).join(' ')}` : ''}`, link: link('pull', tj.pr) });
  for (const u of state.unblock?.log || []) if (Number.isFinite(u.at)) rows.push({ at: u.at, kind: 'unblock', outcome: 'unblocked', text: `Foreman unblocked: ${u.what}, ${u.why}, ${u.result}`, link: link(u.tk === 'issue' ? 'issue' : 'pull', u.target) });
  for (const [key, v] of Object.entries(state.verdicts || {})) { const [pr, head] = key.split(':'); const mdl = modelOf(jobById.get(v.job)); rows.push({ at: v.at, kind: 'review', agent: v.reviewer || null, outcome: String(v.verdict || 'other').toLowerCase(), jobKind: 'review', text: `${v.reviewer}: ${v.verdict} on ${names.pr(Number(pr)).text} at ${shortCommit(head)}${mdl ? ` (${mdl})` : ''}`, link: link('pull', Number(pr)) }); }
  for (const m of state.mergeLog || []) rows.push({ at: m.mergedAt, kind: 'merge', agent: m.agent || null, outcome: 'merged', text: `merged ${names.pr(m.pr).text}${m.agent ? ` (${m.agent})` : ''}`, link: link('pull', m.pr) });
  for (const i of incidents) if (i.kind === 'migration') rows.push({ at: i.at, kind: 'migration', outcome: i.result === 'failed' ? 'failed' : 'completed', text: `config migration ${String(i.number).padStart(3, '0')}-${i.name} ${i.result}${i.result === 'failed' ? `: ${redact(String(i.error ?? ''), 200)}` : `: ${redact(String(i.description || ''), 200)}`}`, link: null });
  // ticks take part in the same newest-first ordering and 50-event bound as every other event (issue #32)
  rows.push(...snapshots.map(s => ({ at: s.at, kind: 'tick', idle: s.status === 'ok' && !s.plan?.length && !s.ingested, outcome: s.status !== 'ok' ? s.status : s.plan?.length || s.ingested ? 'planned' : 'idle', text: s.status === 'ok'
    ? `tick ok${s.plan?.length ? `, plan: ${s.plan.map(a => `${a.agent || ''} ${a.type} ${(['implement', 'continue'].includes(a.type) ? names.issue(a.ref) : names.pr(a.ref)).text}`.trim()).join('; ')}` : ', nothing to dispatch'}`
    : `tick ${s.status}${cache?.tick?.at === s.at && cache.tick.error ? `: ${cache.tick.error}` : ''}` })));
  if (cache?.tick && cache.tick.status !== 'ok' && !snapshots.some(s => s.at === cache.tick.at))
    rows.push({ at: cache.tick.at, kind: 'tick', outcome: cache.tick.status, text: `tick ${cache.tick.status}${cache.tick.error ? `: ${cache.tick.error}` : ''}` });
  return rows.filter(r => Number.isFinite(r.at)).sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT).map(r => ({ ...r, text: redact(r.text, 300) }));
}

const untilText = (until, team) => (Number.isFinite(until) ? ` until ${new Intl.DateTimeFormat('en-GB', { timeZone: team.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(until)).replace(',', '')}` : '');
export { budgetView };
export const REGISTER_NOTE = 'Cannot read docs/DECISIONS.md from origin/main: the real tick would refuse to launch jobs.';
// Role slots (issue #148): who holds the implementer and reviewer slot right now, with the model and the work. A job the dispatcher has
// no record of (started by hand) counts against the implementer slot, as the planner counts it.
const SLOT_LABEL = { implementer: 'Implementer', reviewer: 'Reviewer', rebaser: 'Rebaser', inbox: 'Inbox lane' };
const SLOT_WHAT = { implement: 'implementing', continue: 'continuing', review: 'reviewing', fix: 'fixing', rebase: 'rebasing', cifix: 'fixing CI', inbox: 'running an approved prompt' };
export function roleSlots(config, jobs, state, names = makeNamer({ repo: config.repository, stateJobs: state.jobs, titles: state.titles })) {
  return ROLES.map(role => {
    const held = jobs.filter(j => ((ACTIVE.includes(j.status) && j.status !== 'paused_limit') || isUnknownJob(j)) && roleOfType(state.jobs?.[j.id]?.kind) === role).map(j => {
      const r = state.jobs?.[j.id] || {}, agent = r.agent || Object.entries(config.agents).find(([, a]) => a.provider === j.provider)?.[0] || j.provider;
      const ref = r.pr ?? r.issue ?? j.issue ?? null, refType = r.pr != null ? 'PR' : 'issue';
      return { agent: redact(agent, 20), model: r.model ? redact(r.model, 40) : null, kind: r.kind || null, ref, refType, name: ref == null ? null : redact((refType === 'PR' ? names.pr(ref) : names.issue(ref)).text, 200) };
    });
    const label = SLOT_LABEL[role];
    const text = held.length ? `${label}: ${held.map(h => [h.agent, h.model, h.name, h.kind ? SLOT_WHAT[h.kind] || h.kind : null].filter(Boolean).join(' · ')).join('; ')}` : `${label}: idle`;
    return { role, label, capacity: roleCount(config.limits, role), held, text };
  });
}

// Every issue, pull request and job the page can name, formatted once by the shared formatter (issue #147). The renderer looks
// references up here, so no page builds its own text. Keys: issue/pr by number, job by its 8-character id.
export function refsOf({ names, cache, jobs, state }) {
  const out = { issue: {}, pr: {}, job: {} };
  const put = (map, key, ref) => { map[key] = { text: redact(ref.text, 300), full: redact(ref.full, 400), url: ref.url }; };
  for (const i of cache.issues || []) put(out.issue, i.number, names.issue(i.number));
  const prNos = new Set([...(cache.pulls || []).map(x => x.number), ...(cache.merged || []).map(x => x.number), ...(state.mergeLog || []).map(x => x.pr), ...Object.keys(state.verdicts || {}).map(k => Number(k.split(':')[0]))]);
  for (const n of prNos) if (Number.isSafeInteger(n)) put(out.pr, n, names.pr(n));
  for (const j of jobs) put(out.job, shortJob(j.id), names.job(j));
  return out;
}

// First-seen times of inconsistent checks, per PR head (see stuckChecks). In memory: a restart restarts the clock.
const stuckSeen = new Map();
export const stuckSeenFor = pr => { const k = `${pr.number}:${pr.headRefOid}`; if (!stuckSeen.has(k)) { for (const o of [...stuckSeen.keys()]) if (o.startsWith(`${pr.number}:`)) stuckSeen.delete(o); stuckSeen.set(k, new Map()); } return stuckSeen.get(k); };
// Open issues the planner leaves out, and issues held by an open PR, with the reason (moved out of buildView unchanged, issue #1121).
function excludedIssues({ team, c, config, names }) {
  const byNoAll = new Map((c.issues || []).map(i => [i.number, i]));
  const excluded = (c.issues || []).filter(i => i.state === 'OPEN' && !team.delivered?.has(i.number)).sort((x, y) => x.number - y.number).flatMap(i => {
    const ex = team.exclusion(i.number, byNoAll, c.pulls || []);
    if (ex) return [{ number: i.number, name: redact(names.issue(i.number).text, 300), kind: ex.kind, reason: redact(ex.kind === 'prerequisite' ? `blocked by ${ex.refs.map(d => names.issue(d).text).join(', ')}` : ex.text, 300) }];
    const held = (c.pulls || []).find(p => agentOfBranch(config, p.headRefName) && new RegExp(`/issue-${i.number}(\\D|$)`).test(p.headRefName));
    return held ? [{ number: i.number, name: redact(names.issue(i.number).text, 300), kind: 'pr-open', reason: `held by open ${names.pr(held.number).text}` }] : [];
  });
  return excluded;
}
export function buildView({ config, root, jobs, events, state, cache, snapshots, now, register = '', registerUnreadable = false, tz = 'UTC', running, lastSeen = null, configError = null, history = null, watchlist = null }) {
  const states = agentStates(config, jobs, now);
  const allowance = latestAllowance(jobs, cache?.probes);
  const c = cache || { pulls: [], issues: [] };
  const team = cacheBackedTeam(config, root, c, jobs, state, snapshots, now, events || [], register, tz);
  return team.plan().then(async plan => {
    const names = makeNamer({ repo: config.repository, issues: c.issues, pulls: c.pulls, merged: c.merged, mergeLog: state.mergeLog, stateJobs: state.jobs, titles: state.titles });
    const queues = reasons(team, c, jobs, plan, states, names, now);
    team.view = { prs: c.pulls || [], issues: c.issues || [] }; team.merged = await team.gh.listMergedPulls();
    const excluded = excludedIssues({ team, c, config, names });
    team.assignments = collectAssignments(team, { cache: c, plan, states, activeJobs: jobs.filter(j => ACTIVE.includes(j.status)) });   // issue #1121: read by idleReason and the view
    const lastTick = [...(snapshots || [])].sort((x, y) => y.at - x.at)[0] || null;
    const agents = Object.entries(config.agents).map(([name, a]) => {
      const s = states[name], j = s.job;
      const base = { name, provider: a.provider, state: s.state, lastActivityAt: s.last ? Math.max(s.last.updatedAt || 0, s.last.lastProgress || 0) || null : null, job: null };
      base.idleReason = idleReason({ agent: name, config, team, cache: c, plan, state: s.state, now, hold: lastTick?.idle?.[name] || null, names });
      // Issue #213: one entry per running or paused job, with its role, model and item, so concurrent jobs on one agent each get a card.
      base.jobs = (s.jobs || []).map(x => { const r = state.jobs?.[x.id] || {}; return { id: shortJob(x.id), fullId: x.id, name: redact(names.job(x).text, 300), kind: x.kind || r.kind || 'job', role: roleOfType(r.kind || x.kind), model: redact(r.model || x.model || '', 40) || null, status: x.status, lastEvent: redact(x.lastEvent || '', 48), nextAttemptAt: x.nextAttemptAt || null, startedAt: x.createdAt, elapsedMs: now - x.createdAt, attempts: x.attempts || 0, paused: ['paused_limit', 'paused_manual'].includes(x.status), resumeWait: x.resumeWait?.reason ? redact(x.resumeWait.reason, 300) : null }; });
      if (j) base.job = { id: shortJob(j.id), fullId: j.id, name: redact(names.job(j).text, 300), kind: j.kind || 'job', ref: j.issue, branch: redact(j.branch || '', 100), startedAt: j.createdAt, elapsedMs: now - j.createdAt, status: j.status, lastEvent: redact(j.lastEvent || '', 48), resetAt: j.resetAt || null, nextAttemptAt: j.nextAttemptAt || null, attempts: j.attempts || 0 };
      return base;
    });
    const pauseText = team.pauseText(c.pulls || [], c.issues || []);
    const attention = attentionItems({ pauseText, config, cache, jobs, states, plan, snapshots, now, allowance, teamEnabled: config.enabled !== false, state, limits: team.c.limits, names, gated: { info: decisionInfo(register, INDEPENDENCE_DECISION), prs: team.waitingOnDecision(c.pulls || []) }, unreviewed: team.unreviewable(c.pulls || []), withheld: new Map((c.pulls || []).map(p => [p.number, team.writeBlock(p)]).filter(([, b]) => b)), proposals: pendingProposals(config, c.pulls || [], register), fixCount: pr => team.fixCount(pr), held: new Set((c.pulls || []).filter(p => team.carriedHold(p)).map(p => p.number)), escalating: new Set((c.pulls || []).filter(p => team.escalationPending(p.number, p)).map(p => p.number)) }).map(a => ({ ...a, severity: severityOf(a.id) }));
    attention.push(...afterInstallAttention({ state, root, names, config }).map(a => ({ ...a, severity: severityOf(a.id) })));
    const ver = readVersion(root, running === undefined ? { now } : { running, now });
    const inbox = inboxView(config, attention, now);
    const inboxSearch = inboxSearchView(config);
    if (ver?.running && ver.installed && ver.running !== ver.installed) attention.push({ id: 'dashboard-stale', text: `Dashboard is running ${sha7(ver.running)}, Foreman is on ${sha7(ver.installed)}; what you see may be out of date. Restart the dashboard server.`, ref: null, severity: 'warning' });
    if (ver?.drift) attention.push({ id: 'drift', text: `Installed supervisor ${sha7(ver.installed)} is behind main ${sha7(ver.main)}${Number.isSafeInteger(ver.behind) ? ` by ${ver.behind} commit${ver.behind === 1 ? '' : 's'}` : ''}: merged, not installed yet.${ver.nextInstall ? ` Next install: ${Number.isFinite(ver.nextInstall.at) ? 'not before ' + new Date(ver.nextInstall.at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : ver.nextInstall.why}.` : ''}`, ref: null, severity: 'warning' });
    // Issue #265: one Needs you item while main needs a hand-deployed bootstrap installer change; it ends when the installed commit moves.
    try { const h = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')).handDeploy; if (h && /^[0-9a-f]{40}$/.test(h.to || '') && h.from === ver?.installed) attention.push({ id: 'hand-deploy', text: redact(`Main ${sha7(h.to)} changes ${(h.files || []).map(String).join(', ')}, which Foreman cannot install itself. Run: ${h.command}`, 300), ref: null, severity: 'action' }); } catch { /* none */ }
    // Issue #488: a refused upgrade (not eligible, diverged, failed non-environmental check) is one Needs you item until the installed commit or main moves.
    try { const rs = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')); const f = rs.refusal; if (f && /^[0-9a-f]{40}$/.test(f.to || '') && f.from === ver?.installed && (!rs.main?.sha || rs.main.sha === f.to)) attention.push({ id: 'upgrade-refused', text: redact(`Foreman did not install main ${sha7(f.to)}: ${f.kind === 'not-eligible' ? 'not eligible' : f.kind === 'diverged' ? 'history diverged' : f.kind === 'install-check' ? 'install-time check failed' : 'pre-check failed'} (${String(f.reason || 'no reason recorded').slice(0, 200)}). It stays until the installed commit or main moves.`, 400), ref: null, severity: 'action', action: 'Fix the cause on main (or merge a newer commit); Foreman tries the new main on the next tick.' }); } catch { /* none */ }
    // Issue #209: a failed dashboard restart or a fall back to the last good version stays a Needs you item until a restart succeeds.
    try { const f = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')).dashboardFailure; if (f && typeof f.reason === 'string') attention.push({ id: 'dashboard-restart-failed', text: redact(`The dashboard server could not be ${f.kind === 'watchdog' ? 'brought back after it stopped answering' : 'restarted after the ' + (f.kind === 'rollback' ? 'rollback' : 'upgrade')}${/^[0-9a-f]{40}$/.test(f.target || '') ? ` on ${sha7(f.target)}` : ''}: ${f.reason}. ${f.recovered ? 'The last good version was started again and is serving now.' : 'Foreman keeps trying on later ticks with a growing delay.'}`, 500), ref: null, severity: 'action', action: 'Check supervisor/dashboard.log, then restart the dashboard server on the installed version.' }); } catch { /* none */ }
    // Issue #302: a rolled-back upgrade pauses all later upgrades (the latch); one Needs you item says why and how to clear it.
    const latch = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.latch'), 'utf8')); } catch (error) { return error.code === 'ENOENT' ? null : { reason: 'unreadable latch file' }; } })();
    if (latch) attention.push({ id: 'upgrade-latched', text: redact(latchCardText(latch, ver, stopLines(latch.reason)), 700), ref: null, severity: 'action', action: 'Find out why the upgrade failed, then clear the latch so the next tick can try again.' });
    // Issue #134: a pending supervisor upgrade holds back new jobs until the running ones finish.
    // Issue #362: a storage warning is a Needs you item; nothing is ever deleted automatically.
    if (history?.storage?.warnings?.length) attention.push({ id: 'history-storage', text: redact(`History storage: ${history.storage.warnings.join(' ')}`, 400), ref: null, severity: 'warn', action: 'Free space on the volume or move the history archive; Foreman never deletes history by itself.' });
    // Issue #153: a failed config migration skips each tick (and is retried) until the homeowner fixes team.local.json
    // Issue #191: an invalid team.local.json stops every tick (upgrade and team steps); the page keeps the last good configuration.
    if (configError) attention.push({ id: 'config-invalid', text: redact(`team.local.json is invalid, so every Foreman tick fails until it is fixed (this page shows the last good configuration): ${configError}`, 300), ref: null, severity: 'action', action: 'Fix or remove the invalid setting in team.local.json.' });
    { const f = readMigrationState(root).failed; if (f) attention.push({ id: 'migration-failed', text: redact(`Config migration ${String(f.number).padStart(3, '0')}-${f.name} failed and this tick was skipped: ${f.error}. team.local.json was not changed. After a self-upgrade the previous version may be back in place and still ticking.`, 300), ref: null, severity: 'action' }); }
    // Issue #250: new implement jobs are paused while open PRs are at or above limits.max_open_prs; the item clears when they fall below.
    { const text = team.pauseText(c.pulls || [], c.issues || []); if (text) attention.push({ id: 'paused-new-work', text, ref: null, severity: 'info' });
      // Issue #320: the cap blocks all new work and no open PR can progress: one Needs you item names the PRs and the choices.
      const dl = team.capDeadlock(c.pulls || [], c.issues || []);
      if (dl) attention.push({ id: 'cap-deadlock', text: `New work is stuck at the open-PR cap (${dl.cap}) and none of these ${dl.prs.length} open PRs can move on its own: ${dl.prs.map(n => '#' + n).join(', ')}.`, ref: null, severity: 'action', action: 'Choose one: merge or close one of these PRs, resolve what each is waiting on, or raise limits.max_open_prs in team.local.json.' }); }
    // Issue #521: an issue marked implemented whose pull request was closed unmerged (or never opened) cannot start by itself.
    for (const e of Object.values(team.stale || {})) attention.push({ id: `stale-mark-${e.issue}`, text: redact(`Issue #${e.issue}: ${team.staleText(e.issue).replace(/^stuck: /, '')}.`, 300), ref: { kind: 'issue', n: e.issue }, since: e.markedAt, severity: 'action', action: `If it should be implemented again, run: team reopen ${e.issue}. Otherwise close the issue or leave it.` });
    // Issue #630: mismatches between Foreman's records and GitHub or the running jobs that it cannot fix safely; one item each while it lasts.
    for (const it of team.selfCheckItems?.() || []) attention.push({ id: it.id, text: redact(it.text, 400), ref: Number.isSafeInteger(it.ref) ? { kind: 'pull', n: it.ref } : it.ref, since: it.since, severity: 'action', action: it.action });
    attention.push(...stoppedAttention(team));   // issue #995 retry caps and issue #1107 parked agents
    // Issue #547: a finished review whose verdict was refused at ingestion (writer unknown, or the reviewer's model wrote the head).
    for (const r of team.refusedVerdicts(c.pulls || [])) attention.push({ id: `noreviewer-refused-${r.pr}`, text: redact(`The review of PR #${r.pr} at ${String(r.head).slice(0, 7)} (job ${String(r.job).slice(0, 8)}, ${r.agent} on ${r.model || 'its default model'}) finished but its verdict was not recorded: ${r.text}. Verdict file: ${r.file}${r.kept ? keptText(r.kept) : ''}`, 1400), ref: { kind: 'pull', n: r.pr }, severity: 'action', action: r.reason === 'writer unknown' ? `Have a reviewer on another provider review PR #${r.pr} at this head, or push a new head through a Foreman job and have that new head reviewed; this refused verdict is not recorded.` : `Have a different model review PR #${r.pr} at this head (the refused verdict in the file above is not recorded and is not trusted).` });
    // Issue #326: queued or conflicting work, but nothing planned or started for idle_minutes; clears when a job starts.
    { const idle = team.idleItem(now); if (idle) attention.push({ id: 'foreman-idle', text: redact(`Foreman has work waiting but has started nothing for ${idle.minutes} minutes: ${idle.work.join('; ')}. Reason: ${idle.reason}`, 600), ref: null, severity: 'action', action: 'Resolve what is holding the work (allowance, review independence, a conflict Foreman cannot rebase) or start it by hand.' }); }
    // Issue #193: say which job records make an agent Unknown, so nobody has to hunt through jobs/.
    { const names = [...new Set(Object.values(states).flatMap(x => x.unknownRecords || []))]; if (names.length) attention.push({ id: 'unknown-job-records', text: redact(`Agent state is Unknown because of job record(s) this version cannot read: ${names.join(', ')}. Fix or delete them in the jobs directory (they stop counting after 7 days).`, 300), ref: null, severity: 'warning' }); }
    if (registerUnreadable) attention.push({ id: 'register-unreadable', text: REGISTER_NOTE, ref: null, severity: 'warning' });
    const sup = supervisorHealth({ root, config, jobs, now });
    { const f = faultAttention((team.assignments || []).filter(a => a.fault).map(a => ({ issue: a.number, fault: a.fault }))); if (f) attention.push(f); }   // issue #1121
    // Issue #215: team-alert's own warnings, taken from the latest tick. A notify that failed means the homeowner was not told.
    { const w = sup.ticks.filter(t => Number.isFinite(t.at)).at(-1)?.warnings || [];
      if (w.some(x => /warning: notify failed/.test(x))) attention.push({ id: 'alert-failed', text: 'The last alert could not be delivered (notify failed), so you may not have been told the team needs you.', ref: null, severity: 'action' });
      else if (w.length) attention.push({ id: 'alert-warning', text: redact(w[0].replace(/^team-alert: warning: /, 'Alerting: '), 200), ref: null, severity: 'warning' }); }
    // Issue #358: the pinned status issue could not be updated; the tick itself is unaffected.
    { const e = readStatusIssueState(root).error; if (e) attention.push({ id: 'status-issue-failed', text: redact(e, 300), ref: null, severity: 'warning' }); }
    // Issue #549: a tripped circuit breaker is the top Needs you item and a status on the Overview; the cost is labelled usage equivalent.
    const breakerState = breakerStateOf(state.breaker || {}), breakerRunning = jobs.filter(j => j.status === 'running').map(j => ({ id: String(j.id).slice(0, 8), type: typeOfKind(j.kind || 'job'), ref: state.jobs?.[j.id]?.pr ?? state.jobs?.[j.id]?.issue ?? j.issue ?? null }));
    const breakerView = breakerHaltView(breakerState, breakerRunning);
    if (breakerState.error) attention.unshift({ id: 'breaker-error', text: redact(`The circuit breaker failed: ${breakerState.error.message}. Existing halts stay in force and no new halt is being evaluated.`, 300), ref: null, severity: 'action', action: 'Read the tick report and fix the cause; the breaker retries every tick.' });
    if (breakerView) attention.unshift({ id: 'breaker-halt', text: redact(`${breakerView.text} ${breakerView.running_text}`, 700), ref: breakerView.prs[0] ?? null, severity: 'action', action: breakerView.action });
    const extra = dashExtras({ root, config, cache: c, jobs, state, states, plan, queues, attention, now, ver, sup, names, excluded, pauseText, inbox, inboxSearch });
    // Issue #156: estimated finish per queued issue / open PR, from the job history; the upgrade rate limit is a known wait.
    let upgrade = null; try { upgrade = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')); } catch { /* none */ }
    if (latch) upgrade = { ...(upgrade || {}), latch: true };
    const budget = budgetView(team);
    const estimates = estimateQueue({ queues, pulls: c.pulls || [], jobs, state, budget, config, now, tz, upgrade });
    return {
      ...assignmentFields(extra, team.assignments, names),   // issue #1121: extra plus assignments, faults and the issue rows' explanation
      // Issue #866: the headline progress numbers, from the same records the rest of the view uses.
      headline: headlineStats({ issues: extra.issues, prs: extra.prs, jobs, wasteRecords: Object.values(breakerState.waste || {}), now }),
      since: sinceView({ jobs, state, names, describe: j => describeFor(j, { names, state }), needsYou: extra.panels.needsYou, now }, lastSeen),
      refs: refsOf({ names, cache: c, jobs, state }),
      estimates,
      watching: watchingView({ items: watchlist?.items || [], cache: c, state, prs: extra.prs, issues: extra.issues, jobs: extra.jobs, names, now }),
      generatedAt: now, tz, repository: config.repository, teamEnabled: config.enabled !== false,
      tick: cache?.tick || null, cacheFetchedAt: cache?.fetchedAt || null,
      agents, queues, plan, capacity: overallCap(config.limits), capNotes: capNotes(config.limits, team.pauseText(c.pulls || [], c.issues || [])).map(t => redact(t, 300)),
      budget, hostPressure: hostPressureView(state, config, now),   // issue #1151
      attention,
      robustness: robustnessView(state, team, jobs, now),
      breaker: { halt: breakerView, byCause: breakerByCause(breakerState), error: breakerState.error?.message ?? null, costLabel: BREAKER_COST_LABEL, failCauses: failCausesOf(state.failCauses, { now }) },
      usage: usageView(config, jobs, states, allowance, now),
      graphs: graphs({ config, jobs, state, snapshots: history?.chartSnapshots || snapshots, now, windowMs: history?.chartSnapshots ? Infinity : 30 * DAY }),
      idleCauses: idleReport({ jobs, snapshots, agents: Object.fromEntries(Object.entries(config.agents).map(([n, x]) => [n, x.provider])), from: now - 24 * 3600000, to: now }),
      history: history ? { timeline: history.timeline, gaps: history.gaps, storage: history.storage, allTime: !!history.chartSnapshots } : null,
      activity: activity({ config, jobs, events, state, cache, snapshots, now, root, incidents: readIncidents(root), names })
    };
  });
}

// Issue #430: the watched changes, each with its seven steps, the one sentence and the history behind every step. Pure: the stored list plus
// data already in the view. An item follows its issue and PR, never a head, so a new head or an issue becoming a PR keeps the watch.
export function watchingView({ items, cache, state, prs, issues, jobs, names, now }) {
  const seen = new Set(), out = [];
  for (const item of items) {
    const { pr, issue } = resolveWatch(item, { pulls: cache.pulls, merged: cache.merged, mergeLog: state.mergeLog });
    const key = issue ?? `pr${pr}`;
    if (seen.has(key)) continue;       // watching an issue and its PR shows the change once
    seen.add(key);
    const prRow = pr !== null ? prs.find(p => p.number === pr) : null, issueRow = issue !== null ? issues.find(i => i.number === issue) : null;
    const f = { issue: issueRow ? { number: issueRow.number, state: issueRow.state, needsHomeowner: issueRow.needsHomeowner } : issue !== null ? { number: issue, state: 'OPEN', needsHomeowner: false } : null,
      pr: prRow ? { number: prRow.number, status: prRow.status, checks: prRow.checks, verdict: prRow.verdict, head: prRow.head, fixRounds: prRow.fixRounds, needsHomeowner: prRow.needsHomeowner, verdicts: prRow.verdicts, mergedAt: prRow.mergedAt ? Date.parse(prRow.mergedAt) || null : null } : null,
      lastEventAt: prRow?.timeline?.at(-1)?.at ?? null };
    const live = { ...item, pr: pr ?? item.pr, issue: issue ?? item.issue };
    const d = describeWatch(live, f, now);
    const rowJobs = prRow ? prRow.jobs : jobs.filter(j => issue !== null && j.ref === issue && ['implement', 'continue'].includes(j.kind));
    out.push({ id: item.id, kind: item.kind, number: item.number, pinned: item.pinned === true, pr, issue, title: redact(prRow?.title || issueRow?.title || (pr !== null ? names.pr(pr).text : names.issue(issue).text), 160),
      addedAt: item.addedAt, status: prRow?.status ?? null, installedAt: item.installedAt ?? null, ...d, history: historyOf(live, f, rowJobs) });
  }
  return out;
}

// ---- issue #54: what the v2 pages need on top of the v1 model. Still pure: only data already stored by the tick.
export const TICK_INTERVAL_MS = 5 * 60000;
// Issue #473: the app bar countdown. The reconcile cron fires on every 5 minute wall-clock slot, so the next scheduled tick is the first
// slot after the last recorded tick, not last tick + 5 minutes. A live tick lock (its owner process still exists) means a tick is running.
// Returns the running tick's start time, or null when no tick is running.
export function runningTickSince(root, alive = processStart) {
  const dir = path.join(root, 'team', 'tick.lock');
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
    if (!owner || alive(owner.pid) !== owner.start) return null;
    return Number.isFinite(owner.at) ? owner.at : fs.statSync(dir).mtimeMs;
  } catch { return null; }
}
export const TICK_GRACE_MS = 90 * 1000;
export function tickCountdown({ lastAt, runningSince = null, now, intervalMs = TICK_INTERVAL_MS }) {
  if (Number.isFinite(runningSince)) return { state: 'running', since: runningSince, lastAt: lastAt ?? null };
  if (!Number.isFinite(lastAt)) return null;
  const slot = (Math.floor(lastAt / intervalMs) + 1) * intervalMs;
  // A cron slot that has just passed is not late yet: the tick needs a moment to start and take the lock.
  return { state: slot > now ? 'scheduled' : now - slot < TICK_GRACE_MS ? 'starting' : 'overdue', at: slot, lastAt };
}
const NEXT_STEP = {
  homeowner: 'Open the issue and answer the question it states.',
  'tick-failed': 'Read the tick error; nothing is dispatched until a tick succeeds.',
  job: 'Read the job record, then retry it or close the issue.',
  'alert-failed': 'Check the Unraid notification settings, then run team-alert --test on Tower; the alert is retried every tick until it is delivered.',
  migration: 'Fix team.local.json by hand (or remove the offending key), then the next tick retries the migration. The failed attempt left the file unchanged; backups are next to it.',
  rebase: 'Restore the dropped commits on the PR branch (the old head is still reachable by its id) before it is reviewed or merged.'
};
const COMMANDS = { 'tick-failed': 'ai-supervisor team tick --dry-run', 'upgrade-latched': 'ai-supervisor self-upgrade clear-latch' };
export function healthOf({ attention, states, teamEnabled, needsYouCount }) {
  const open = Number.isSafeInteger(needsYouCount) ? needsYouCount : attention.filter(a => a.severity === 'action').length;   // one shared count: the consolidated list's length (issue #141: the header shows how many)
  if (open) return { state: 'needs_you', label: `Needs you (${open})`, count: open, severity: 'action' };
  if (attention.some(a => /^(tick-stale|idle)/.test(a.id))) return { state: 'stuck', label: 'Stuck', severity: 'warning' };
  if (Object.values(states).some(s => s.state === 'unknown')) return { state: 'unknown', label: 'Unknown', severity: 'warning' };
  if (Object.values(states).some(s => s.state === 'paused')) return { state: 'paused', label: 'Paused', severity: 'warning' };
  if (Object.values(states).some(s => s.state === 'running')) return { state: 'running', label: 'Running', severity: 'ok' };
  return { state: 'idle', label: 'Idle', severity: teamEnabled === false ? 'info' : 'ok' };
}
export function freshness(tickAt, now) {
  if (!Number.isFinite(tickAt)) return { ageMs: null, level: 'action', label: 'No data' };
  const age = Math.max(0, now - tickAt);
  return { ageMs: age, level: age <= STALE_TICK_MS ? 'ok' : age <= 3 * STALE_TICK_MS ? 'warning' : 'action', label: age <= STALE_TICK_MS ? 'Fresh' : 'Stale' };
}
const findingText = f => redact(typeof f === 'string' ? f : (f?.summary || f?.title || f?.message || JSON.stringify(f ?? '')), 240);
const sumKeys = (obj, pr) => Object.entries(obj || {}).filter(([k]) => k.split(':')[0] === String(pr)).reduce((s, [, c]) => s + (Number(c) || 0), 0);

// Group by issue (issue #204): each issue's story, oldest first: implement, review, fixes, rebases, merge.
export function issueTimelinesOf({ jobs, state, names, jobRows, cache }) {
  const by = new Map(), add = (n, e) => { if (!Number.isSafeInteger(n)) return; if (!by.has(n)) by.set(n, []); by.get(n).push(e); };
  const rowOf = new Map(jobRows.map(r => [r.fullId, r]));
  for (const j of jobs) {
    const r = rowOf.get(j.id), rec = state.jobs?.[j.id]; if (!r) continue;
    const n = ['implement', 'continue'].includes(rec?.kind || j.kind) ? (rec?.issue ?? j.issue) : (rec?.forIssue ?? names.issueOfPr(rec?.pr ?? j.issue)?.number);
    add(n, { at: j.createdAt, kind: rec?.kind || j.kind, text: r.desc, link: { url: names.job(j).url, text: names.job(j).text } });
  }
  for (const m of state.mergeLog || []) add(m.issue ?? names.issueOfPr(m.pr)?.number, { at: m.mergedAt, kind: 'merge', text: redact(`Merged ${names.pr(m.pr).text}${m.agent ? ` (${m.agent})` : ''}.`, 300), link: { url: names.pr(m.pr).url, text: names.pr(m.pr).text } });
  return [...by.entries()].map(([n, events]) => ({ number: n, name: redact(names.issue(n).text, 300), full: redact(names.issue(n).full, 400), events: events.filter(e => Number.isFinite(e.at)).sort((a, b) => a.at - b.at), last: Math.max(...events.map(e => e.at || 0)) }))
    .filter(t => t.events.length).sort((a, b) => b.last - a.last).slice(0, 60);
}

// Issue #414: the quieter Later list: parked or staged work, what each waits for and who or what ends the wait.
export function laterOf({ cache, state = {}, pauseText = null, names, config }) {
  const splitting = new Set(Object.entries(state.splits || {}).filter(([, sp]) => ['drafting', 'proposed'].includes(sp.status)).map(([n]) => Number(n)));
  return heldIssues({ cache, state, splitting, pauseText, config }).filter(h => h.where === 'later').map(h => ({ number: h.number, name: redact(names.issue(h.number).text, 300), waits: redact(h.waits, 300), ends: redact(h.ends, 300), url: `https://github.com/${config.repository}/issues/${h.number}` }));
}

// Issue #76: why nothing is planned. Busy and paused agents with their job and resume time, and the items that cannot start:
// open issues behind an unfinished prerequisite, and open pull requests waiting for a review.
export function nextWhy({ states, issues, prs, names }) {
  const busy = [], paused = [];
  for (const [agent, s] of Object.entries(states)) {
    if (s.state === 'running' && s.job) busy.push({ agent, job: redact(names.job(s.job).text, 300) });
    else if (s.state === 'paused') paused.push({ agent, job: s.job ? redact(names.job(s.job).text, 300) : null, resumeAt: s.job?.nextAttemptAt ?? s.job?.resetAt ?? null });
  }
  const blocked = issues.filter(i => i.state === 'OPEN' && i.blockedBy.length), waiting = prs.filter(p => p.awaitingReview);
  return { busy, paused, blocked: blocked.length, waitingReview: waiting.length };
}

function dashExtras({ root, config, cache, jobs, state, states, plan, queues, attention, now, ver, sup, names, excluded, pauseText = null, inbox = [], inboxSearch = [] }) {
  const repo = config.repository, teamEnabled = config.enabled !== false;
  const agentNames = Object.keys(config.agents);
  const agentOf = j => agentNames.find(n => config.agents[n].provider === j.provider) || j.provider;
  const tokensOf = j => (j.usage ? j.usage.inputTokens + j.usage.outputTokens : null);
  const sortedJobs = jobs.filter(j => j.createdAt).sort((a, b) => b.createdAt - a.createdAt);
  const rowOf = j => ({
    id: shortJob(j.id), fullId: j.id, hasTranscript: transcriptExists(root, j.id), desc: describeFor(j, { names, state }), name: redact(names.job(j).text, 300), full: redact(names.job(j).full, 400), agent: agentOf(j), kind: j.kind || 'job', ref: j.issue ?? null, head: state.jobs?.[j.id]?.head ?? j.head ?? null, status: j.status, attempts: j.attempts || 0,
    startedAt: j.createdAt, elapsedMs: (j.status === 'running' ? now : (j.updatedAt || j.createdAt)) - j.createdAt, tokens: tokensOf(j), inTokens: j.usage ? j.usage.inputTokens : null, outTokens: j.usage ? j.usage.outputTokens : null,
    cost: Number.isFinite(j.usage?.costUsdEstimate) ? j.usage.costUsdEstimate : null, model: j.model || null, effort: j.effort || null, modelReason: redact(j.modelReason || '', 200), reassignedFrom: state.jobs?.[j.id]?.reassignedFrom || null, reassignReason: redact(state.jobs?.[j.id]?.reassignReason || '', 300), branch: redact(j.branch || '', 100), overseer: jobOverseer(j, { ticks: sup.ticks, state, cache, now }) });
  const jobRows = sortedJobs.slice(0, 300).map(rowOf); // Issue #182.
  const olderJobs = sortedJobs.slice(300, 2300).map(rowOf);
  const jobById = new Map(jobs.map(j => [j.id, j]));
  const verdictRows = Object.entries(state.verdicts || {}).map(([key, v]) => { const [pr, head] = key.split(':'); return { carry: v.carry && v.carriedFrom ? v.carry : null, pr: Number(pr), head: sha7(head), fullHead: /^[0-9a-f]{40}$/.test(head || '') ? head : null, reviewer: v.reviewer || null, model: modelOf(jobById.get(v.job)), verdict: v.verdict || null, at: v.at ?? null,
    findings: (Array.isArray(v.findings) ? v.findings : []).slice(0, 20).map(findingText), followUpIssue: v.followUpIssue ?? null }; }).filter(v => Number.isSafeInteger(v.pr)).sort((a, b) => (b.at || 0) - (a.at || 0));
  const reviewing = new Set(Object.values(queues).flat().filter(q => q.type === 'review').map(q => q.ref));   // issue #76: PRs waiting for a review
  const merged = new Map((state.mergeLog || []).map(m => [m.pr, m]));
  // Issue #855: merged, installed or verified. Installed: the PR is in a completed install (upgrade record verified). Verified: its live checks passed.
  const installedPrs = installedPrsOf(root);
  const verifiedPrs = new Set(Object.values((() => { try { return readVerification(root); } catch { return {}; } })()).filter(r => r && r.state === 'verified').map(r => r.pr));
  const prNumbers = new Set([...(cache.pulls || []).map(p => p.number), ...verdictRows.map(v => v.pr), ...merged.keys()]);
  const prs = [...prNumbers].sort((a, b) => b - a).map(n => {
    const p = (cache.pulls || []).find(x => x.number === n), vs = verdictRows.filter(v => v.pr === n), m = merged.get(n);
    const rel = Object.entries(state.jobs || {}).filter(([, tj]) => tj.pr === n).map(([id]) => jobById.get(id)).filter(Boolean);
    const relIds = new Set(rel.map(j => j.id));
    // Issue #928: implement and continue jobs carry the issue, not the PR, so attribute them through the PR's issue.
    const issueNo = names.issueOfPr(n)?.number ?? m?.issue ?? null;
    const early = Number.isSafeInteger(issueNo) ? jobs.filter(j => !relIds.has(j.id) && ['implement', 'continue'].includes(state.jobs?.[j.id]?.kind || j.kind) && (state.jobs?.[j.id]?.issue ?? j.issue) === issueNo) : [];
    const costJobs = [...rel, ...early];
    const prJobs = jobRows.filter(j => relIds.has(j.fullId));
    const key = p ? `${n}:${p.headRefOid}` : null;
    return { number: n, name: redact(names.pr(n).text, 300), full: redact(names.pr(n).full, 400), title: names.titleOf(names.issueOfPr(n)?.number) ?? p?.title ?? `PR #${n}`, issue: names.issueOfPr(n)?.number ?? null, agent: p ? agentOfBranch(config, p.headRefName) : (m?.agent || null), status: m ? 'merged' : p ? (p.isDraft ? 'draft' : 'open') : 'closed', stage: m ? stageOf({ merged: true, installed: installedPrs.has(n) || verifiedPrs.has(n), verified: verifiedPrs.has(n) }) : null, awaitingReview: reviewing.has(n),
      checks: p ? checksState(p.statusCheckRollup, retriedIn(state.cancelWatch, p, now)) : null, verdict: key && state.verdicts?.[key] ? state.verdicts[key].verdict : (vs[0]?.verdict ?? null), reviewRounds: vs.length, carry: p && key ? carryRecordOf(state.verdicts?.[key], p) : null,
      fixRounds: sumKeys(state.fixAttempts, n), rebaseRounds: sumKeys(state.rebaseAttempts, n),
      // Issue #717: second-opinion reviews (kept apart from verdicts, one per pr:head) and the implement time from the merge log, for foreman_rebase_stats.
      secondOpinionRounds: secondOpinionsOf(state, n).filter(o => !(o && (o.carry || o.carriedFrom))).length, secondOpinionCarried: secondOpinionsOf(state, n).filter(o => o && (o.carry || o.carriedFrom)).length, startedAt: Number.isFinite(m?.startedAt) ? m.startedAt : null,
      openedAt: (() => { const t = Date.parse(p?.createdAt); if (Number.isFinite(t)) return t; const f = costJobs.filter(j => (state.jobs?.[j.id]?.kind || j.kind) === 'implement' && Number.isFinite(j.updatedAt)).map(j => j.updatedAt); return f.length ? Math.min(...f) : null; })(),
      costUsd: costJobs.some(j => Number.isFinite(j.usage?.costUsdEstimate)) ? costJobs.reduce((s, j) => s + (Number.isFinite(j.usage?.costUsdEstimate) ? j.usage.costUsdEstimate : 0), 0) : null,
      tokens: rel.some(j => j.usage) ? rel.reduce((s, j) => s + (tokensOf(j) || 0), 0) : null,
      head: p?.headRefOid ?? null, needsHomeowner: (p?.labels || []).includes('needs-homeowner'), mergedAt: m?.mergedAt ?? null,
      url: `https://github.com/${repo}/pull/${n}`, verdicts: vs, jobs: prJobs,
      timeline: [...vs.map(v => ({ at: v.at, text: `${v.reviewer}${v.model ? ` (${v.model})` : ''}: ${v.verdict} at ${v.head}${v.findings.length ? ` (${v.findings.length} finding${v.findings.length === 1 ? '' : 's'})` : ''}` })),
        ...vs.filter(v => v.carry).map(v => ({ at: v.carry.at ?? v.at, text: `verdict ${carryText(v.carry)}` })), ...(m ? [{ at: m.mergedAt, text: 'merged' }] : []), ...prJobs.map(j => ({ at: j.startedAt, text: `${j.agent}: ${j.kind} job ${j.status}` }))].filter(r => Number.isFinite(r.at)).sort((a, b) => a.at - b.at) };
  });
  const byNo = new Map((cache.issues || []).map(i => [i.number, i]));
  const queueReason = new Map(Object.values(queues).flat().filter(q => q.type === 'issue').map(q => [q.ref, q.reason]));
  const excludedBy = new Map(excluded.map(e => [e.number, e.reason]));
  const issues = (cache.issues || []).slice().sort((a, b) => a.number - b.number).map(i => {
    const deps = i.prerequisites || [];
    return { number: i.number, name: redact(names.issue(i.number).text, 300), title: i.title, state: i.state, agent: agentNames.find(n => config.agents[n].issues.includes(i.number)) || null, needsHomeowner: (i.labels || []).includes('needs-homeowner'),
      dependsOn: deps, blockedBy: deps.filter(d => byNo.get(d)?.state !== 'CLOSED'), reason: queueReason.get(i.number) || excludedBy.get(i.number) || null, url: `https://github.com/${repo}/issues/${i.number}`, labels: i.labels || [],
      createdAt: Number.isFinite(Date.parse(i.createdAt)) ? Date.parse(i.createdAt) : null, closedAt: Number.isFinite(Date.parse(i.closedAt)) ? Date.parse(i.closedAt) : null };
  });
  const issueTimelines = issueTimelinesOf({ jobs, state, names, jobRows, cache });
  const tickAt = cache.tick?.at ?? null;
  const nextTick = teamEnabled ? tickCountdown({ lastAt: tickAt, runningSince: root ? runningTickSince(root) : null, now }) : null;
  const ctx = { ticks: sup.ticks, jobs, state, cache, now };
  const consolidated = consolidateNeedsYou(attention, { cache });
  const needsYou = consolidated.needsYou.map(a => {
    // `ai-supervisor status <id>` prints the job record (there is no `job` command).
    const command = COMMANDS[a.id] || (a.id.startsWith('job-') ? `ai-supervisor status ${a.id.slice(4, 36)}` : null);
    const watch = a.id.startsWith('job-') && transcriptExists(root, a.id.slice(4)) ? a.id.slice(4) : null;
    return { ...a, watch, why: a.text, decision: a.action || NEXT_STEP[a.id] || NEXT_STEP[a.id.split('-')[0]] || 'Decide how to proceed.', command, overseer: attentionOverseer(a, { ...ctx, command }) };
  });
  const supervisor = { severity: sup.severity, logFound: sup.logFound, cards: sup.cards.map(c => ({ ...c, overseer: cardOverseer(c, ctx) })), ticks: sup.ticks, upgrades: sup.upgrades };
  return {
    display: { gbpPerUsd: config.display?.gbp_per_usd ?? DEFAULT_GBP_PER_USD },   // issue #1097: the rate the cost figures were shown with, for the MCP tools
    health: healthOf({ attention, states, teamEnabled, needsYouCount: needsYou.length }), freshness: freshness(tickAt, now),
    nextTick, nextTickAt: nextTick?.state === 'scheduled' ? nextTick.at : null, dependencies: cache.dependencies ?? null,
    wakes: root ? (() => { try { return wakeView(root, now); } catch { return null; } })() : null,   // issue #985
    version: ver && { ...ver, latched: !!sup.cards.find(c => c.id === 'version')?.latch },
    panels: { nextWhy: nextWhy({ states, issues, prs, names }), needsYou,
      inbox, inboxSearch, inboxDecided: config.inbox?.dir ? decidedInboxCards(config.inbox.dir, now) : [], later: laterOf({ cache, state, pauseText, names, config }), warnings: [...attention.filter(a => a.severity !== 'action'), ...consolidated.notices].map(a => ({ ...a, overseer: attentionOverseer(a, { ...ctx, command: COMMANDS[a.id] || null }) })), next: plan.map(a => ({ agent: a.agent || null, type: a.type, ref: a.issue ?? a.pr, name: redact(a.type === 'inbox' ? `Overseer proposal: ${a.title}` : (['implement', 'continue'].includes(a.type) ? names.issue(a.issue) : names.pr(a.pr)).text, 300), ...nextWhyFields(a, redact) })) },
    failedSpend: failedSpend(jobRows),
    slots: roleSlots(config, jobs, state, names), jobs: jobRows, olderJobs, issueTimelines, modelUsage: modelUsage(jobRows), verdicts: verdictRows, prs, issues, excluded, supervisor
  };
}
