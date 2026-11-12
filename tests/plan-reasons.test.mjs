// Issue #1223: a resume check that throws records its message; every planned action ends a tick launched or with one recorded reason;
// the MCP tools and the idle text give that reason. The tick tests run Team.tick (the entry point of `team tick`) and read the tick
// record, the dashboard view and the MCP tools back, as the 12 Nov 2026 situation (paused job db849b9f, claude fixes not started) needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team } from '../supervisor/team.mjs';
import { createJob, drive, stateRoot, LeaseHeld, saveJob } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { compactIssues, readSnapshots, readCache } from '../supervisor/dashdata.mjs';
import { recordTickWithSkips } from '../supervisor/tickrecord.mjs';
import { tickOutcome } from '../supervisor/dashdata.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { createProtocol } from '../foreman-mcp/protocol.mjs';
import { noteGateError, describeGateError, RECORD_EVERY_MS } from '../supervisor/gateerror.mjs';
import { PlanLedger, kindOfReason, UNEXPLAINED_TEXT } from '../supervisor/planledger.mjs';
import { overlapText } from '../supervisor/overlaptext.mjs';
import { FAILING_TICKS } from '../supervisor/resumefailures.mjs';
import { classifyIdle } from '../supervisor/idlecause.mjs';

const MIN = 60000, HOUR = 60 * MIN;
const NOW = Date.parse('2026-11-12T19:45:00Z');
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
// A secret-shaped value is built at run time so no scanner sees a literal one (issue #142).
const fakeSecret = () => ['to', 'ken'].join('') + '=' + ['abc', 'DEF', '0123456789'].join('');

// ---- 1. the resume gate, through the real drive() loop ----
function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-reasons-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), wt = path.join(dir, 'wt');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'a@b.invalid');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'r'), 'x');
  git(repo, 'add', 'r');
  git(repo, 'commit', '-qm', 'i');
  git(repo, 'worktree', 'add', '-qb', 'i20', wt);
  const manifest = { schema_version: 1, id: 'codex', display_name: 'c', adapter_version: '0.1.0', launch: { command: 'x', args: [] },
    capabilities: Object.fromEntries(['launch', 'resume', 'session_status', 'usage_limit_detection', 'reset_time_parsing', 'checkpoint', 'non_interactive'].map(k => [k, 'supported'])),
    billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify(manifest));
  const registry = path.join(dir, 'reg.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  const spec = { role: 'devtest', provider: 'codex', repository: repo, worktree: wt, issue: 20, scope: 's', allowed_actions: ['read'], prompt: 'p', autoResume: true };
  return { root: stateRoot(path.join(dir, 's')), registry, spec };
}
const eventsOf = (root, job) => fs.readFileSync(path.join(root, 'events', `${job.id}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('drive: a throwing resume gate keeps the message and a stack summary, redacted, and logs it once per message per hour', async t => {
  const s = sandbox(t), job = await createJob(s.root, s.spec, s.registry);
  job.status = 'paused_limit';
  saveJob(s.root, job);
  let now = NOW, calls = 0;
  const secret = fakeSecret();
  const gate = async () => {
    calls++;
    if (calls === 4) throw new Error('lock directory unreadable ' + secret);   // a different message in the middle of the run
    if (calls >= 130) return { stale: true, reason: 'end of test' };
    throw new Error('lock directory unreadable');
  };
  const clock = { now: () => now, sleep: async () => { now += MIN; } };
  const r = await drive(s.root, job, s.registry, clock, async () => ({}), 4, null, gate);
  assert.equal(r.status, 'stopped');
  const logged = eventsOf(s.root, job).filter(e => e.kind === 'resume_check_failed');
  // minute 0 (first), minute 3 (new message, redacted form differs), minute 4 (back to the first message: new again), then once an hour: 60 and 120
  assert.equal(logged.length, 5, JSON.stringify(logged.map(e => (e.at - NOW) / MIN)));
  assert.equal(calls, 130);
  const waiting = eventsOf(s.root, job).filter(e => e.kind === 'resume_waiting');
  assert.ok(waiting.length >= 1);
});

test('drive: a check that throws every minute logs one event for the first hour, the job record carries message, count and stack', async t => {
  const s = sandbox(t), job = await createJob(s.root, s.spec, s.registry);
  job.status = 'paused_limit';
  saveJob(s.root, job);
  let now = NOW, calls = 0;
  const gate = async () => { calls++; if (calls > 59) return { stale: true, reason: 'end' }; throw new TypeError('cannot read the lock'); };
  let seen = null, wait = null;
  const clock = { now: () => now, sleep: async () => { now += MIN; seen = JSON.parse(JSON.stringify(job.resumeCheck)); wait = job.resumeWait; } };
  await drive(s.root, job, s.registry, clock, async () => ({}), 4, null, gate);
  assert.equal(eventsOf(s.root, job).filter(e => e.kind === 'resume_check_failed').length, 1, 'once, not every minute');
  assert.equal(seen.message, 'cannot read the lock');
  assert.equal(seen.count, 59);
  assert.match(seen.stack, /plan-reasons\.test\.mjs/, 'a bounded stack summary');
  assert.ok(seen.stack.length <= 400);
  assert.match(wait?.reason ?? '', /resume check failed: TypeError: cannot read the lock/);
});

test('describeGateError and noteGateError: redaction, bounds and the once-per-hour rule', () => {
  const secret = fakeSecret();
  const d = describeGateError(new Error('boom ' + secret + ' ' + 'x'.repeat(500)));
  assert.ok(!d.message.includes(secret.split('=')[1]), d.message);
  assert.ok(d.message.length <= 200);
  assert.ok(d.stack.length <= 400);
  const job = {}, events = [];
  const clock = { now: () => NOW };
  noteGateError('r', job, new Error('a'), clock, (...args) => events.push(args[2]));
  const later = { now: () => NOW + RECORD_EVERY_MS - 1 };
  noteGateError('r', job, new Error('a'), later, (...args) => events.push(args[2]));
  assert.equal(events.length, 1, 'inside the hour');
  noteGateError('r', job, new Error('a'), { now: () => NOW + RECORD_EVERY_MS }, (...args) => events.push(args[2]));
  assert.equal(events.length, 2, 'after the hour');
  noteGateError('r', job, new Error('b'), later, (...args) => events.push(args[2]));
  assert.equal(events.length, 3, 'a different message');
  assert.deepEqual(noteGateError('r', {}, 'plain string', clock, () => {}), { go: false, reason: 'resume check failed: Error: plain string' });
});

// ---- 2. the tick ----
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2, same_cause_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });
const issue = n => ({ number: n, title: `Issue ${n}`, state: 'OPEN', body: '', labels: [] });
const pull = { number: 10, title: 'pr ten', headRefName: 'codex/issue-2-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], url: 'u' };
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const claudeAllowance = { provider: 'claude', status: 'allowed', observedAt: NOW, windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: NOW + 3 * HOUR, status: 'allowed' }, { type: 'seven_day', utilization: 0.2, resetsAt: NOW + 3 * 86400000, status: 'allowed' }], billing: { overageStatus: 'rejected', usingOverage: false } };

function world(t, { failCreate = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-reasons-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { created: [] };
  const gh = { listPulls: async () => [pull], getPull: async () => pull, listIssues: async () => [issue(2)], comment: async () => {}, addLabel: async () => {}, board: async () => {},
    listMergedPulls: async () => [], hasComment: async () => false, findIssueByMarker: async () => null, findOpenIssueByMarker: async () => null };
  const jobs = { active: [], states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => {
      if (w.failCreate) throw w.failCreate;
      const id = (++jobs.seq).toString(16).padStart(32, '0');
      calls.created.push(spec);
      jobs.states[id] = { id, status: 'queued', provider: spec.provider };
      return { id };
    } };
  const clock = { t: NOW, now: () => clock.t };
  const usage = { allowance: { claude: claudeAllowance }, jobs: [], snapshots: [] };
  const w = { dir, calls, clock, jobs, failCreate };
  w.team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock, usage,
    hostPressure: () => ({ hold: false, reasons: [] }) });
  return w;
}
const planned = (r, type) => r.planned.find(p => p.type === type);
const record = (w, r) => recordTickWithSkips(w.team.root, { ...tickOutcome(r), now: w.clock.now(), team: w.team, actions: r.actions, jobs: [], ingested: 0, startedAt: w.clock.now() });
const lastSnapshot = w => readSnapshots(w.team.root).at(-1);

test('control: a planned review that starts is recorded as launched with no reason and no unexplained hold', async t => {
  const w = world(t);
  const r = await w.team.tick();
  assert.equal(w.calls.created.length, 1);
  assert.deepEqual(r.planned.map(p => [p.type, p.outcome, p.reason]), [['review', 'launched', null]]);
  assert.deepEqual(w.team.selfCheckItems().filter(i => i.id.startsWith('unexplained')), []);
});

test('upgrade hold: the planned review is held with kind upgrade; the tick record, idle text and MCP tools carry the reason', async t => {
  const w = world(t);
  const r = await w.team.tick({ hold: { to: 'abcdef0123' } });
  assert.equal(w.calls.created.length, 0);
  const p = planned(r, 'review');
  assert.equal(p.outcome, 'held');
  assert.equal(p.kind, 'upgrade');
  assert.match(p.reason, /upgrade to abcdef0 pending/);
  record(w, r);
  assert.deepEqual(readCache(w.team.root).planned.map(e => e.kind), ['upgrade']);
  assert.equal(lastSnapshot(w).planned[0].reason, p.reason);
  const v = await buildView({ config: config(), root: w.dir, jobs: [], events: [], state: JSON.parse(JSON.stringify(w.team.s)), snapshots: [], now: w.clock.now(), tz: 'UTC',
    cache: { ...readCache(w.team.root), fetchedAt: w.clock.now(), pulls: [pull], issues: compactIssues([issue(2)]), probes: { claude: claudeAllowance } } });
  const tools = createTools({ source: { get: async () => ({ view: v, ageMs: 0, stale: false }) }, readHost: () => ({}) });
  const protocol = createProtocol({ tools });
  const run = async (name, args = {}) => JSON.parse((await protocol.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))).result.content[0].text);
  const plan = await run('foreman_plan');
  const review = plan.plannedActions.find(a => a.type === 'review');
  assert.equal(review.lastTick.outcome, 'held');
  assert.equal(review.lastTick.kind, 'upgrade');
  assert.equal(review.lastTick.reason, p.reason);
  const why = await run('foreman_why_blocked', { kind: 'pr', number: 10 });
  assert.deepEqual(why.lastTick.map(e => [e.type, e.outcome, e.kind, e.reason]), [['review', 'held', 'upgrade', p.reason]]);
  const planNow = await run('foreman_plan');
  assert.ok(planNow.plannedActions.every(a => a.lastTick), 'every planned action carries lastTick');
});

test('retry cap: a planned review that reached the cap after planning is held with kind retry_cap', async t => {
  const w = world(t);
  const [review] = (await w.team.plan()).filter(a => a.type === 'review');
  assert.ok(review, 'planned while under the cap');
  w.team.s.sameCause = { 'review:10': { count: 2, cause: 'no_verdict', head: H(1), at: NOW } };
  w.team.plan = async () => [review];
  const r = await w.team.tick();
  assert.equal(w.calls.created.length, 0);
  assert.equal(planned(r, 'review').kind, 'retry_cap');
  assert.match(planned(r, 'review').reason, /retry cap: 2 attempts with the same cause \(no_verdict\)/);
});

test('allowance: a limit reached between the plan and the start holds the planned review with kind allowance', async t => {
  const w = world(t);
  const plan = w.team.plan.bind(w.team);
  let out = false;
  w.team.plan = async (...a) => { const actions = await plan(...a); out = true; return actions; };
  const limited = w.team.limitedOf.bind(w.team);
  w.team.limitedOf = agent => (out ? { out: true, reason: 'five hour window used', until: NOW + HOUR } : limited(agent));
  const r = await w.team.tick();
  assert.equal(w.calls.created.length, 0);
  assert.equal(planned(r, 'review').kind, 'allowance');
  assert.match(planned(r, 'review').reason, /reached its usage limit/);
});

test('error: a start that throws is held with kind error and the message', async t => {
  const w = world(t, { failCreate: new Error('disk full while creating the job') });
  const r = await w.team.tick();
  assert.equal(planned(r, 'review').kind, 'error');
  assert.match(planned(r, 'review').reason, /disk full while creating the job/);
});

test('lease: a start that finds the worktree leased by a live job is held with kind lease and names the holder', async t => {
  const holder = 'a'.repeat(32);
  const w = world(t, { failCreate: new LeaseHeld(holder) });
  w.jobs.states[holder] = { id: holder, status: 'running', provider: 'codex' };
  w.jobs.alive = async () => true;
  const r = await w.team.tick();
  assert.equal(planned(r, 'review').kind, 'lease');
  assert.match(planned(r, 'review').reason, /waiting for job aaaaaaaa \(running\)/);
});

test('no reason: a planned action that neither starts nor is held is an unexplained hold and a Needs you item of severity action', async t => {
  const w = world(t);
  w.team.execute = async () => {};   // the start returns without a job, a skip, a wait or a note
  const r = await w.team.tick();
  const p = planned(r, 'review');
  assert.equal(p.outcome, 'held');
  assert.equal(p.kind, 'unexplained');
  assert.equal(p.reason, UNEXPLAINED_TEXT);
  const item = w.team.selfCheckItems().find(i => i.id.startsWith('unexplained-hold'));
  assert.ok(item);
  assert.match(item.text, /review for \w+ on #10 .*unexplained hold/);
  const v = await buildView({ config: config(), root: w.dir, jobs: [], events: [], state: JSON.parse(JSON.stringify(w.team.s)), snapshots: [], now: w.clock.now(), tz: 'UTC', team: w.team,
    cache: { tick: { at: w.clock.now(), status: 'ok', error: null, lastOkAt: w.clock.now() }, fetchedAt: w.clock.now(), pulls: [pull], issues: compactIssues([issue(2)]), probes: { claude: claudeAllowance } } });
  const card = v.panels.needsYou.find(a => a.id.startsWith('unexplained-hold'));
  assert.ok(card, 'the dashboard lists it');
  assert.equal(card.severity, 'action');
  // a later tick that starts it clears the item
  w.team.execute = Team.prototype.execute;
  w.clock.t += 5 * MIN;
  await w.team.tick();
  assert.deepEqual(w.team.selfCheckItems().filter(i => i.id.startsWith('unexplained-hold')), []);
});

test('a recorded planner hold (here the order guard) explains an attempt that left no trace', async t => {
  const w = world(t);
  w.team.execute = async () => {};
  const plan = w.team.plan.bind(w.team);
  w.team.plan = async (...a) => { const actions = await plan(...a); w.team.hold('claude', 'review', 'waiting for a running inbox prompt that changes queue order or config', 10); return actions; };
  const r = await w.team.tick();
  assert.equal(planned(r, 'review').kind, 'order_guard');
  assert.deepEqual(w.team.selfCheckItems().filter(i => i.id.startsWith('unexplained-hold')), []);
});

// ---- the ledger by reason, with the texts the planner really writes ----
test('PlanLedger and kindOfReason: every reason of the list is recorded for the action it holds', () => {
  const texts = {
    slot: 'implement slot full: codex review on PR #9',
    overlap: overlapText({ type: 'rebase', issue: 1139, pr: 1139, file: 'supervisor/team.mjs', other: 1133, prs: [{ number: 1140, headRefName: 'claude/issue-1133-x' }] }),
    retry_cap: 'retry cap: 2 attempts with the same cause (no_verdict); needs the homeowner',
    breaker: 'circuit breaker: cause review halted new review jobs until the homeowner resumes',
    reading_stale: 'the allowance reading is stale (30 minutes old); it is refreshed before the next start',
    allowance: 'review held: claude is out of allowance (five hour window)',
    order_guard: 'waiting for a running inbox prompt that changes queue order or config; new implement work starts after it ends',
    lease: 'waiting for job aaaaaaaa (running)',
    error: 'disk full' };
  for (const [kind, text] of Object.entries(texts)) assert.equal(kindOfReason(text), kind, text);
  const acts = Object.keys(texts).map((k, i) => ({ type: 'fix', agent: 'claude', pr: 100 + i }));
  const ledger = new PlanLedger(acts, a => Object.values(texts)[a.pr - 100]);
  const kept = ledger.filtered('error', acts, []);
  assert.deepEqual(kept, []);
  assert.deepEqual(ledger.settle().map(e => e.kind), Object.keys(texts).map(() => 'error'), 'a stage names its own kind');
  const open = new PlanLedger(acts);
  acts.forEach((a, i) => open.held(a, Object.keys(texts)[i], Object.values(texts)[i]));
  assert.deepEqual(open.settle().map(e => e.kind), Object.keys(texts));
  const bare = new PlanLedger(acts);
  assert.deepEqual([...new Set(bare.settle().map(e => e.kind))], ['unexplained']);
});

// ---- 3. the 12 Nov 2026 resume case, through the tick ----
test('paused job db849b9f with an expired resume time and a throwing gate: the message reaches the tick record, 3 ticks raise a Needs you item', async t => {
  const w = world(t);
  const id = 'db849b9f' + '0'.repeat(24);
  w.jobs.active = [{ id, status: 'paused_limit', provider: 'codex' }];
  const rec = { id, status: 'paused_limit', provider: 'codex', kind: 'implement', resumeAt: NOW - HOUR };
  w.jobs.states[id] = rec;
  const failTick = (minute) => { rec.resumeCheck = { message: 'lock directory unreadable', stack: 'at x', firstAt: NOW, lastAt: w.clock.t + minute * 60000 - 1000, count: 5 }; };
  const reports = [];
  for (let i = 0; i < FAILING_TICKS; i++) {
    w.clock.t = NOW + i * 5 * MIN;
    failTick(0);
    reports.push(await w.team.tick());
    record(w, reports.at(-1));
    const items = w.team.selfCheckItems().filter(x => x.id.startsWith('resume-check'));
    assert.equal(items.length, i + 1 < FAILING_TICKS ? 0 : 1, `after tick ${i + 1}`);
  }
  assert.deepEqual(reports[0].resumeChecks, [{ job: 'db849b9f', message: 'lock directory unreadable', ticks: 1 }]);
  assert.equal(reports[2].resumeChecks[0].ticks, 3);
  assert.deepEqual(lastSnapshot(w).resumeChecks, reports[2].resumeChecks, 'the tick record holds the message');
  const item = w.team.selfCheckItems().find(x => x.id.startsWith('resume-check'));
  assert.match(item.text, /db849b9f/);
  assert.match(item.text, /lock directory unreadable/);
  // a tick with no new failure ends the run
  w.clock.t += 5 * MIN;
  await w.team.tick();
  assert.deepEqual(w.team.selfCheckItems().filter(x => x.id.startsWith('resume-check')), []);
});

test('overlap: a held rebase names both pull requests and both issues by number', () => {
  const text = overlapText({ type: 'rebase', issue: 1139, pr: 1139, file: 'supervisor/team.mjs', other: 1133, prs: [{ number: 1141, headRefName: 'codex/issue-1133-x' }] });
  assert.match(text, /rebase of PR #1139 \(issue #1139\) waits/);
  assert.match(text, /job for issue #1133 \(PR #1141\) also edits/);
  assert.equal(overlapText({ issue: 5, file: 'f', other: 6, prs: [] }), 'issue #5 waits: it is expected to edit f, which the running or planned job for issue #6 also edits');
});

test('the idle text names the hold of the action next for the agent, not holds of other job types', () => {
  const out = classifyIdle({ states: { claude: 'idle', codex: 'idle' }, plan: [{ agent: 'claude', type: 'fix', pr: 1180 }],
    holds: { claude: { rebase: 'rebase of PR #9 waits: overlap', fix: 'fix #1180 skipped (fix): retry cap' } },
    planned: [{ type: 'fix', agent: 'claude', ref: 1180, outcome: 'held', kind: 'retry_cap', reason: 'retry cap: 2 attempts with the same cause (x)' }] });
  assert.equal(out.claude.cause, 'named-hold');
  assert.match(out.claude.hold, /^fix #1180: retry cap/);
  assert.doesNotMatch(out.claude.hold, /rebase of PR #9/);
  assert.equal(out.codex.cause, 'no-eligible-work');
});
