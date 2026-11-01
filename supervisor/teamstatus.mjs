// `ai-supervisor team status` (issue #39): a plain-English terminal summary built on the SAME view model as the dashboard
// (buildView in dashboard.mjs), so the two cannot drift apart. Read-only and model-free. It reads the tick's cached GitHub
// data; only when that cache is stale does it make at most one `gh` call per section (open PRs, issues, merged PRs).
// Everything shown passes through redact(): no secrets, e-mail addresses or raw provider output.
import fs from 'node:fs';
import path from 'node:path';
import { STALE_TICK_MS, compactIssues, compactMerged, compactPulls, readCache, readEvents, readJobs, readLeases, readSnapshots, readTeamState, redact } from './dashdata.mjs';
import { buildView } from './dashboard.mjs';
import { checksState } from './team.mjs';
import { defaultZone } from './clocktext.mjs';
import { validateTeamConfig } from './team.mjs';
import { modeLine } from './budget.mjs';

export const TICK_INTERVAL_MS = 5 * 60000;     // the reconcile cron runs `*/5 * * * *` (tools/install-reconcile-user-script.sh)
const ACTIVE = ['queued', 'running', 'paused_limit', 'paused_manual'];
const KIND = { implement: 'implementing', continue: 'continuing draft work for', review: 'reviewing', fix: 'fixing', rebase: 'rebasing', cifix: 'fixing CI on' };
const hhmm = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const dayOf = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
const mins = ms => Math.round(ms / 60000);
const ref = (type, n) => (['implement', 'continue', 'issue'].includes(type) ? `issue #${n}` : `PR #${n}`);

export { readLeases };

// Refresh the parts of the cache the tick has not refreshed recently. One gh call per section; a failure keeps the cached data.
export async function refreshIfStale({ cache, gh, now }) {
  const notes = [];
  const fresh = cache && Number.isFinite(cache.fetchedAt) && now - cache.fetchedAt <= STALE_TICK_MS;
  if (fresh || !gh) {
    if (!fresh) notes.push(cache?.fetchedAt ? `GitHub data is ${mins(now - cache.fetchedAt)} minutes old (no tick lately) and was not refreshed.` : 'No GitHub data has been cached yet.');
    return { cache: cache || { pulls: [], issues: [] }, notes };
  }
  const out = { ...(cache || {}), pulls: cache?.pulls || [], issues: cache?.issues || [], merged: cache?.merged || [] };
  const section = async (name, fn) => { try { await fn(); } catch (error) { notes.push(`Could not refresh ${name} from GitHub (${redact(error?.message, 80)}); showing the cached copy.`); } };
  await section('pull requests', async () => { out.pulls = compactPulls(await gh.listPulls()); });
  await section('issues', async () => { out.issues = compactIssues(await gh.listIssues()); });
  await section('merged pull requests', async () => { out.merged = compactMerged(await gh.listMergedPulls()); });
  return { cache: out, notes };
}

const prState = p => (p.isDraft ? 'draft' : p.mergeable === 'CONFLICTING' ? 'conflicting' : 'ready');
const ciState = p => ({ green: 'green', red: 'red', pending: 'running', none: 'not run' })[checksState(p.statusCheckRollup)];
function verdictOf(state, p) {
  const mine = Object.entries(state.verdicts || {}).filter(([k]) => k.startsWith(`${p.number}:`));
  const hit = mine.find(([k]) => k === `${p.number}:${p.headRefOid}`);
  const [key, v] = hit || mine.sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0] || [];
  return v ? { verdict: v.verdict, reviewer: redact(v.reviewer, 20), current: !!hit, head: key.split(':')[1]?.slice(0, 7) || null } : null;
}

export async function buildStatus({ config, root, jobs, events, state, cache, snapshots, leases, now, tz = defaultZone(), notes = [], register = '' }) {
  const view = await buildView({ config, root, jobs, events, state, cache, snapshots, now, register });
  const live = id => jobs.some(j => j.id === id && ACTIVE.includes(j.status));
  const problems = view.attention.map(a => ({ id: a.id, text: a.text }));
  const add = (id, text) => { if (!problems.some(p => p.id === id)) problems.push({ id, text: redact(text, 300) }); };

  // 1. agents
  const agents = view.agents.map(a => {
    const j = a.job, what = j ? `${KIND[j.kind] || j.kind} ${['implement', 'continue'].includes(j.kind) ? `issue #${j.ref}` : `PR #${j.ref}`}` : null;
    const text = a.state === 'running' ? `running: ${what}` : a.state === 'paused' ? `paused: ${what}${j.nextAttemptAt ? `, restarts about ${hhmm(j.nextAttemptAt, tz)}` : ''}` : a.state === 'blocked' ? `blocked: ${what}` : `idle${a.idleReason ? `: ${a.idleReason.text}` : ''}`;
    return { name: a.name, state: a.state, idleReason: a.idleReason || null, job: j ? { kind: j.kind, ref: j.ref } : null, text };
  });

  // 2. what happens next
  const plan = view.plan.map(p => { const n = p.issue ?? p.pr, what = `${p.interim ? 'interim ' : p.postMerge ? 'post-merge ' : ''}${p.type === 'cifix' ? 'fix CI on' : p.type} ${ref(p.type, n)}${p.interim ? ' (its own PR: every other agent is out of allowance, D-021)' : ''}`; return { agent: p.agent || null, type: p.type, ref: n, text: p.agent ? `${p.agent} → ${what}` : `dispatcher → ${what}` }; });
  const waiting = [];
  if (!view.teamEnabled) waiting.push({ agent: null, text: 'The team loop is switched off, so nothing will start by itself.' });
  for (const a of view.agents) {
    if (plan.some(p => p.agent === a.name)) continue;
    let text;
    if (a.state === 'running') text = 'busy with its current job';
    else if (a.state === 'paused') text = 'paused (see Problems)';
    else {
      const order = { pr: 0, review: 1, issue: 2 }, q = [...(view.queues[a.name] || [])].sort((x, y) => order[x.type] - order[y.type])[0];   // open work first; an issue whose PR is open adds nothing
      text = q ? `${ref(q.type === 'pr' ? 'pr' : q.type === 'review' ? 'pr' : 'issue', q.ref)}: ${q.reason}` : 'no work is waiting for it';
    }
    waiting.push({ agent: a.name, text: `${a.name}: nothing to start; ${text}` });
  }

  // 3. problems beyond the dashboard's attention rules
  const ticks = snapshots.filter(s => s.status !== 'disabled').sort((a, b) => b.at - a.at);
  const lastTick = cache?.tick || null;
  let failed = 0;
  if (lastTick && lastTick.status === 'error' && !ticks.some(s => s.at === lastTick.at)) failed++;
  for (const s of ticks) { if (s.status === 'ok') break; failed++; }
  if (failed >= 2) add('ticks-failing', `${failed} ticks in a row have failed.`);
  for (const a of view.agents) if (a.state === 'paused') add(`paused-${a.name}`, `${a.name} is paused${a.job.lastEvent === 'usage_limit' ? ' on a usage limit' : ''}${a.job.nextAttemptAt ? `; restart planned about ${hhmm(a.job.nextAttemptAt, tz)}` : ''}.`);
  const stale = [...new Set(leases.filter(l => !live(l.job)).map(l => l.job))];
  if (stale.length) add('stale-leases', `${stale.length} lease(s) held with nothing running for them; probably stale (needs explicit recovery).`);
  for (const p of cache?.pulls || []) if (p.mergeable === 'CONFLICTING' && !p.isDraft) add(`conflict-${p.number}`, `PR #${p.number} has merge conflicts: ${p.title}`);

  // 4. pull requests
  const pulls = (cache?.pulls || []).map(p => ({ number: p.number, title: redact(p.title, 80), status: prState(p), ci: ciState(p), verdict: verdictOf(state, p), url: p.url || null }));

  // 5. merged today (local day); the tick caches the merged list, the dispatcher's own log fills any gap
  const today = dayOf(now, tz);
  const seen = new Set(), mergedToday = [];
  for (const m of cache?.merged || []) if (Date.parse(m.mergedAt) && dayOf(Date.parse(m.mergedAt), tz) === today && !seen.has(m.number)) { seen.add(m.number); mergedToday.push({ number: m.number, at: Date.parse(m.mergedAt), title: redact(m.title, 80) }); }
  for (const m of state.mergeLog || []) if (Number.isFinite(m.mergedAt) && dayOf(m.mergedAt, tz) === today && !seen.has(m.pr)) { seen.add(m.pr); mergedToday.push({ number: m.pr, at: m.mergedAt, title: '' }); }
  mergedToday.sort((a, b) => a.at - b.at);

  // 6. schedule
  const last = lastTick?.at ?? null, next = last == null ? null : last + TICK_INTERVAL_MS;
  const schedule = { intervalMinutes: TICK_INTERVAL_MS / 60000, lastTickAt: last, lastTickStatus: lastTick?.status ?? null, nextTickAt: next, minutesUntilNext: next == null ? null : mins(next - now) };

  // 7. allowance (issue #56): mode, reason and weekly projection per agent, as the planner sees it
  const allowance = Object.entries(view.budget || {}).map(([agent, b]) => ({ agent, mode: b.mode, used: b.used, projected: b.projected, resetsAt: b.resetsAt, until: b.until,
    text: redact(`${modeLine(agent, b, tz)}${b.mode === 'normal' && b.resetsAt ? `; weekly resets ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(b.resetsAt)).replace(',', '')}` : ''}`, 400) }));
  for (const p of view.plan) if (p.reassignedFrom) { const e = plan.find(x => x.agent === p.agent && x.ref === (p.issue ?? p.pr)); if (e) e.text += ` (reassigned from ${p.reassignedFrom} for allowance)`; }

  return { generatedAt: now, timeZone: tz, repository: view.repository, teamEnabled: view.teamEnabled, notes, agents, next: { plan, waiting }, problems, pulls, mergedToday, schedule, allowance };
}

export async function currentStatus({ root, config, gh = null, now = Date.now(), tz, register = '' }) {
  const jobs = readJobs(root);
  const { cache, notes } = await refreshIfStale({ cache: readCache(root), gh, now });
  return buildStatus({ config: validateTeamConfig(config), root, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), cache, snapshots: readSnapshots(root), leases: readLeases(root), now, tz, notes, register });
}

export function renderStatus(s) {
  const t = ms => hhmm(ms, s.timeZone), out = [];
  const head = title => out.push('', `=== ${title}`);
  out.push(`Team status for ${s.repository} at ${t(s.generatedAt)} (${s.timeZone})`);
  for (const n of s.notes) out.push(`  note: ${n}`);
  head('What each agent is doing');
  for (const a of s.agents) out.push(`  ${a.name}: ${a.text}`);
  head('What happens next');
  if (s.next.plan.length) for (const p of s.next.plan) out.push(`  ${p.text}`);
  for (const w of s.next.waiting) out.push(`  ${w.text}`);
  head('Problems');
  if (!s.problems.length) out.push('  none');
  for (const p of s.problems) out.push(`  - ${p.text}`);
  head('Pull requests');
  if (!s.pulls.length) out.push('  none open');
  for (const p of s.pulls) out.push(`  #${p.number} ${p.status}, CI ${p.ci}${p.verdict ? `, ${p.verdict.reviewer} said ${p.verdict.verdict}${p.verdict.current ? '' : ` on an older commit (${p.verdict.head})`}` : ', no verdict yet'}: ${p.title}`);
  head('Merged today');
  if (!s.mergedToday.length) out.push('  nothing yet');
  for (const m of s.mergedToday) out.push(`  #${m.number} at ${t(m.at)}${m.title ? `: ${m.title}` : ''}`);
  head('Allowance');
  if (!s.allowance?.length) out.push('  no allowance data');
  for (const a of s.allowance || []) out.push(`  ${a.text}`);
  head('Schedule');
  const sc = s.schedule;
  out.push(`  ticks run every ${sc.intervalMinutes} minutes`);
  if (sc.lastTickAt == null) out.push('  last tick: never recorded');
  else {
    out.push(`  last tick: ${t(sc.lastTickAt)} (${sc.lastTickStatus})`);
    out.push(sc.minutesUntilNext >= 0 ? `  next tick: ${t(sc.nextTickAt)} (in ${sc.minutesUntilNext} minute${sc.minutesUntilNext === 1 ? '' : 's'})` : `  next tick: was due at ${t(sc.nextTickAt)} (${-sc.minutesUntilNext} minute${sc.minutesUntilNext === -1 ? '' : 's'} overdue)`);
  }
  return out.join('\n') + '\n';
}
