// `ai-supervisor team status` (issue #39): a plain-English terminal summary built on the SAME view model as the dashboard
// (buildView in dashboard.mjs), so the two cannot drift apart. Read-only and model-free. It reads the tick's cached GitHub
// data; only when that cache is stale does it make at most one `gh` call per section (open PRs, issues, merged PRs).
// Everything shown passes through redact(): no secrets, e-mail addresses or raw provider output.
import fs from 'node:fs';
import path from 'node:path';
import { STALE_TICK_MS, compactIssues, compactMerged, compactPulls, readCache, readEvents, readJobs, readLeases, readSnapshots, readTeamState, redact } from './dashdata.mjs';
import { buildView } from './dashboard.mjs';
import { checksState, retriedIn, carryRecordOf } from './team.mjs';
import { defaultZone } from './clocktext.mjs';
import { validateTeamConfig } from './team.mjs';
import { modeLine } from './budget.mjs';
import { makeNamer } from './naming.mjs';
import { agentLine } from './agentline.mjs';
import { testSlotStatus, DEFAULT_TEST_SLOTS } from './testslots.mjs';
import { readSkips, SKIP_WINDOW_MS } from './skips.mjs';
import { agentErrorTotals } from './agent-errors.mjs';
import { formatLocal, localStamps } from './dashui/logic.mjs';

export const TICK_INTERVAL_MS = 5 * 60000;     // the reconcile cron runs `*/5 * * * *` (tools/install-reconcile-user-script.sh)
const ACTIVE = ['queued', 'running', 'paused_limit', 'paused_manual'];
const KIND = { implement: 'implementing', continue: 'continuing draft work for', review: 'reviewing', fix: 'fixing', rebase: 'rebasing', cifix: 'fixing CI on' };
const hhmm = (ms, tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
const dayOf = (ms, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ms));
const mins = ms => Math.round(ms / 60000);
const IMPLEMENTING = ['implement', 'continue', 'issue'];

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
const ciState = (p, state, now) => ({ green: 'green', red: 'red', pending: 'running', none: 'not run' })[checksState(p.statusCheckRollup, retriedIn(state?.cancelWatch, p, now))];
function verdictOf(state, p) {
  const mine = Object.entries(state.verdicts || {}).filter(([k]) => k.startsWith(`${p.number}:`));
  const hit = mine.find(([k]) => k === `${p.number}:${p.headRefOid}`);
  const [key, v] = hit || mine.sort((a, b) => (b[1].at || 0) - (a[1].at || 0))[0] || [];
  const carry = hit ? carryRecordOf(v, p) : null;   // issue #296: a carried verdict shows old head, new head and evidence
  return v ? { verdict: v.verdict, reviewer: redact(v.reviewer, 20), current: !!hit, head: key.split(':')[1]?.slice(0, 7) || null, ...(carry ? { carry: { oldHead: carry.oldHead.slice(0, 7), newHead: carry.newHead.slice(0, 7), valid: carry.valid, evidence: carry.evidence } } : {}) } : null;
}

export async function buildStatus({ config, root, jobs, events, state, cache, snapshots, leases, now, tz = defaultZone(), notes = [], register = '', registerUnreadable = false }) {
  // An unreadable register is reported once, as the Problems entry buildView adds.
  const view = await buildView({ config, root, jobs, events, state, cache, snapshots, now, register, registerUnreadable, tz });
  const names = makeNamer({ repo: view.repository, issues: cache?.issues, pulls: cache?.pulls, merged: cache?.merged, mergeLog: state.mergeLog, stateJobs: state.jobs, titles: state.titles });
  const ref = (type, n) => (IMPLEMENTING.includes(type) ? names.issue(n) : names.pr(n)).text;   // the shared formatter, never an ad-hoc string
  const live = id => jobs.some(j => j.id === id && ACTIVE.includes(j.status));
  const problems = view.attention.map(a => ({ id: a.id, text: localStamps(a.text, ms => formatLocal(ms, tz)) }));
  const add = (id, text) => { if (!problems.some(p => p.id === id)) problems.push({ id, text: redact(text, 300) }); };

  // 1. agents
  const agents = view.agents.map(a => {
    const j = a.job, what = j ? j.name : null;
    const text = agentLine(a, ms => hhmm(ms, tz));
    return { name: a.name, state: a.state, idleReason: a.idleReason || null, job: j ? { kind: j.kind, ref: j.ref, id: j.id, name: j.name } : null, text };
  });

  const slots = view.slots;   // role slots (issue #148), from the shared view

  // 2. what happens next
  const est = (kind, n) => view.estimates?.items?.[`${kind}:${n}`] || null;
  const plan = view.plan.map(p => { const n = p.issue ?? p.pr, e = est(['implement', 'continue'].includes(p.type) ? 'issue' : 'pr', n), what = `${p.secondOpinion || p.postMerge ? 'second-opinion ' : ''}${p.type === 'cifix' ? 'fix CI on' : p.type} ${ref(p.type, n)}`; return { agent: p.agent || null, type: p.type, ref: n, estimate: e?.text || null, text: p.agent ? `${p.agent} → ${what}` : `dispatcher → ${what}` }; });
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
  for (const p of cache?.pulls || []) if (p.mergeable === 'CONFLICTING' && !p.isDraft) add(`conflict-${p.number}`, `${names.pr(p.number).text} has merge conflicts`);

  // 4. pull requests
  const pulls = (cache?.pulls || []).map(p => ({ number: p.number, name: redact(names.pr(p.number).text, 300), title: redact(names.titleOf(names.issueOfPr(p.number)?.number) ?? p.title, 80), status: prState(p), ci: ciState(p, state, now), verdict: verdictOf(state, p), url: p.url || null }));

  // Issue #405: the order in which each reviewer will take the PRs waiting for a review, with the reason.
  const reviewOrder = (view.agents || []).flatMap(a => (view.queues[a.name] || []).filter(q => q.type === 'review' && q.order).sort((x, y) => x.order - y.order).map(q => ({ agent: a.name, pr: q.ref, order: q.order, text: redact(`${a.name} ${q.order}: ${ref('pr', q.ref)} ${(/\[review order [^:]*: ([^\]]*)\]/.exec(q.reason) || [])[1] || ''}`.trim(), 300) })));

  // 5. merged today (local day); the tick caches the merged list, the dispatcher's own log fills any gap
  const today = dayOf(now, tz);
  const seen = new Set(), mergedToday = [];
  for (const m of cache?.merged || []) if (Date.parse(m.mergedAt) && dayOf(Date.parse(m.mergedAt), tz) === today && !seen.has(m.number)) { seen.add(m.number); mergedToday.push({ number: m.number, name: redact(names.pr(m.number).text, 300), at: Date.parse(m.mergedAt), title: '' }); }
  for (const m of state.mergeLog || []) if (Number.isFinite(m.mergedAt) && dayOf(m.mergedAt, tz) === today && !seen.has(m.pr)) { seen.add(m.pr); mergedToday.push({ number: m.pr, name: redact(names.pr(m.pr).text, 300), at: m.mergedAt, title: '' }); }
  mergedToday.sort((a, b) => a.at - b.at);

  // 6. schedule
  const last = lastTick?.at ?? null, next = last == null ? null : last + TICK_INTERVAL_MS;
  const testRuns = { ...testSlotStatus(root, config.limits?.test_slots ?? DEFAULT_TEST_SLOTS, now), skippedLastHour: readSkips(root, now - SKIP_WINDOW_MS).slice(-5).map(x => ({ at: x.at, reason: redact(x.reason, 200) })) };
  const schedule = { intervalMinutes: TICK_INTERVAL_MS / 60000, lastTickAt: last, lastTickStatus: lastTick?.status ?? null, nextTickAt: next, minutesUntilNext: next == null ? null : mins(next - now) };

  // 7. allowance (issue #56): mode, reason and weekly projection per agent, as the planner sees it
  const allowance = Object.entries(view.budget || {}).map(([agent, b]) => ({ agent, mode: b.mode, used: b.used, projected: b.projected, resetsAt: b.resetsAt, until: b.until,
    text: redact(`${modeLine(agent, b, tz)}${b.mode === 'normal' && b.resetsAt ? `; weekly resets ${new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(b.resetsAt)).replace(',', '')}` : ''}`, 400) }));
  for (const p of view.plan) if (p.reassignedFrom) { const e = plan.find(x => x.agent === p.agent && x.ref === (p.issue ?? p.pr)); if (e) e.text += ` (reassigned from ${p.reassignedFrom} for allowance)`; }

  // A pending supervisor upgrade holds back new jobs (issue #134); self-upgrade.json is written by the upgrade step.
  const estimates = { waits: view.estimates.waits.map(w => ({ kind: w.kind, at: w.at, text: redact(w.text, 200) })), items: Object.values(view.estimates.items).map(e => ({ kind: e.kind, ref: e.ref, name: redact(ref(e.kind, e.ref), 300), agent: e.agent, status: e.status, text: redact(e.text, 200), finishP50: e.finish?.p50 ?? null, finishP90: e.finish?.p90 ?? null, waits: e.waits.map(w => redact(w.text, 200)), basis: e.basis.map(b => redact(b, 300)) })) };
  // The installer's last result and next attempt (issue #101), from the same state file.
  let install = null;
  try {
    const i = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')).install;
    if (i && typeof i.result === 'string') install = { result: redact(i.result, 30), sha: typeof i.sha === 'string' ? redact(i.sha.slice(0, 7), 12) : null, at: Number.isFinite(i.at) ? i.at : null,
      nextAttemptAt: Number.isFinite(i.nextAttemptAt) ? i.nextAttemptAt : null, reason: i.reason ? redact(String(i.reason), 400) : null,
      tests: Array.isArray(i.tests) ? i.tests.slice(0, 5).map(x => redact(String(x), 200)) : [], excerpt: typeof i.excerpt === 'string' ? redact(i.excerpt.split('\n').slice(0, 12).join('\n'), 800) : '', retried: i.retried === true };
  } catch { /* no state file: nothing installed by the loop yet */ }
  let installed = null;
  try { const m = /^versions\/([0-9a-f]{40})$/.exec(fs.readlinkSync(path.join(root, 'current'))); installed = m ? m[1].slice(0, 7) : null; } catch { /* not a versioned install */ }
  const robustness = view.robustness;
  const agentErrors = agentErrorTotals(root, now);   // issue #1084
  return { agentErrors, robustness, testRuns, needsYou: (view.panels?.needsYou || []).map(n => ({ id: n.id, text: redact(n.text, 300) })), install, installed, estimates, generatedAt: now, timeZone: tz, repository: view.repository, teamEnabled: view.teamEnabled, notes, agents, slots, next: { plan, waiting }, reviewOrder, problems, pulls, mergedToday, schedule, allowance };
}

export async function currentStatus({ root, config, gh = null, now = Date.now(), tz, register = '', registerUnreadable = !register }) {
  const jobs = readJobs(root);
  const { cache, notes } = await refreshIfStale({ cache: readCache(root), gh, now });
  return buildStatus({ config: validateTeamConfig(config), root, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), cache, snapshots: readSnapshots(root), leases: readLeases(root), now, tz, notes, register, registerUnreadable });
}

export function renderStatus(s) {
  const t = ms => hhmm(ms, s.timeZone), out = [];
  const head = title => out.push('', `=== ${title}`);
  out.push(`Team status for ${s.repository} at ${t(s.generatedAt)} (${s.timeZone})`);
  for (const n of s.notes) out.push(`  note: ${n}`);
  head('What each agent is doing');
  for (const a of s.agents) out.push(`  ${a.name}: ${a.text}`);
  head('Role slots');
  for (const x of s.slots) out.push(`  ${x.text}${x.capacity > 1 ? ` (${x.held.length} of ${x.capacity} slots)` : ''}`);
  head('What happens next');
  if (s.install || s.installed) out.push(`  installer: version ${s.installed || 'unknown'}${s.install ? `; last install ${s.install.result}${s.install.sha ? ` (${s.install.sha})` : ''}${s.install.at ? ` at ${t(s.install.at)}` : ''}${s.install.reason ? `: ${s.install.reason}` : ''}${s.install.nextAttemptAt ? `; next attempt ${t(s.install.nextAttemptAt)}` : ''}` : ''}`);
  if (s.install?.tests?.length) out.push(`    failing test${s.install.tests.length === 1 ? '' : 's'}: ${s.install.tests.join('; ')}${s.install.retried ? ' (failed twice, each in a fresh copy)' : ''}`);
  else if (s.install?.retried) out.push('    failed twice, each in a fresh copy');
  if (s.install?.excerpt) for (const l of s.install.excerpt.split('\n')) out.push(`      | ${l}`);
  if (s.next.plan.length) for (const p of s.next.plan) out.push(`  ${p.text}${p.estimate ? ` (${p.estimate})` : ''}`);
  for (const w of s.next.waiting) out.push(`  ${w.text}`);
  head('Estimated finish');
  if (!s.estimates.items.length) out.push('  nothing queued');
  for (const e of s.estimates.items) out.push(`  ${e.name} (${e.agent}): ${e.text}${e.waits.length ? ` [${e.waits.join('; ')}]` : ''}`);
  for (const w of s.estimates.waits) out.push(`  wait: ${w.text}`);
  if (s.robustness) {
    head('Job liveness and retries');
    out.push(`  jobs with no activity for ${s.robustness.limitMinutes} minutes are cancelled and requeued`);
    for (const j of s.robustness.running) out.push(`  job ${j.id} (${j.kind || 'job'}): last activity ${j.idleMs == null ? 'unknown' : `${mins(j.idleMs)} min ago`}`);
    for (const r of s.robustness.retries) out.push(`  ${r.key}: ${r.count} attempt${r.count === 1 ? '' : 's'} with cause ${r.cause}${r.capped ? ' (stopped, in Needs you)' : ''}`);
    if (s.robustness.rearm) out.push(`  re-armed after ${s.robustness.rearm.scopes.join(', ')} cleared: ${s.robustness.rearm.items.join(', ')}`);
  }
  if (s.agentErrors) out.push('', `In-job agent errors, last 24 hours: ${s.agentErrors.errors}, about ${s.agentErrors.tokensLost.toLocaleString('en-US')} tokens lost (${s.agentErrors.recovered} recovered)`);
  head('Problems');
  if (!s.problems.length) out.push('  none');
  for (const p of s.problems) out.push(`  - ${p.text}`);
  head('Pull requests');
  if (!s.pulls.length) out.push('  none open');
  for (const p of s.pulls) out.push(`  ${p.name} ${p.status}, CI ${p.ci}${p.verdict ? `, ${p.verdict.reviewer} said ${p.verdict.verdict}${p.verdict.current ? '' : ` on an older commit (${p.verdict.head})`}` : ', no verdict yet'}${p.verdict?.carry ? `; verdict carried from ${p.verdict.carry.oldHead} to ${p.verdict.carry.newHead} (no conflict resolved: ${p.verdict.carry.evidence.resolvedConflicts === false ? 'yes' : 'not shown'}, patch unchanged: ${p.verdict.carry.evidence.patchUnchanged === true ? 'yes' : 'not shown'}, CI ${p.verdict.carry.evidence.ci || 'unknown'})${p.verdict.carry.valid ? '' : ' - record does not match this head'}` : ''}`);
  head('Merged today');
  if (!s.mergedToday.length) out.push('  nothing yet');
  for (const m of s.mergedToday) out.push(`  ${m.name} at ${t(m.at)}`);
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
  const tr = s.testRuns;
  if (tr) {
    out.push(`  test runs: ${tr.running.length} of ${tr.limit} running, ${tr.waiting.length} waiting${tr.waiting.length ? `: ${tr.waiting.slice(0, 5).map(w => w.label).join('; ')}` : ''}`);
    for (const x of tr.skippedLastHour) out.push(`  skipped tick ${t(x.at)}: ${x.reason}`);
  }
  return out.join('\n') + '\n';
}
