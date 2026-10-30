// View model of the team dashboard (issue #32). Pure functions over data the tick already stored: supervisor job records,
// the team state, the GitHub cache and the snapshot history. No GitHub call, no model call, no write.
import { Team, agentOfBranch, checksState, prerequisites } from './team.mjs';
import { STALE_TICK_MS, agentStates, latestAllowance, redact } from './dashdata.mjs';

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

// The rule behind "a usage pause that disagrees with the provider's own reported allowance".
// Returns null when the pause is consistent or cannot be judged, else a finding. `allowance` is what the provider reported
// (a job's `allowance` record, structured data from the CLI itself). A window with a known utilisation below the
// exhausted threshold is evidence of capacity; an exhausted window, a rejected status or an unknown reading is not.
export function pauseDisagreement(job, allowance, now) {
  if (!job || job.status !== 'paused_limit' || job.lastEvent !== 'usage_limit') return null;
  if (!allowance || !Array.isArray(allowance.windows) || !allowance.windows.length) return { kind: 'unverifiable', text: 'paused on a usage limit but the provider has reported no allowance data to confirm it' };
  const known = allowance.windows.filter(w => Number.isFinite(w.utilization));
  const exhausted = allowance.windows.some(w => (Number.isFinite(w.utilization) && w.utilization >= EXHAUSTED) || ['rejected', 'blocked', 'exhausted', 'limit_reached'].includes(w.status));
  // Same exhausted-status semantics as limitFromAllowance(): a rejected/blocked/exhausted allowance confirms the pause.
  if (exhausted || ['rejected', 'blocked', 'exhausted', 'limit_reached'].includes(allowance.status)) return null;
  if (!known.length) return { kind: 'unverifiable', text: 'paused on a usage limit but the reported allowance has no utilisation figures to confirm it' };
  const used = known.map(w => `${windowLabel(w, allowance.provider)} ${Math.round(w.utilization * 100)}%`).join(', ');
  const at = allowance.observedAt ? ` (reported ${new Date(allowance.observedAt).toISOString().slice(11, 16)} UTC)` : '';
  return { kind: 'disagrees', text: `paused on a usage limit but the provider reports capacity left: ${used} used${at}` };
}

function cacheBackedTeam(config, root, cache, jobs, state) {
  const gh = { listPulls: async () => cache.pulls || [], listIssues: async () => (cache.issues || []).map(i => ({ ...i, labels: i.labels || [] })),
    // delivered-work issue numbers the tick cached, in the shape Team.plan() reads, so the page matches `team tick --dry-run`
    listMergedPulls: async () => [{ headRefName: '', closingIssuesReferences: (cache.delivered || []).map(number => ({ number })) }] };
  const jobsApi = { listActive: async () => jobs.filter(j => ACTIVE.includes(j.status)).map(j => ({ id: j.id, provider: j.provider, status: j.status })) };
  const team = new Team({ config, root, gh, jobs: jobsApi, git: null });
  team.s = { ...team.s, ...state };      // the state the caller read, so the plan and the page agree
  for (const k of ['verdicts', 'jobs', 'fixAttempts', 'continueAttempts', 'reviewAttempts', 'notified', 'posted', 'merged', 'implemented']) team.s[k] ||= {};
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
    const other = Object.keys(c.agents).filter(n => n !== author);
    let reason;
    if (pr.isDraft) reason = planned.has(`${author}:continue:${pr.number}`) ? 'draft; the agent continues it next' : (S.continueAttempts?.[pr.number] || 0) >= c.limits.max_fix_attempts ? 'draft; continue limit reached, needs the homeowner' : 'draft';
    else if (checks === 'pending') reason = 'waiting on CI';
    else if (checks === 'red') reason = 'CI failing';
    else if (checks === 'none') reason = 'no CI checks reported';
    else if (v?.verdict === 'CHANGES') reason = `CHANGES from ${v.reviewer} on ${sha7(pr.headRefOid)}; fix ${planned.has(`${author}:fix:${pr.number}`) ? 'is next' : 'waits for a free slot'}`;
    else if (v?.verdict === 'PASS') reason = pr.mergeable === 'MERGEABLE' ? `PASS from ${v.reviewer}; merges on the next tick` : `PASS from ${v.reviewer} but not mergeable (${String(pr.mergeable || 'unknown').toLowerCase()})`;
    else reason = `awaiting ${other.join('/')} review of ${sha7(pr.headRefOid)}`;
    queues[author].push({ type: 'pr', ref: pr.number, title: pr.title, reason, next: planned.has(`${author}:fix:${pr.number}`) || planned.has(`${author}:continue:${pr.number}`), url: pr.url });
    if (!pr.isDraft && checks === 'green' && !v) for (const reviewer of other) {
      const isNext = planned.has(`${reviewer}:review:${pr.number}`);
      const attempts = S.reviewAttempts?.[`${key}:${reviewer}`] || 0;
      queues[reviewer].push({ type: 'review', ref: pr.number, title: pr.title, reason: `review ${label(pr)} at ${sha7(pr.headRefOid)}${isNext ? ' (next)' : attempts >= c.limits.max_review_attempts ? ' (attempt limit reached)' : busy(reviewer) ? ' (after the running job)' : ''}`, next: isNext, url: pr.url });
    }
  }
  for (const [agent, a] of Object.entries(c.agents)) for (const n of a.issues) {
    const issue = byNo.get(n);
    if (!issue || issue.state !== 'OPEN' || team.delivered?.has(n)) continue;
    const deps = c.depends_on_overrides?.[n] ?? issue.prerequisites ?? prerequisites(issue.body);
    const open = deps.filter(d => byNo.get(d)?.state !== 'CLOSED');
    const hasPr = prs.some(p => agentOfBranch(c, p.headRefName) === agent && new RegExp(`/issue-${n}(\\D|$)`).test(p.headRefName));
    const running = activeJobs.some(j => ['implement', 'continue'].includes(j.kind) && j.issue === n);
    let reason;
    if (issue.labels.includes('needs-homeowner')) reason = 'needs the homeowner';
    else if (open.length) reason = `blocked by ${open.map(d => `#${d}`).join(', ')}`;
    else if (running) reason = 'being implemented now';
    else if (hasPr) reason = 'PR open';
    else if (S.implemented?.[n]) reason = 'started earlier; no PR yet';
    else if (planned.has(`${agent}:implement:${n}`)) reason = 'next: implement';
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
  const part = (rank, text, kind, n) => { parts.push({ rank, text }); links.push({ text: `${kind === 'pull' ? 'PR' : 'issue'} #${n}`, url: url(kind, n) }); };
  const mine = prs.filter(p => agentOfBranch(c, p.headRefName) === agent);
  for (const p of mine) {
    const v = S.verdicts?.[`${p.number}:${p.headRefOid}`], checks = checksState(p.statusCheckRollup);
    if (p.isDraft) {
      if ((S.continueAttempts?.[p.number] || 0) >= L.max_fix_attempts) part(0, `waiting for homeowner: continue limit reached on draft #${p.number}`, 'pull', p.number);
      else part(2, `only work is draft #${p.number}`, 'pull', p.number);
    } else if ((v?.verdict === 'CHANGES' || checks === 'red') && team.fixCount(p.number) >= L.max_fix_attempts) part(0, `waiting for homeowner: fix limit reached on #${p.number}`, 'pull', p.number);
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
  else if (openIssues) parts.push({ rank: 3, text: 'has an open issue but nothing started it yet (limits or a lease may be holding it)' });
  if (!parts.length) return { text: 'no open issue or pull request is assigned to it', links: [] };
  parts.sort((x, y) => x.rank - y.rank);
  return { text: parts.slice(0, 3).map(x => x.text).join('; '), links: links.slice(0, 6) };
}

function attention({ config, cache, jobs, states, plan, snapshots, now, allowance, teamEnabled }) {
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
  for (const pr of cache?.pulls || []) if (!pr.isDraft && checksState(pr.statusCheckRollup) === 'red') add(`ci-${pr.number}`, `CI is red on PR #${pr.number}: ${pr.title}`, { kind: 'pull', n: pr.number });
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
    const own = s.job?.allowance?.windows ? s.job.allowance : null, fresh = allowance[a.provider] || null;   // judge by the newest thing the provider reported
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
    out[agent] = {
      observedAt: al?.observedAt || null,
      windows: al ? al.windows.map(w => ({ label: windowLabel(w, a.provider), utilization: Number.isFinite(w.utilization) ? w.utilization : null, resetsAt: w.resetsAt || null, stale: !!w.resetsAt && w.resetsAt < now })) : [],
      jobs: mine.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0)).slice(0, 8).map(j => ({ id: j.id.slice(0, 8), kind: j.kind || 'job', ref: j.issue, status: j.status, inputTokens: j.usage.inputTokens, outputTokens: j.usage.outputTokens, costUsdEstimate: j.usage.costUsdEstimate })),
      totalTokens: mine.reduce((s, j) => s + j.usage.inputTokens + j.usage.outputTokens, 0), jobsWithUsage: mine.length
    };
  }
  return out;
}

const DAY = 86400000;
function graphs({ config, jobs, state, snapshots, now }) {
  const agents = Object.keys(config.agents);
  // allowance % over time per agent, resets marked where the reported reset time changes between snapshots
  const allowance = {};
  for (const agent of agents) {
    const series = {};
    const resets = [];
    let lastReset = {};
    for (const s of snapshots.filter(x => now - x.at <= 14 * DAY).sort((a, b) => a.at - b.at)) {
      const al = s.allowance?.[agent]; if (!al) continue;
      for (const w of al.windows || []) {
        if (!Number.isFinite(w.utilization)) continue;
        const k = windowLabel(w, agent);
        (series[k] ||= []).push({ at: s.at, v: w.utilization });
        if (w.resetsAt && lastReset[k] && w.resetsAt !== lastReset[k] && w.resetsAt > lastReset[k]) resets.push({ at: s.at, window: k });
        if (w.resetsAt) lastReset[k] = w.resetsAt;
      }
    }
    allowance[agent] = { series, resets };
  }
  const days = {};
  for (const j of jobs) {
    if (!j.createdAt || now - j.createdAt > 14 * DAY) continue;
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

function activity({ config, jobs, events, state, cache, snapshots, now }) {
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
  for (const [key, v] of Object.entries(state.verdicts || {})) { const [pr, head] = key.split(':'); rows.push({ at: v.at, text: `${v.reviewer}: ${v.verdict} on PR #${pr} at ${sha7(head)}`, link: link('pull', Number(pr)) }); }
  for (const m of state.mergeLog || []) rows.push({ at: m.mergedAt, text: `merged PR #${m.pr}${m.agent ? ` (${m.agent})` : ''}`, link: link('pull', m.pr) });
  // ticks take part in the same newest-first ordering and 50-event bound as every other event (issue #32)
  rows.push(...snapshots.map(s => ({ at: s.at, text: s.status === 'ok'
    ? `tick ok${s.plan?.length ? `, plan: ${s.plan.map(a => `${a.agent || ''} ${a.type} #${a.ref}`.trim()).join('; ')}` : ', nothing to dispatch'}`
    : `tick ${s.status}${cache?.tick?.at === s.at && cache.tick.error ? `: ${cache.tick.error}` : ''}` })));
  if (cache?.tick && cache.tick.status !== 'ok' && !snapshots.some(s => s.at === cache.tick.at))
    rows.push({ at: cache.tick.at, text: `tick ${cache.tick.status}${cache.tick.error ? `: ${cache.tick.error}` : ''}` });
  return rows.filter(r => Number.isFinite(r.at)).sort((a, b) => b.at - a.at).slice(0, 50).map(r => ({ ...r, text: redact(r.text, 300) }));
}

export function buildView({ config, root, jobs, events, state, cache, snapshots, now }) {
  const states = agentStates(config, jobs, now);
  const allowance = latestAllowance(jobs);
  const c = cache || { pulls: [], issues: [] };
  const team = cacheBackedTeam(config, root, c, jobs, state);
  return team.plan().then(plan => {
    const queues = reasons(team, c, jobs, plan, states);
    const agents = Object.entries(config.agents).map(([name, a]) => {
      const s = states[name], j = s.job;
      const base = { name, provider: a.provider, state: s.state, lastActivityAt: s.last ? Math.max(s.last.updatedAt || 0, s.last.lastProgress || 0) || null : null, job: null };
      base.idleReason = idleReason({ agent: name, config, team, cache: c, plan, state: s.state });
      if (j) base.job = { id: j.id.slice(0, 8), kind: j.kind || 'job', ref: j.issue, branch: redact(j.branch || '', 100), startedAt: j.createdAt, elapsedMs: now - j.createdAt, status: j.status, lastEvent: redact(j.lastEvent || '', 48), resetAt: j.resetAt || null, nextAttemptAt: j.nextAttemptAt || null, attempts: j.attempts || 0 };
      return base;
    });
    return {
      generatedAt: now, repository: config.repository, teamEnabled: config.enabled !== false,
      tick: cache?.tick || null, cacheFetchedAt: cache?.fetchedAt || null,
      agents, queues, plan,
      attention: attention({ config, cache, jobs, states, plan, snapshots, now, allowance, teamEnabled: config.enabled !== false }),
      usage: usageView(config, jobs, states, allowance, now),
      graphs: graphs({ config, jobs, state, snapshots, now }),
      activity: activity({ config, jobs, events, state, cache, snapshots, now })
    };
  });
}
