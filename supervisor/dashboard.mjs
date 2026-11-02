// View model of the team dashboard (issue #32). Pure functions over data the tick already stored: supervisor job records,
// the team state, the GitHub cache and the snapshot history. No GitHub call, no model call, no write.
import fs from 'node:fs';
import path from 'node:path';
import { Team, ROLES, agentOfBranch, checksState, loneCancelled, prerequisites, roleOfType } from './team.mjs';
import { STALE_TICK_MS, agentStates, latestAllowance, redact, readVersion } from './dashdata.mjs';
import { planningInputs } from './planning.mjs';
import { readMigrationState, readIncidents } from './migrations.mjs';
import { severityOf } from './dashui/logic.mjs';
import { hasReading, windowExpired } from './allowance.mjs';
import { attentionOverseer, cardOverseer, supervisorHealth } from './suphealth.mjs';
import { MODE_LABEL } from './budget.mjs';

const sha7 = s => String(s || '').slice(0, 7);
const ACTIVE = ['queued', 'running', 'paused_limit', 'paused_manual'];
export const EXHAUSTED = 0.995;       // a window at or above this fraction used counts as exhausted
export const windowLabel = (w, provider) => {
  if (w.type === 'five_hour') return '5-hour';
  if (w.type === 'seven_day') return 'weekly';
  if (w.windowMinutes === 300) return '5-hour';
  if (w.windowMinutes === 10080) return 'weekly';
  return String(w.type || provider).replace(/_/g, ' ');
};

const DEAD = ['rejected', 'blocked', 'exhausted', 'limit_reached'];
const fullWindow = w => (Number.isFinite(w.utilization) && w.utilization >= EXHAUSTED) || DEAD.includes(w.status);
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
export function pauseDisagreement(job, allowance, now) {
  if (!job || job.status !== 'paused_limit' || job.lastEvent !== 'usage_limit') return null;
  if (!hasReading(allowance)) return { kind: 'unverifiable', text: 'paused on a usage limit but the provider has reported no allowance data to confirm it' };
  const last = `last reading: ${readingText(allowance, now)}`;
  const full = allowance.windows.filter(fullWindow);
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
  const used = known.map(w => `${windowLabel(w, allowance.provider)} ${Math.round(w.utilization * 100)}%`).join(', ');
  const at = allowance.observedAt ? ` (reported ${new Date(allowance.observedAt).toISOString().slice(11, 16)} UTC)` : '';
  return { kind: 'disagrees', text: `paused on a usage limit but the provider reports capacity left: ${used} used${at}` };
}

// What the Usage card says about a limit pause: when the limit resets and on what basis. Never an invented time.
function limitView(job, allowance, now) {
  if (job.resetAt) return { since: pausedAt(job), resetsAt: job.resetAt, basis: 'reported with the limit', retryAt: job.nextAttemptAt || null };
  const full = (allowance?.windows || []).filter(w => fullWindow(w) && !windowExpired(w, now) && Number.isFinite(w.resetsAt));
  const w = full.sort((a, b) => b.resetsAt - a.resetsAt)[0];
  return { since: Number.isFinite(pausedAt(job)) ? pausedAt(job) : null, resetsAt: w ? w.resetsAt : null, basis: w ? `${windowLabel(w, allowance.provider)} window in the last reading` : null, retryAt: job.nextAttemptAt || null };
}

function cacheBackedTeam(config, root, cache, jobs, state, snapshots = [], now = Date.now(), events = [], register = '') {
  const gh = { listPulls: async () => cache.pulls || [], listIssues: async () => (cache.issues || []).map(i => ({ ...i, labels: i.labels || [] })),
    // delivered-work issue numbers the tick cached, in the shape Team.plan() reads, so the page matches `team tick --dry-run`
    listMergedPulls: async () => [{ headRefName: '', closingIssuesReferences: (cache.delivered || []).map(number => ({ number })) }] };
  const jobsApi = { listActive: async () => jobs.filter(j => ACTIVE.includes(j.status)).map(j => ({ id: j.id, provider: j.provider, status: j.status })) };
  // The same planning inputs as the tick (issues #56, #121): probes included, so the page shows the allowance modes, holds and
  // reassignments `team tick --dry-run` would.
  const { allowanceOf, limitedOf, usage } = planningInputs({ config, jobs, probes: cache.probes, snapshots, events, now });
  const team = new Team({ config, root, gh, jobs: jobsApi, git: null, register, allowanceOf, limitedOf, usage, clock: { now: () => now } });
  team.s = { ...team.s, ...state };      // the state the caller read, so the plan and the page agree
  for (const k of ['verdicts', 'jobs', 'fixAttempts', 'continueAttempts', 'reviewAttempts', 'notified', 'posted', 'merged', 'implemented', 'budget', 'rebaseAttempts', 'escalations', 'unusable', 'unblock']) team.s[k] ||= {};
  for (const k of ['pr', 'day', 'limit', 'flags', 'resumed', 'escalated', 'queued']) team.s.unblock[k] ||= {};
  team.s.unblock.log ||= [];
  return team;
}

function reasons(team, cache, jobs, plan, states) {
  const c = team.c, S = team.s, prs = cache.pulls || [], issues = cache.issues || [];
  const byNo = new Map(issues.map(i => [i.number, i]));
  const planned = new Set(plan.map(a => `${a.agent}:${a.type}:${a.issue ?? a.pr}`));
  const queues = Object.fromEntries(Object.keys(c.agents).map(n => [n, []]));
  const activeJobs = jobs.filter(j => ACTIVE.includes(j.status));
  const busy = agent => states[agent].state !== 'idle' && states[agent].state !== 'blocked';
  const label = pr => `PR #${pr.number}`;
  for (const pr of prs) {
    const author = agentOfBranch(c, pr.headRefName);
    const key = `${pr.number}:${pr.headRefOid}`;
    const v = S.verdicts?.[key];
    const checks = checksState(pr.statusCheckRollup);
    if (!author) continue;
    let reason;
    if (pr.isDraft) reason = planned.has(`${author}:continue:${pr.number}`) ? 'draft; the agent continues it next' : (S.continueAttempts?.[pr.number] || 0) >= c.limits.max_fix_attempts ? 'draft; continue limit reached, needs the homeowner' : 'draft';
    else if (checks === 'pending') reason = 'waiting on CI';
    else if (checks === 'red') reason = 'CI failing';
    else if (checks === 'none') reason = 'no CI checks reported';
    else if (v?.verdict === 'CHANGES') reason = `CHANGES from ${v.reviewer} on ${sha7(pr.headRefOid)}; fix ${planned.has(`${author}:fix:${pr.number}`) ? 'is next' : 'waits for a free slot'}`;
    else if (v?.verdict === 'PASS') reason = pr.mergeable === 'MERGEABLE' ? `PASS from ${v.reviewer}; merges on the next tick` : `PASS from ${v.reviewer} but not mergeable (${String(pr.mergeable || 'unknown').toLowerCase()})`;
    else reason = `waiting for a reviewer on a different model: review of ${sha7(pr.headRefOid)}`;
    queues[author].push({ type: 'pr', ref: pr.number, title: pr.title, reason, next: planned.has(`${author}:fix:${pr.number}`) || planned.has(`${author}:continue:${pr.number}`), url: pr.url });
    if (!pr.isDraft && checks === 'green' && !v) for (const reviewer of Object.keys(c.agents).filter(n => !team.reviewRefusal(n, pr, `${key}:${n}`))) {   // agents whose review model is not a model that wrote the head
      const isNext = planned.has(`${reviewer}:review:${pr.number}`);
      const attempts = S.reviewAttempts?.[`${key}:${reviewer}`] || 0;
      queues[reviewer].push({ type: 'review', ref: pr.number, title: pr.title, reason: `review ${label(pr)} at ${sha7(pr.headRefOid)}${isNext ? ' (next)' : attempts >= c.limits.max_review_attempts ? ' (attempt limit reached)' : team.held?.[reviewer]?.review ? ` (held: ${team.held[reviewer].review})` : busy(reviewer) ? ' (after the running job)' : ''}`, next: isNext, url: pr.url });
    }
  }
  for (const [agent, a] of Object.entries(c.agents)) for (const n of a.issues) {
    const issue = byNo.get(n);
    if (!issue || issue.state !== 'OPEN' || team.delivered?.has(n)) continue;
    const deps = c.depends_on_overrides?.[n] ?? issue.prerequisites ?? prerequisites(issue.body);
    const open = deps.filter(d => byNo.get(d)?.state !== 'CLOSED');
    const prOf = prs.find(p => agentOfBranch(c, p.headRefName) && new RegExp(`/issue-${n}(\\D|$)`).test(p.headRefName));
    const hasPr = !!prOf && agentOfBranch(c, prOf.headRefName) === agent;
    const taker = plan.find(x => x.type === 'implement' && x.issue === n && x.reassignedFrom === agent);
    const moved = Object.values(S.jobs || {}).find(j => j.kind === 'implement' && j.issue === n && j.reassignedFrom === agent);
    const mode = team.modes?.[agent];
    const running = activeJobs.some(j => ['implement', 'continue'].includes(j.kind) && j.issue === n);
    let reason;
    if (issue.labels.includes('needs-homeowner')) reason = 'needs the homeowner';
    else if (open.length) reason = `blocked by ${open.map(d => `#${d}`).join(', ')}`;
    else if (running) reason = 'being implemented now';
    else if (hasPr) reason = 'PR open';
    else if (prOf || moved) reason = `reassigned for allowance to ${moved?.agent || agentOfBranch(c, prOf.headRefName)}${prOf ? `; PR #${prOf.number} open` : ''}`;
    else if (S.implemented?.[n]) reason = 'started earlier; no PR yet';
    else if (taker) reason = `next: taken from ${agent} by ${taker.agent}: ${agent} has no allowance${untilText(team.ownerOut(agent)?.until, team)} (${taker.agent} takes it; ${agent} keeps ownership)`;
    else if (planned.has(`${agent}:implement:${n}`)) reason = 'next: implement';
    else if (mode && mode.mode !== 'normal') reason = `waits: ${agent} is ${MODE_LABEL[mode.mode]} (${mode.reason}); no agent with headroom can take it`;
    else if (team.held?.[agent]?.implement) reason = `waits: ${team.held[agent].implement}`;
    else if (busy(agent)) reason = 'ready; waits behind the running job';
    else { const ahead = plan.find(x => x.agent === agent); reason = ahead ? `ready; waits behind ${ahead.type} ${['implement', 'continue'].includes(ahead.type) ? '#' : 'PR #'}${ahead.issue ?? ahead.pr}` : 'ready; waits for a free slot'; }
    queues[agent].push({ type: 'issue', ref: n, title: issue.title, reason, next: planned.has(`${agent}:implement:${n}`) });
  }
  for (const q of Object.values(queues)) q.sort((x, y) => (y.next - x.next) || (x.ref - y.ref));
  return queues;
}

// Why an idle agent is idle, in plain words (issue #50). Homeowner waits first, then what is in flight, then drafts, then blocked issues.
// Returns { text, links } where links are { text, url } for the PRs and issues named; null when the agent is not idle or has a planned job.
export function idleReason({ agent, config, team, cache, plan, state }) {
  if (state !== 'idle') return null;
  if (config.enabled === false) return { text: 'the team loop is switched off', links: [] };
  const next = plan.find(a => a.agent === agent);
  if (next) return { text: `about to start ${next.type === 'cifix' ? 'fix CI on' : next.type} ${['implement', 'continue'].includes(next.type) ? '#' : 'PR #'}${next.issue ?? next.pr} on the next tick`, links: [] };
  const c = team.c, a = c.agents[agent], L = c.limits, S = team.s, prs = cache.pulls || [], issues = cache.issues || [];
  const byNo = new Map(issues.map(i => [i.number, i]));
  const url = (kind, n) => `https://github.com/${config.repository}/${kind}/${n}`;
  const parts = [], links = [];
  const m = team.modes?.[agent];
  if (m && m.mode !== 'normal') parts.push({ rank: 0, text: `${MODE_LABEL[m.mode]}: ${m.reason}` });
  const part = (rank, text, kind, n) => { parts.push({ rank, text }); links.push({ text: `${kind === 'pull' ? 'PR' : 'issue'} #${n}`, url: url(kind, n) }); };
  const mine = prs.filter(p => agentOfBranch(c, p.headRefName) === agent);
  for (const p of mine) {
    const v = S.verdicts?.[`${p.number}:${p.headRefOid}`], checks = checksState(p.statusCheckRollup);
    if (p.isDraft) {
      if ((S.continueAttempts?.[p.number] || 0) >= L.max_fix_attempts) part(0, `waiting for homeowner: continue limit reached on draft #${p.number}`, 'pull', p.number);
      else part(2, `only work is draft #${p.number}`, 'pull', p.number);
    } else if ((v?.verdict === 'CHANGES' || checks === 'red') && team.fixCount(p.number) >= L.max_fix_attempts) {
      if (team.escalationPending(p.number)) part(1, `fix limit reached on #${p.number}: one escalated round pending`, 'pull', p.number);
      else part(0, `waiting for homeowner: fix limit reached on #${p.number}`, 'pull', p.number);
    }
    else if (p.mergeable === 'CONFLICTING') part(1, `waiting to rebase #${p.number}`, 'pull', p.number);
    else if (checks === 'pending') part(1, `waiting on CI for #${p.number}`, 'pull', p.number);
    else if (v?.verdict === 'PASS') part(1, `#${p.number} has a PASS and merges on the next tick`, 'pull', p.number);
    else part(1, `waiting for review of #${p.number}`, 'pull', p.number);
  }
  const blockers = new Set();
  let openIssues = 0;
  for (const n of a.issues) {
    const issue = byNo.get(n);
    if (!issue || issue.state !== 'OPEN' || team.delivered?.has(n)) continue;
    if (issue.labels.includes('needs-homeowner')) { part(0, `waiting for homeowner: #${n} needs the homeowner`, 'issue', n); continue; }
    if (mine.some(p => new RegExp(`/issue-${n}(\\D|$)`).test(p.headRefName))) continue;
    openIssues++;
    const open = (c.depends_on_overrides?.[n] ?? issue.prerequisites ?? prerequisites(issue.body)).filter(d => byNo.get(d)?.state !== 'CLOSED');
    if (open.length) open.forEach(d => blockers.add(d));
  }
  if (openIssues && blockers.size) { parts.push({ rank: 3, text: `all issues blocked by ${[...blockers].sort((x, y) => x - y).map(d => `#${d}`).join(', ')}` }); for (const d of blockers) links.push({ text: `issue #${d}`, url: url('issues', d) }); }
  else if (openIssues && !(m && m.mode !== 'normal')) parts.push({ rank: 3, text: 'has an open issue but nothing started it yet (limits or a lease may be holding it)' });
  if (!parts.length) return { text: 'no open issue or pull request is assigned to it', links: [] };
  parts.sort((x, y) => x.rank - y.rank);
  return { text: parts.slice(0, 3).map(x => x.text).join('; '), links: links.slice(0, 6) };
}

function attentionItems({ config, cache, jobs, states, plan, snapshots, now, allowance, teamEnabled, state = {} }) {
  const items = [], add = (id, text, ref) => items.push({ id, text: redact(text, 300), ref: ref || null });
  const t = cache?.tick;
  if (!t) add('no-tick', 'No tick has ever been recorded: the dispatcher has not run since the dashboard was installed.');
  else {
    if (t.status === 'error') add('tick-failed', `Last tick failed at ${new Date(t.at).toISOString()}: ${t.error || 'no detail recorded'}`);
    if (teamEnabled !== false && t.status !== 'disabled' && now - t.at > STALE_TICK_MS) add('tick-stale', `No tick for ${Math.round((now - t.at) / 60000)} minutes (last ${new Date(t.at).toISOString()}); the reconcile cron may have stopped.`);
  }
  for (const i of cache?.issues || []) if (i.state === 'OPEN' && i.labels?.includes('needs-homeowner')) add(`homeowner-${i.number}`, `Issue #${i.number} needs the homeowner: ${i.title}`, { kind: 'issue', n: i.number });
  for (const j of jobs) if (['blocked', 'failed'].includes(j.status) && now - (j.updatedAt || 0) < 48 * 3600000 && !jobs.some(k => k.id !== j.id && k.provider === j.provider && k.issue === j.issue && (k.createdAt || 0) > (j.createdAt || 0)))
    add(`job-${j.id}`, `Job ${j.id.slice(0, 8)} (${j.provider} ${j.kind || 'job'} #${j.issue}) is ${j.status}: ${redact(j.lastEvent || 'unknown reason', 60)}.`, { kind: ['implement', 'continue'].includes(j.kind) ? 'issue' : 'pull', n: j.issue });
  // issue #158: a rebase that dropped commits, while the PR still sits on that rebased head
  for (const [id, tj] of Object.entries(state.jobs || {})) {
    const pr = (cache?.pulls || []).find(x => x.number === tj.pr);
    if (tj.kind === 'rebase' && tj.rebase?.lost?.length && pr && pr.headRefOid === tj.rebase.newHead)
      add(`rebase-lost-${id.slice(0, 8)}`, `Rebase job ${id.slice(0, 8)} dropped ${tj.rebase.lost.length} commit(s) from PR #${tj.pr}: ${tj.rebase.lost.map(c => `${sha7(c.sha)} ${c.subject}`).join('; ')}`, { kind: 'pull', n: tj.pr });
  }
  for (const pr of cache?.pulls || []) if (!pr.isDraft && checksState(pr.statusCheckRollup) === 'red') add(`ci-${pr.number}`, `CI is red on PR #${pr.number}: ${pr.title}`, { kind: 'pull', n: pr.number });
  // issue #149: a cancelled check that was rerun once and is still cancelled
  for (const pr of cache?.pulls || []) if (!pr.isDraft && state.cancelWatch?.[`${pr.number}:${pr.headRefOid}`]?.noticed && loneCancelled(pr.statusCheckRollup).length) add(`ci-cancelled-${pr.number}`, `CI was cancelled and, after one rerun, is still not green on PR #${pr.number}: ${pr.title}`, { kind: 'pull', n: pr.number });
  // idle while there is work: the same plan was present, with the agent idle, in every snapshot of the last 9+ minutes
  const recent = snapshots.filter(s => now - s.at <= 30 * 60000).sort((a, b) => a.at - b.at);
  for (const [agent, s] of Object.entries(states)) {
    if (s.state !== 'idle') continue;
    const work = plan.filter(a => a.agent === agent);
    if (!work.length) continue;
    if (teamEnabled === false) { add(`idle-${agent}`, `${agent} is idle with work waiting (${work.map(a => `${a.type} #${a.issue ?? a.pr}`).join(', ')}) and the team loop is disabled.`); continue; }
    const mine = recent.filter(x => x.agents?.[agent] === 'idle' && x.plan?.some(a => a.agent === agent));
    if (mine.length >= 2 && mine.at(-1).at - mine[0].at >= 9 * 60000) add(`idle-${agent}`, `${agent} has been idle for ${Math.round((now - mine[0].at) / 60000)}+ minutes while ${work.map(a => `${a.type} #${a.issue ?? a.pr}`).join(', ')} waits.`);
  }
  for (const [agent, s] of Object.entries(states)) {
    if (s.state !== 'paused') continue;
    const a = config.agents[agent];
    const own = hasReading(s.job?.allowance) ? s.job.allowance : null, fresh = allowance[a.provider] || null;   // judge by the newest reading the provider reported
    const finding = pauseDisagreement(s.job, own && (!fresh || (own.observedAt || 0) >= (fresh.observedAt || 0)) ? own : fresh, now);
    if (finding) add(`pause-${agent}`, `${agent}: ${finding.text}.${finding.kind === 'disagrees' ? ' Check the provider yourself; the pause may be wrong.' : ''}`, { kind: 'issue', n: s.job.issue });
  }
  return items;
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
function graphs({ config, jobs, state, snapshots, now }) {
  const agents = Object.keys(config.agents);
  // Allowance % over time per agent. A sample is drawn only while its reading is current: once the reported reset time has
  // passed, the line ends and an "expected reset" marker is placed at that time (issue #75), instead of holding a stale value
  // up to now. A new reading after the reset starts a new segment (gap). "resets" are reset-time changes seen between
  // snapshots that no expiry already explains.
  const allowance = {};
  for (const agent of agents) {
    const samples = {};
    for (const s of snapshots.filter(x => now - x.at <= 30 * DAY).sort((a, b) => a.at - b.at)) {
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
    if (!j.createdAt || now - j.createdAt > 30 * DAY) continue;
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

function activity({ config, jobs, events, state, cache, snapshots, now, incidents = [] }) {
  const repo = config.repository, rows = [];
  const jobById = new Map(jobs.map(j => [j.id, j]));
  const link = (kind, n) => (n ? { url: `https://github.com/${repo}/${kind === 'pull' ? 'pull' : 'issues'}/${n}`, text: `${kind === 'pull' ? 'PR' : 'issue'} #${n}` } : null);
  const jobLink = j => (['implement', 'continue'].includes(j.kind) ? link('issue', j.issue) : link('pull', j.issue));
  const agentName = j => Object.entries(config.agents).find(([, a]) => a.provider === j.provider)?.[0] || j.provider;
  const names = { created: 'job queued', started: 'job started', completed: 'job finished', usage_limit: 'paused on usage limit', manual_pause: 'paused by hand', recovered: 'job recovered', incomplete: 'ended without its post-condition', retry_exhausted: 'blocked: retries exhausted', transient_rate_limit: 'paused on transient rate limit', manual_stop: 'stopped by hand' };
  for (const e of events) {
    if (!names[e.kind] && !['blocked', 'crash', 'auth_error', 'approval_required', 'issue_closed', 'stale_handover'].includes(e.kind)) continue;
    const j = jobById.get(e.job); if (!j) continue;
    rows.push({ at: e.at, text: `${agentName(j)}: ${names[e.kind] || redact(e.kind, 40)} (${j.kind || 'job'})`, link: jobLink(j) });
  }
  for (const [id, tj] of Object.entries(state.jobs || {})) if (tj.kind === 'rebase' && tj.rebase && Number.isFinite(tj.at))
    rows.push({ at: tj.at, text: `rebase of PR #${tj.pr}: ${sha7(tj.rebase.oldHead)} -> ${sha7(tj.rebase.newHead)}, ${tj.rebase.commits.length} commit(s): ${tj.rebase.commits.slice(0, 8).map(c => sha7(c.sha)).join(' ')}${tj.rebase.lost?.length ? `; LOST ${tj.rebase.lost.map(c => sha7(c.sha)).join(' ')}` : ''}`, link: link('pull', tj.pr) });
  for (const u of state.unblock?.log || []) if (Number.isFinite(u.at)) rows.push({ at: u.at, text: `Foreman unblocked: ${u.what}, ${u.why}, ${u.result}`, link: link(u.tk === 'issue' ? 'issue' : 'pull', u.target) });
  for (const [key, v] of Object.entries(state.verdicts || {})) { const [pr, head] = key.split(':'); rows.push({ at: v.at, text: `${v.reviewer}: ${v.verdict} on PR #${pr} at ${sha7(head)}`, link: link('pull', Number(pr)) }); }
  for (const m of state.mergeLog || []) rows.push({ at: m.mergedAt, text: `merged PR #${m.pr}${m.agent ? ` (${m.agent})` : ''}`, link: link('pull', m.pr) });
  for (const i of incidents) if (i.kind === 'migration') rows.push({ at: i.at, text: `config migration ${String(i.number).padStart(3, '0')}-${i.name} ${i.result}${i.result === 'failed' ? `: ${i.error}` : `: ${i.description || ''}`}`, link: null });
  // ticks take part in the same newest-first ordering and 50-event bound as every other event (issue #32)
  rows.push(...snapshots.map(s => ({ at: s.at, text: s.status === 'ok'
    ? `tick ok${s.plan?.length ? `, plan: ${s.plan.map(a => `${a.agent || ''} ${a.type} #${a.ref}`.trim()).join('; ')}` : ', nothing to dispatch'}`
    : `tick ${s.status}${cache?.tick?.at === s.at && cache.tick.error ? `: ${cache.tick.error}` : ''}` })));
  if (cache?.tick && cache.tick.status !== 'ok' && !snapshots.some(s => s.at === cache.tick.at))
    rows.push({ at: cache.tick.at, text: `tick ${cache.tick.status}${cache.tick.error ? `: ${cache.tick.error}` : ''}` });
  return rows.filter(r => Number.isFinite(r.at)).sort((a, b) => b.at - a.at).slice(0, 50).map(r => ({ ...r, text: redact(r.text, 300) }));
}

// Weekly burn and scheduling mode per agent, as the planner sees it (issue #56). Figures are the provider's own readings.
export function budgetView(team) {
  const out = {};
  for (const [name, m] of Object.entries(team.modes || {})) {
    const typical = m.costs?.cost ? { implement: m.costs.cost('implement'), review: m.costs.cost('review'), fix: m.costs.cost('fix') } : {};
    out[name] = { mode: m.mode, label: MODE_LABEL[m.mode], reason: redact(m.reason || '', 300), until: m.until ?? null, known: m.known, used: m.used, resetsAt: m.resetsAt, hoursLeft: m.hoursLeft, ratePerHour: m.ratePerHour, rateSource: m.rateSource,
      projected: m.projected, runsOutAt: m.runsOutAt, shortWindow: m.shortWindow, overage: m.overage, creditsAvailable: m.creditsAvailable, jobCost: typical,
      held: Object.fromEntries(Object.entries(team.held?.[name] || {}).map(([k, v]) => [k, redact(v, 300)])) };
  }
  return out;
}

const untilText = (until, team) => (Number.isFinite(until) ? ` until ${new Intl.DateTimeFormat('en-GB', { timeZone: team.timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(until)).replace(',', '')}` : '');
export const REGISTER_NOTE = 'Cannot read docs/DECISIONS.md from origin/main: the real tick would refuse to launch jobs.';
// Role slots (issue #148): who holds the implementer and reviewer slot right now, with the model and the work. A job the dispatcher has
// no record of (started by hand) counts against the implementer slot, as the planner counts it.
const SLOT_LABEL = { implementer: 'Implementer', reviewer: 'Reviewer' };
const SLOT_WHAT = { implement: 'implementing', continue: 'continuing', review: 'reviewing', fix: 'fixing', rebase: 'rebasing', cifix: 'fixing CI' };
export function roleSlots(config, jobs, state) {
  return ROLES.map(role => {
    const held = jobs.filter(j => ACTIVE.includes(j.status) && roleOfType(state.jobs?.[j.id]?.kind) === role).map(j => {
      const r = state.jobs?.[j.id] || {}, agent = r.agent || Object.entries(config.agents).find(([, a]) => a.provider === j.provider)?.[0] || j.provider;
      return { agent: redact(agent, 20), model: r.model ? redact(r.model, 40) : null, kind: r.kind || null, ref: r.pr ?? r.issue ?? j.issue ?? null, refType: r.pr != null ? 'PR' : 'issue' };
    });
    const label = SLOT_LABEL[role];
    const text = held.length ? `${label}: ${held.map(h => [h.agent, h.model, h.ref != null ? `${h.refType === 'PR' ? 'PR #' : '#'}${h.ref}` : null, h.kind ? SLOT_WHAT[h.kind] || h.kind : null].filter(Boolean).join(' · ')).join('; ')}` : `${label}: idle`;
    return { role, label, capacity: config.limits?.roles?.[role] ?? 1, held, text };
  });
}

export function buildView({ config, root, jobs, events, state, cache, snapshots, now, register = '', registerUnreadable = false }) {
  const states = agentStates(config, jobs, now);
  const allowance = latestAllowance(jobs, cache?.probes);
  const c = cache || { pulls: [], issues: [] };
  const team = cacheBackedTeam(config, root, c, jobs, state, snapshots, now, events || [], register);
  return team.plan().then(plan => {
    const queues = reasons(team, c, jobs, plan, states);
    const agents = Object.entries(config.agents).map(([name, a]) => {
      const s = states[name], j = s.job;
      const base = { name, provider: a.provider, state: s.state, lastActivityAt: s.last ? Math.max(s.last.updatedAt || 0, s.last.lastProgress || 0) || null : null, job: null };
      base.idleReason = idleReason({ agent: name, config, team, cache: c, plan, state: s.state });
      if (j) base.job = { id: j.id.slice(0, 8), kind: j.kind || 'job', ref: j.issue, branch: redact(j.branch || '', 100), startedAt: j.createdAt, elapsedMs: now - j.createdAt, status: j.status, lastEvent: redact(j.lastEvent || '', 48), resetAt: j.resetAt || null, nextAttemptAt: j.nextAttemptAt || null, attempts: j.attempts || 0 };
      return base;
    });
    const attention = attentionItems({ config, cache, jobs, states, plan, snapshots, now, allowance, teamEnabled: config.enabled !== false, state }).map(a => ({ ...a, severity: severityOf(a.id) }));
    const ver = readVersion(root);
    if (ver?.drift) attention.push({ id: 'drift', text: `Installed supervisor ${sha7(ver.installed)} is behind main ${sha7(ver.main)}: deploy needed.`, ref: null, severity: 'warning' });
    // Issue #134: a pending supervisor upgrade holds back new jobs until the running ones finish.
    try { const h = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')).holding; if (h && typeof h.to === 'string') attention.push({ id: 'upgrade-hold', text: `Holding new jobs: upgrade to ${sha7(h.to)} pending.`, ref: null, severity: 'info' }); } catch { /* no state file: nothing is held */ }
    // Issue #153: a failed config migration stops the ticks until the homeowner fixes team.local.json
    { const f = readMigrationState(root).failed; if (f) attention.push({ id: 'migration-failed', text: redact(`Config migration ${String(f.number).padStart(3, '0')}-${f.name} failed and ticks are stopped: ${f.error}. team.local.json was not changed.`, 300), ref: null, severity: 'action' }); }
    if (registerUnreadable) attention.push({ id: 'register-unreadable', text: REGISTER_NOTE, ref: null, severity: 'warning' });
    const sup = supervisorHealth({ root, config, jobs, now });
    const extra = dashExtras({ config, cache: c, jobs, state, states, plan, queues, attention, now, ver, sup });
    return {
      ...extra,
      generatedAt: now, repository: config.repository, teamEnabled: config.enabled !== false,
      tick: cache?.tick || null, cacheFetchedAt: cache?.fetchedAt || null,
      agents, queues, plan,
      budget: budgetView(team),
      attention,
      usage: usageView(config, jobs, states, allowance, now),
      graphs: graphs({ config, jobs, state, snapshots, now }),
      activity: activity({ config, jobs, events, state, cache, snapshots, now, incidents: readIncidents(root) })
    };
  });
}

// ---- issue #54: what the v2 pages need on top of the v1 model. Still pure: only data already stored by the tick.
export const TICK_INTERVAL_MS = 5 * 60000;
const NEXT_STEP = {
  homeowner: 'Open the issue and either answer it or remove the needs-homeowner label so the team can continue.',
  'tick-failed': 'Read the tick error; nothing is dispatched until a tick succeeds.',
  job: 'Read the job record, then retry it or close the issue.',
  migration: 'Fix team.local.json by hand (or remove the offending key), then the next tick retries the migration. The failed attempt left the file unchanged; backups are next to it.',
  rebase: 'Restore the dropped commits on the PR branch (the old head is still reachable by its id) before it is reviewed or merged.'
};
const COMMANDS = { 'tick-failed': 'ai-supervisor team tick --dry-run' };
export function healthOf({ attention, states, teamEnabled }) {
  if (attention.some(a => a.severity === 'action')) return { state: 'needs_you', label: 'Needs you', severity: 'action' };
  if (attention.some(a => /^(tick-stale|idle)/.test(a.id))) return { state: 'stuck', label: 'Stuck', severity: 'warning' };
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

function dashExtras({ config, cache, jobs, state, states, plan, queues, attention, now, ver, sup }) {
  const repo = config.repository, teamEnabled = config.enabled !== false;
  const agentNames = Object.keys(config.agents);
  const agentOf = j => agentNames.find(n => config.agents[n].provider === j.provider) || j.provider;
  const tokensOf = j => (j.usage ? j.usage.inputTokens + j.usage.outputTokens : null);
  const jobRows = jobs.filter(j => j.createdAt).sort((a, b) => b.createdAt - a.createdAt).slice(0, 300).map(j => ({
    id: j.id.slice(0, 8), fullId: j.id, agent: agentOf(j), kind: j.kind || 'job', ref: j.issue ?? null, status: j.status, attempts: j.attempts || 0,
    startedAt: j.createdAt, elapsedMs: (j.status === 'running' ? now : (j.updatedAt || j.createdAt)) - j.createdAt, tokens: tokensOf(j), inTokens: j.usage ? j.usage.inputTokens : null, outTokens: j.usage ? j.usage.outputTokens : null,
    cost: Number.isFinite(j.usage?.costUsdEstimate) ? j.usage.costUsdEstimate : null, model: j.model || null, effort: j.effort || null, modelReason: redact(j.modelReason || '', 200), reassignedFrom: state.jobs?.[j.id]?.reassignedFrom || null, reassignReason: redact(state.jobs?.[j.id]?.reassignReason || '', 300), branch: redact(j.branch || '', 100) }));
  const verdictRows = Object.entries(state.verdicts || {}).map(([key, v]) => { const [pr, head] = key.split(':'); return { pr: Number(pr), head: sha7(head), fullHead: /^[0-9a-f]{40}$/.test(head || '') ? head : null, reviewer: v.reviewer || null, verdict: v.verdict || null, at: v.at ?? null,
    findings: (Array.isArray(v.findings) ? v.findings : []).slice(0, 20).map(findingText), followUpIssue: v.followUpIssue ?? null }; }).filter(v => Number.isSafeInteger(v.pr)).sort((a, b) => (b.at || 0) - (a.at || 0));
  const merged = new Map((state.mergeLog || []).map(m => [m.pr, m]));
  const prNumbers = new Set([...(cache.pulls || []).map(p => p.number), ...verdictRows.map(v => v.pr), ...merged.keys()]);
  const prs = [...prNumbers].sort((a, b) => b - a).map(n => {
    const p = (cache.pulls || []).find(x => x.number === n), vs = verdictRows.filter(v => v.pr === n), m = merged.get(n);
    const rel = Object.entries(state.jobs || {}).filter(([, tj]) => tj.pr === n).map(([id]) => jobs.find(j => j.id === id)).filter(Boolean);
    const relIds = new Set(rel.map(j => j.id));
    const prJobs = jobRows.filter(j => relIds.has(j.fullId));
    const key = p ? `${n}:${p.headRefOid}` : null;
    return { number: n, title: p?.title || `PR #${n}`, agent: p ? agentOfBranch(config, p.headRefName) : (m?.agent || null), status: m ? 'merged' : p ? (p.isDraft ? 'draft' : 'open') : 'closed',
      checks: p ? checksState(p.statusCheckRollup) : null, verdict: key && state.verdicts?.[key] ? state.verdicts[key].verdict : (vs[0]?.verdict ?? null), reviewRounds: vs.length,
      fixRounds: sumKeys(state.fixAttempts, n), rebaseRounds: sumKeys(state.rebaseAttempts, n),
      tokens: rel.some(j => j.usage) ? rel.reduce((s, j) => s + (tokensOf(j) || 0), 0) : null,
      url: `https://github.com/${repo}/pull/${n}`, verdicts: vs, jobs: prJobs,
      timeline: [...vs.map(v => ({ at: v.at, text: `${v.reviewer}: ${v.verdict} at ${v.head}${v.findings.length ? ` (${v.findings.length} finding${v.findings.length === 1 ? '' : 's'})` : ''}` })),
        ...(m ? [{ at: m.mergedAt, text: 'merged' }] : []), ...prJobs.map(j => ({ at: j.startedAt, text: `${j.agent}: ${j.kind} job ${j.status}` }))].filter(r => Number.isFinite(r.at)).sort((a, b) => a.at - b.at) };
  });
  const byNo = new Map((cache.issues || []).map(i => [i.number, i]));
  const queueReason = new Map(Object.values(queues).flat().filter(q => q.type === 'issue').map(q => [q.ref, q.reason]));
  const issues = (cache.issues || []).slice().sort((a, b) => a.number - b.number).map(i => {
    const deps = i.prerequisites || [];
    return { number: i.number, title: i.title, state: i.state, agent: agentNames.find(n => config.agents[n].issues.includes(i.number)) || null, needsHomeowner: (i.labels || []).includes('needs-homeowner'),
      dependsOn: deps, blockedBy: deps.filter(d => byNo.get(d)?.state !== 'CLOSED'), reason: queueReason.get(i.number) || null, url: `https://github.com/${repo}/issues/${i.number}`, labels: i.labels || [] };
  });
  const tickAt = cache.tick?.at ?? null;
  const ctx = { ticks: sup.ticks, jobs, state, cache, now };
  const needsYou = attention.filter(a => a.severity === 'action').map(a => {
    // `ai-supervisor status <id>` prints the job record (there is no `job` command).
    const command = COMMANDS[a.id] || (a.id.startsWith('job-') ? `ai-supervisor status ${a.id.slice(4, 36)}` : null);
    return { ...a, why: a.text, decision: NEXT_STEP[a.id] || NEXT_STEP[a.id.split('-')[0]] || 'Decide how to proceed.', command, overseer: attentionOverseer(a, { ...ctx, command }) };
  });
  const supervisor = { severity: sup.severity, logFound: sup.logFound, cards: sup.cards.map(c => ({ ...c, overseer: cardOverseer(c, ctx) })), ticks: sup.ticks, upgrades: sup.upgrades };
  return {
    health: healthOf({ attention, states, teamEnabled }), freshness: freshness(tickAt, now),
    nextTickAt: Number.isFinite(tickAt) && teamEnabled ? tickAt + TICK_INTERVAL_MS : null, version: ver,
    panels: { needsYou, warnings: attention.filter(a => a.severity !== 'action'), next: plan.map(a => ({ agent: a.agent || null, type: a.type, ref: a.issue ?? a.pr, ...(a.reassignedFrom ? { reassignedFrom: a.reassignedFrom, why: redact(a.reassignReason, 300) } : {}) })) },
    slots: roleSlots(config, jobs, state), jobs: jobRows, modelUsage: modelUsage(jobRows), verdicts: verdictRows, prs, issues, supervisor
  };
}
