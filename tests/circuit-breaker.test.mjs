// Issue #549: the circuit breaker halts work that spends usage and produces nothing. Fake GitHub, fake jobs, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as B from '../supervisor/breaker.mjs';
import { Team, validateTeamConfig, applyLocalOverride } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute, matchRoute } from '../supervisor/dashrender.mjs';
import crypto from 'node:crypto';
import { requestBreakerResume, takeBreakerResumeRequests } from '../supervisor/breakerresume.mjs';

const NOW = 1_800_000_000_000, HOUR = 3600000;
const H = n => String(n).repeat(40).slice(0, 40);
const L = B.validateBreakerConfig(undefined);
const blocked = (over = {}) => ({ id: 'j' + Math.random().toString(16).slice(2, 10), status: 'blocked', kind: 'review', lastEvent: 'incomplete', updatedAt: NOW, model: 'opus',
  sessions: { lastDecision: 'context_too_large' }, incompleteReason: { cause: 'postcondition_not_met' }, usage: { inputTokens: 1_000_000, outputTokens: 20000, costUsdEstimate: 1.5 }, ...over });
const waste = (job, entry = {}) => B.wasteOf({ id: job.id, entry: { kind: job.kind, agent: 'claude', pr: 10, ...entry }, job });
const stateWith = (...jobs) => { const s = B.emptyState(); for (const j of jobs) B.record(s, waste(j), NOW); return s; };

test('what counts as waste: blocked or refused work with no usable result, never a recorded verdict or a push', () => {
  assert.equal(waste(blocked()).cause, 'review:blocked:postcondition_not_met');
  assert.equal(B.wasteOf({ id: 'a', entry: { kind: 'review', pr: 1 }, job: blocked({ status: 'completed' }), refusal: 'bad-claims' }).cause, 'review:refused:bad-claims');
  // a recorded verdict (CHANGES or PASS) from a job that then blocked is not waste
  assert.equal(B.wasteOf({ id: 'a', entry: { kind: 'review', pr: 1 }, job: blocked(), verdictRecorded: true }), null);
  assert.equal(B.wasteOf({ id: 'a', entry: { kind: 'review', pr: 1 }, job: blocked({ status: 'completed' }), verdictRecorded: true }), null);
  // a completed review with no verdict on file is waste
  assert.equal(B.wasteOf({ id: 'a', entry: { kind: 'review', pr: 1 }, job: blocked({ status: 'completed' }) }).cause, 'review:no-verdict:postcondition_not_met');
  // completed implement, fix and rebase met their post-condition (they pushed)
  for (const kind of ['implement', 'fix', 'cifix', 'rebase']) assert.equal(B.wasteOf({ id: 'a', entry: { kind }, job: blocked({ status: 'completed', kind }) }), null, kind);
  // a failed retry with no push is waste
  assert.equal(B.wasteOf({ id: 'a', entry: { kind: 'cifix', pr: 3 }, job: blocked({ status: 'failed', kind: 'cifix', sessions: {}, incompleteReason: { cause: 'postcondition_not_met' } }) }).cause, 'ci-fix:failed:postcondition_not_met');
  // the provider's own allowance and a job that spent nothing are not waste; a running job is not finished
  assert.equal(waste(blocked({ sessions: {}, incompleteReason: undefined, lastEvent: 'usage_limit' })), null);
  assert.equal(waste(blocked({ usage: { inputTokens: 0, outputTokens: 0, costUsdEstimate: null } })), null);
  assert.equal(waste(blocked({ status: 'running' })), null);
});

test('cause grouping is stable when display figures change', () => {
  const a = waste(blocked({ usage: { inputTokens: 5, outputTokens: 5, costUsdEstimate: 0.1 }, incompleteReason: { cause: 'postcondition_not_met', detail: 'PR #1 at abc' } }), { pr: 1 });
  const b = waste(blocked({ usage: { inputTokens: 9_000_000, outputTokens: 9, costUsdEstimate: 3.33 }, incompleteReason: { cause: 'postcondition_not_met', detail: 'other text' }, sessions: { lastDecision: 'cache_window_expired' } }), { pr: 2 });
  assert.equal(a.cause, b.cause);
  assert.equal(B.verdictErrorCode('a false claim about behaviour, safety, scope or what was verified cannot be immaterial (only a count or wording slip can): adds 3 tests'),
    B.verdictErrorCode('a false claim about behaviour, safety, scope or what was verified cannot be immaterial (only a count or wording slip can): totally different text'));
  assert.notEqual(B.verdictErrorCode('verdict is for a different head'), B.verdictErrorCode('verdict is for a different PR'));
});

test('same-cause trip: three wasted jobs inside six hours, not two, and not when the oldest is outside the window', () => {
  const s = stateWith(blocked(), blocked());
  assert.deepEqual(B.evaluate(s, L, NOW), []);
  B.record(s, waste(blocked({ updatedAt: NOW })), NOW);
  const trips = B.evaluate(s, L, NOW);
  assert.deepEqual(trips.map(t => [t.scope, t.trippedBy]), [['review:blocked:postcondition_not_met', 'count']]);
  const old = stateWith(blocked({ updatedAt: NOW - 7 * HOUR }), blocked(), blocked());
  assert.deepEqual(B.evaluate(old, L, NOW), []);
  assert.equal(Object.keys(old.halts).length, 0);
});

test('cost trip: about $5 of waste of one cause inside the window, with fewer than three jobs', () => {
  const s = stateWith(blocked({ usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 2.6 } }), blocked({ usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 2.5 } }));
  const trips = B.evaluate(s, L, NOW);
  assert.deepEqual(trips.map(t => t.trippedBy), ['cost']);
  assert.ok(Math.abs(Object.values(s.halts)[0].cost - 5.1) < 1e-9);
  assert.deepEqual(B.evaluate(stateWith(blocked({ usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 4.9 } })), L, NOW), []);
});

test('higher limit: waste across causes reaches $15 and every new job stops, merges continue', () => {
  const cause = i => blocked({ incompleteReason: { cause: 'cause' + i }, usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 4 } });
  const s = stateWith(cause(1), cause(2), cause(3));
  assert.deepEqual(B.evaluate(s, L, NOW).map(t => t.trippedBy), ['any-kind-cost', 'any-kind-cost', 'any-kind-cost']);   // $12 of any kind trips each contributing cause, not yet the higher limit
  assert.equal(s.global, null);
  B.record(s, waste(cause(4)), NOW);
  assert.ok(B.evaluate(s, L, NOW).map(t => t.scope).includes('@global'));
  const acts = [{ type: 'implement', issue: 5 }, { type: 'review', pr: 1 }, { type: 'rebase', pr: 2 }, { type: 'ci-fix', pr: 3 }, { type: 'merge', pr: 4 }];
  assert.deepEqual(B.filterActions(s, L, acts).kept.map(a => a.type), ['merge']);
});

test('a cause halt stops only that job type: other work and the implement job that fixes the cause continue', () => {
  const s = stateWith(blocked(), blocked(), blocked());
  B.evaluate(s, L, NOW);
  const acts = [{ type: 'review', pr: 10 }, { type: 'review', pr: 10 }, { type: 'implement', issue: 9 }, { type: 'fix', pr: 3 }, { type: 'rebase', pr: 4 }, { type: 'merge', pr: 5 }];
  const { kept, stopped } = B.filterActions(s, L, acts);
  assert.deepEqual(kept.map(a => a.type), ['implement', 'fix', 'rebase', 'merge']);
  assert.equal(stopped.length, 2);
  // an implement-type cause halts implement, except a named fix issue
  const w = stateWith(...[1, 2, 3].map(() => blocked({ kind: 'implement', sessions: {} })));
  B.evaluate(w, L, NOW);
  assert.equal(B.filterActions(w, L, [{ type: 'implement', pr: 10, issue: 7 }]).kept.length, 0);
  assert.equal(B.filterActions(w, { ...L, fix_issues: [7] }, [{ type: 'implement', pr: 10, issue: 7 }, { type: 'implement', pr: 10, issue: 8 }]).kept.length, 1);
});

test('a halt does not expire, is cleared only by resume, and a cleared cause does not retrip from its old jobs', () => {
  const s = stateWith(blocked(), blocked(), blocked());
  B.evaluate(s, L, NOW);
  assert.equal(Object.keys(s.halts).length, 1);
  B.evaluate(s, L, NOW + 30 * HOUR);   // the window has passed; the halt stays
  assert.equal(Object.keys(s.halts).length, 1);
  assert.deepEqual(B.resume(s, 'no-such-cause', NOW), []);
  assert.equal(Object.keys(s.halts).length, 1);
  assert.deepEqual(B.resume(s, 'review:blocked:postcondition_not_met', NOW + 1), ['review:blocked:postcondition_not_met']);
  B.evaluate(s, L, NOW + 2);
  assert.equal(Object.keys(s.halts).length, 0);
  B.record(s, waste(blocked({ updatedAt: NOW + 10 })), NOW + 10); B.record(s, waste(blocked({ updatedAt: NOW + 11 })), NOW + 11);
  assert.deepEqual(B.evaluate(s, L, NOW + 12), []);   // two new jobs only: the three old ones were cleared
  B.record(s, waste(blocked({ updatedAt: NOW + 13 })), NOW + 13);
  assert.equal(B.evaluate(s, L, NOW + 14).length, 1);
  assert.equal(s.resumes.length, 1, 'the resume is recorded');
});

test('resume all clears the global halt too; only a terminal can resume', () => {
  const s = stateWith(...[1, 2, 3, 4].map(i => blocked({ incompleteReason: { cause: 'c' + i }, usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 4 } })));
  B.evaluate(s, L, NOW);
  assert.ok(s.global);
  assert.deepEqual(B.resume(s, 'all', NOW + 1).includes('@global'), true);
  assert.equal(s.global, null);
  B.evaluate(s, L, NOW + 2);
  assert.equal(s.global, null);
  // Inject env/pid/readProc so the result does not depend on whether the suite itself runs under a supervised job.
  const clean = { env: {}, pid: 1, readProc: () => { throw new Error('no proc'); } };
  assert.equal(B.resumeAllowed({ ...clean, stdin: { isTTY: false }, stdout: { isTTY: true } }), false);
  assert.equal(B.resumeAllowed({ ...clean, stdin: { isTTY: true }, stdout: { isTTY: false } }), false);
  assert.equal(B.resumeAllowed({ ...clean, stdin: { isTTY: true }, stdout: { isTTY: true } }), true);
  assert.equal(B.resumeAllowed({ ...clean, env: { [B.JOB_MARKER]: '1' }, stdin: { isTTY: true }, stdout: { isTTY: true } }), false, 'a supervised job cannot resume');
});

test('config: defaults, validation and a team.local.json override', () => {
  assert.deepEqual(L, { enabled: true, window_hours: 6, same_cause_jobs: 3, cause_cost_usd: 5, global_cost_usd: 15, fix_issues: [] });
  for (const bad of [{ same_cause_jobs: 0 }, { window_hours: -1 }, { global_cost_usd: 1 }, { nope: 1 }, { fix_issues: ['x'] }, { enabled: 'yes' }]) assert.throws(() => B.validateBreakerConfig(bad), /breaker/, JSON.stringify(bad));
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.equal(validateTeamConfig(shipped).breaker.same_cause_jobs, 3);
  assert.equal(applyLocalOverride(shipped, { breaker: { cause_cost_usd: 8, global_cost_usd: 20 } }).breaker.cause_cost_usd, 8);
  assert.throws(() => applyLocalOverride(shipped, { breaker: { cause_cost_usd: 50 } }), /breaker/);
});

// ---- the Team: ingest records waste, the tick filters actions, the halt survives a restart ----
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
const prOf = (n, branch, head) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green });
function world(t, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'breaker-'))) {
  if (!t._cleanup) { t._cleanup = true; t.after(() => fs.rmSync(dir, { recursive: true, force: true })); }
  const gh = { pulls: [prOf(40, 'codex/issue-30-x', H(1)), prOf(41, 'codex/issue-31-y', H(2))], listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null,
    listIssues: async () => [{ number: 5, title: 'Issue five title', state: 'OPEN', body: '', labels: [] }], listMergedPulls: async () => [], comment: async () => {}, hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {}, addLabel: async () => {}, removeLabel: async () => {} };
  const jobs = { states: {}, listActive: async () => [], get: async id => jobs.states[id] || null, create: async () => ({ id: 'x'.repeat(32) }) };
  const mk = () => new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: '## D-020 — x\n- Status: homeowner-approved\n', clock: { now: () => NOW } });
  return { dir, gh, jobs, team: mk(), mk };
}
const add = (w, id, entry, job) => { w.team.s.jobs[id] = { agent: 'claude', ticket: 'a'.repeat(32), key: id, at: NOW - 1000, ingested: false, ...entry }; w.jobs.states[id] = { id, updatedAt: NOW - 1000, ...job }; };
const reviewBlocked = (w, id, pr = 40, over = {}) => add(w, id, { kind: 'review', pr, head: H(1) }, blocked({ id, ...over }));

test('ingest records the waste once, and three blocked reviews trip the breaker for reviews only', async t => {
  const w = world(t);
  for (const id of ['r1', 'r2']) reviewBlocked(w, id);
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report); await w.team.ingest(report);   // twice: still two records
  assert.equal(Object.keys(w.team.s.breaker.waste).length, 2);
  let acts = w.team.applyBreaker([{ type: 'review', agent: 'claude', pr: 41 }], report);
  assert.equal(acts.length, 1, 'two wasted jobs do not trip');
  reviewBlocked(w, 'r3', 41);
  await w.team.ingest(report);
  assert.equal(w.team.applyBreaker([{ type: 'review', agent: 'claude', pr: 41 }], report).length, 1, 'a third failure on another pull request does not trip');
  reviewBlocked(w, 'r4', 40);
  await w.team.ingest(report);
  const input = [{ type: 'review', agent: 'claude', pr: 40 }, { type: 'implement', agent: 'claude', issue: 5 }, { type: 'merge', agent: 'claude', pr: 40 }];
  acts = w.team.applyBreaker(input, report);
  assert.deepEqual(acts.map(a => a.type), ['implement', 'merge']);
  assert.deepEqual(w.team.s.breaker.halts['review:blocked:postcondition_not_met'].subjects, ['pr:40'], 'only the pull request that repeated is held');
  assert.equal(report.breaker.tripped[0].scope, 'review:blocked:postcondition_not_met');
  assert.deepEqual(report.breaker.stopped.map(x => x.ref), [40]);
  assert.equal(w.team.applyBreaker([{ type: 'review', agent: 'claude', pr: 99 }], {}).length, 1, 'a review of another pull request still runs, so a success can clear the halt');
  assert.match(w.team.held.claude.review, /circuit breaker/);
  const v = (await w.team.breakerStatus()).view;
  assert.deepEqual([v.jobs, v.prs], [4, [40, 41]]);
  assert.match(v.text, /usage equivalent/);
});

test('a recorded verdict is not waste: a blocked review that already left CHANGES does not count', async t => {
  const w = world(t);
  for (const id of ['r1', 'r2', 'r3']) { reviewBlocked(w, id); w.team.s.verdicts[`${40}:${id}`] = { verdict: 'CHANGES', job: id, reviewer: 'claude' }; }
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.deepEqual(w.team.s.breaker.waste, {});
});

test('a verdict refused at ingestion is waste with a stable cause, and a valid PASS during a halt is still recorded', async t => {
  const w = world(t);
  const ticket = 'b'.repeat(32), dir = path.join(w.team.dir, 'inbox', ticket); fs.mkdirSync(dir, { recursive: true });
  for (const id of ['v1', 'v2', 'v3']) { add(w, id, { kind: 'review', pr: 40, head: H(1), ticket }, blocked({ id, status: 'completed' })); }
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ pr: 40, headSha: H(1), verdict: 'PASS', findings: [], commandsRun: [], }));   // PASS without commands: refused
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report);
  assert.deepEqual([...new Set(Object.values(w.team.s.breaker.waste).map(x => x.cause))], ['review:refused:bad-commands-run']);
  w.team.applyBreaker([], report);
  assert.equal(Object.keys(w.team.s.breaker.halts).length, 1);
  // the breaker never touches the review gate: a valid PASS from a later job is accepted while the halt is on
  const t2 = 'c'.repeat(32), dir2 = path.join(w.team.dir, 'inbox', t2); fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'verdict.json'), JSON.stringify({ pr: 41, headSha: H(2), verdict: 'PASS', findings: [], commandsRun: ['node --test'] }));
  add(w, 'good', { kind: 'review', pr: 41, head: H(2), ticket: t2, model: 'opus' }, blocked({ id: 'good', status: 'completed', model: 'opus' }));
  await w.team.ingest(report);
  assert.equal(w.team.s.verdicts[`41:${H(2)}`]?.verdict, 'PASS');
  assert.equal(w.team.s.breaker.waste.good, undefined);
});

test('restart keeps the halt; resume clears it and survives a further restart', async t => {
  const w = world(t);
  for (const id of ['r1', 'r2', 'r3']) reviewBlocked(w, id, 40);
  await w.team.ingest({ ingested: [], skipped: [] });
  w.team.applyBreaker([], { });
  const restarted = w.mk();
  assert.deepEqual(restarted.applyBreaker([{ type: 'review', agent: 'claude', pr: 40 }], {}), []);
  assert.equal(restarted.applyBreaker([{ type: 'implement', agent: 'claude', issue: 5 }], {}).length, 1);
  // nothing in a tick clears it, however long it runs
  const later = w.mk(); later.clock = { now: () => NOW + 100 * HOUR };
  later.applyBreaker([], {});
  assert.equal(Object.keys(later.s.breaker.halts).length, 1);
  assert.deepEqual(later.breakerResume('review:blocked:postcondition_not_met').cleared, ['review:blocked:postcondition_not_met']);
  assert.equal(w.mk().applyBreaker([{ type: 'review', agent: 'claude', pr: 40 }], {}).length, 1);
});

test('if the breaker itself fails it reports the failure; existing halts stay and nothing new is invented', async t => {
  const w = world(t);
  for (const id of ['r1', 'r2', 'r3']) reviewBlocked(w, id);
  await w.team.ingest({ ingested: [], skipped: [] });
  w.team.applyBreaker([], {});
  w.team.s.breaker.waste.broken = null;   // a corrupt record makes evaluate throw
  const report = {};
  const acts = w.team.applyBreaker([{ type: 'review', agent: 'claude', pr: 40 }, { type: 'implement', agent: 'claude', issue: 5 }], report);
  assert.ok(report.breaker.error, 'reported in the tick report');
  assert.ok(w.team.s.breaker.error.message, 'kept in the state for the dashboard');
  assert.deepEqual(acts.map(a => a.type), ['implement'], 'the existing halt still applies');
  // the dashboard shows the failure as a Needs you item
  const view = await buildView({ config: config(), root: w.team.root, jobs: [], events: [], state: w.team.s, register: '', cache: { tick: { at: NOW - 1000, status: 'ok', error: null, lastOkAt: NOW - 1000 }, pulls: [], issues: [] }, snapshots: [], now: NOW });
  assert.ok(view.attention.some(a => a.id === 'breaker-error'));
});

test('dashboard: the halt is the top Needs you item with cause, count, cost label and the exact command; wasted usage by cause is shown', async t => {
  const w = world(t);
  for (const id of ['r1', 'r2', 'r3']) reviewBlocked(w, id);
  await w.team.ingest({ ingested: [], skipped: [] });
  w.team.applyBreaker([], {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'breakerdash-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const jobs = [{ id: 'run1', status: 'running', kind: 'implement', issue: 5, provider: 'claude', usage: {}, createdAt: NOW - 1000, updatedAt: NOW - 500 }];
  const view = await buildView({ config: config(), root, jobs, events: [], state: w.team.s, register: '', cache: { tick: { at: NOW - 1000, status: 'ok', error: null, lastOkAt: NOW - 1000 }, pulls: [], issues: [] }, snapshots: [], now: NOW });
  const top = view.panels.needsYou[0];
  assert.equal(top.id, 'breaker-halt');
  assert.match(top.text, /3 wasted jobs/); assert.match(top.text, /usage equivalent/); assert.match(top.text, /#40/); assert.match(top.text, /Still running: implement 5/);
  assert.match(top.decision, /team breaker resume review:blocked:postcondition_not_met/);
  assert.equal(view.breaker.byCause[0].jobs, 3);
  assert.equal(view.breaker.byCause[0].halted, true);
  const html = renderRoute(view, matchRoute('/'));
  assert.equal(html.status, 200); assert.match(html.html, /Work halted/);
  assert.match(html.html, /usage equivalent/);
});

test('replay: the same rules over finished job records show the trip time and the usage saved', () => {
  const at = i => NOW + i * 600000;   // ten minutes apart
  const jobs = [0, 1, 2, 3, 4].map(i => blocked({ id: 'p' + i, createdAt: at(i) - 300000, updatedAt: at(i) }));
  jobs.push(blocked({ id: 'ok', createdAt: at(1), updatedAt: at(1) + 1 }));   // has a recorded verdict: never counted
  const out = B.replay({ jobs, entries: Object.fromEntries(jobs.map(j => [j.id, { kind: 'review', pr: 7 }])), verdictJobs: new Set(['ok']) });
  assert.equal(out.wasted.jobs, 5);
  assert.deepEqual(out.trips.map(t => [t.scope, t.at, t.jobsPrevented]), [['review:blocked:postcondition_not_met', at(2), 2]]);   // jobs 3 and 4 were created after the trip
  assert.equal(out.trips[0].costSaved, 3);
});

test('cost trip counts waste of any kind: three causes of $2 each reach $5 together', () => {
  const s = stateWith(...[1, 2, 3].map(i => blocked({ incompleteReason: { cause: 'k' + i }, usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 2 } })));
  assert.equal(B.evaluate(s, L, NOW).length, 3);
  const small = stateWith(...[1, 2].map(i => blocked({ incompleteReason: { cause: 'k' + i }, usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 2 } })));
  assert.deepEqual(B.evaluate(small, L, NOW), []);
});

test('the cause is the stop reason, not the session-resume decision', () => {
  const causes = ['new_job', 'within_window', 'cache_window_expired', 'context_too_large'].map(d => waste(blocked({ sessions: { lastDecision: d }, incompleteReason: undefined })).cause);
  assert.deepEqual([...new Set(causes)], ['review:blocked:incomplete']);
});

test('a provider usage-limit stop is not waste even when a session decision is recorded', () => {
  assert.equal(waste(blocked({ lastEvent: 'usage_limit', incompleteReason: undefined, sessions: { lastDecision: 'new_job' } })), null);
  assert.equal(waste(blocked({ lastEvent: 'retry_exhausted', incompleteReason: undefined, usageLimitHits: 3 })), null);
  assert.equal(waste(blocked({ lastEvent: 'retry_exhausted', incompleteReason: { cause: 'retry_exhausted' }, usageLimitHits: 3 })), null);
  // an unrelated specific cause after a usage-limit hit is real waste, not hidden by the exemption
  assert.equal(waste(blocked({ lastEvent: 'retry_exhausted', incompleteReason: { cause: 'postcondition_not_met' }, usageLimitHits: 1 })).cause, 'review:blocked:postcondition_not_met');
  // retry_exhausted with no usage-limit hit is still waste
  assert.ok(waste(blocked({ lastEvent: 'retry_exhausted', incompleteReason: undefined, usageLimitHits: 0 })));
});

test('resume is refused for a process under a supervised job, even with a terminal', () => {
  const tty = { isTTY: true };
  assert.equal(B.resumeAllowed({ stdin: tty, stdout: tty, env: {}, pid: 0 }), true);
  assert.equal(B.resumeAllowed({ stdin: tty, stdout: tty, env: { AI_SUPERVISOR_JOB: 'j1' } }), false);
  const proc = { '/proc/30/environ': 'PATH=/bin\0', '/proc/30/stat': '30 (sh) S 20 0', '/proc/20/environ': 'AI_SUPERVISOR_JOB=j1\0', '/proc/20/stat': '20 (claude) S 1 0' };
  assert.equal(B.resumeAllowed({ stdin: tty, stdout: tty, env: {}, pid: 30, readProc: p => { if (!(p in proc)) throw new Error('x'); return proc[p]; } }), false);
});

test('trippedBy labels: every value the breaker records has display text, unknown values pass through', () => {
  for (const v of ['count', 'cost', 'any-kind-cost']) assert.notEqual(B.trippedByLabel(v), v);
  assert.equal(B.trippedByLabel('something-new'), 'something-new');
  // inherited Object.prototype keys must pass through as text, not resolve to prototype members
  for (const k of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) assert.equal(B.trippedByLabel(k), k);
});

test('haltView exposes a display label next to the raw trippedBy, for the view and every entry', () => {
  const s = stateWith(blocked({ usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 2.6 } }), blocked({ usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 2.5 } }));
  B.evaluate(s, L, NOW);
  const v = B.haltView(s);
  assert.equal(v.trippedBy, 'cost');
  assert.equal(v.trippedByLabel, B.TRIPPED_BY_LABEL.cost);
  assert.ok(v.entries.length > 0 && v.entries.every(e => e.trippedByLabel === B.trippedByLabel(e.trippedBy) && e.trippedByLabel !== e.trippedBy));
});

// ---- issue #626: judge by repeat cause and cost, clear itself, Resume
const onPr = (pr, over = {}) => waste(blocked({ usage: { inputTokens: 10, outputTokens: 10, costUsdEstimate: 0.4 }, ...over }), { pr });

test('the 5 Nov sequence: cheap failures of one cause across different pull requests do not trip; the same pull request failing repeatedly does', () => {
  const s = B.emptyState();
  for (const pr of [101, 102, 103]) B.record(s, onPr(pr), NOW);
  assert.deepEqual(B.evaluate(s, L, NOW), [], 'three cheap failures on three pull requests');
  assert.deepEqual(s.halts, {});
  // a fourth and fifth on different pull requests still do not
  for (const pr of [104, 105]) B.record(s, onPr(pr), NOW);
  assert.deepEqual(B.evaluate(s, L, NOW), []);
  // the same pull request failing three times does
  const t = B.emptyState();
  for (const i of [1, 2, 3]) B.record(t, onPr(101), NOW + i);
  assert.deepEqual(B.evaluate(t, L, NOW + 5).map(x => [x.scope, x.trippedBy]), [['review:blocked:postcondition_not_met', 'count']]);
  assert.match(B.trippedByLabel('count'), /one pull request/);
  // two on one pull request plus one elsewhere is still not a repeat
  const u = B.emptyState();
  B.record(u, onPr(101), NOW); B.record(u, onPr(101), NOW + 1); B.record(u, onPr(102), NOW + 2);
  assert.deepEqual(B.evaluate(u, L, NOW + 3), []);
});

test('a meaningful cost trips even across unrelated pull requests', () => {
  const s = B.emptyState();
  for (const pr of [1, 2]) B.record(s, onPr(pr, { usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 2.6 } }), NOW);
  assert.deepEqual(B.evaluate(s, L, NOW).map(x => x.trippedBy), ['cost']);
});

test('self-clearing: a later successful job of the halted type ends the halt; an earlier or other-type job does not', () => {
  const s = B.emptyState();
  for (const i of [1, 2, 3]) B.record(s, onPr(7), NOW + i);
  B.evaluate(s, L, NOW + 10);
  const cause = 'review:blocked:postcondition_not_met', since = s.halts[cause].since;
  assert.deepEqual(B.succeeded(s, { type: 'review', createdAt: since - 1 }, NOW + 20), [], 'a job already running when it tripped does not clear it');
  assert.deepEqual(B.succeeded(s, { type: 'implement', createdAt: since + 1 }, NOW + 20), [], 'another type does not');
  assert.deepEqual(B.succeeded(s, { type: 'review', createdAt: undefined }, NOW + 20), []);
  assert.ok(s.halts[cause]);
  assert.deepEqual(B.succeeded(s, { type: 'review', createdAt: since + 1 }, NOW + 30), [cause]);
  assert.deepEqual(s.halts, {});
  assert.equal(s.resumes.at(-1).by, 'success');
  B.evaluate(s, L, NOW + 31);
  assert.deepEqual(s.halts, {}, 'the old waste does not retrip it');
  // the higher global limit is not cleared by a success
  const g = stateWith(...[1, 2, 3, 4].map(i => blocked({ incompleteReason: { cause: 'c' + i }, usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 4 } })));
  B.evaluate(g, L, NOW);
  B.succeeded(g, { type: 'review', createdAt: NOW + 5 }, NOW + 6);
  assert.ok(g.global);
});

test('tick: a completed review after the halt clears it; one that wasted does not; a restart keeps an uncleared halt', async t => {
  const w = world(t);
  for (const id of ['r1', 'r2', 'r3']) reviewBlocked(w, id, 40);
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report); w.team.applyBreaker([], report);
  const cause = 'review:blocked:postcondition_not_met', halted = w.team.s.breaker.halts[cause];
  assert.ok(halted);
  // a later review that also wastes leaves it halted
  add(w, 'bad', { kind: 'review', pr: 41, head: H(2) }, blocked({ id: 'bad', createdAt: halted.since + 5 }));
  await w.team.ingest(report);
  assert.ok(w.mk().s.breaker.halts[cause], 'still halted after a restart');
  // a later review that completes with a recorded verdict clears it
  const ticket = 'd'.repeat(32), dir = path.join(w.team.dir, 'inbox', ticket); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ pr: 41, headSha: H(2), verdict: 'PASS', findings: [], commandsRun: ['node --test'] }));
  add(w, 'good', { kind: 'review', pr: 41, head: H(2), ticket, model: 'opus' }, blocked({ id: 'good', status: 'completed', model: 'opus', createdAt: halted.since + 10 }));
  await w.team.ingest(report);
  assert.deepEqual(report.breaker.cleared, [cause]);
  assert.equal(w.mk().applyBreaker([{ type: 'review', agent: 'claude', pr: 41 }], {}).length, 1, 'new reviews start again, also after a restart');
});

test('tick: a Resume request left by the dashboard clears the halt; an unknown scope clears nothing; the global halt survives a restart until resumed', async t => {
  const w = world(t);
  for (const id of ['r1', 'r2', 'r3']) reviewBlocked(w, id, 40);
  await w.team.ingest({ ingested: [], skipped: [] }); w.team.applyBreaker([], {});
  const cause = 'review:blocked:postcondition_not_met';
  requestBreakerResume(w.team.root, 'no-such-cause', NOW);
  const r1 = {}; w.team.applyBreaker([], r1);
  assert.ok(w.team.s.breaker.halts[cause]); assert.equal(r1.breaker?.resumed, undefined);
  requestBreakerResume(w.team.root, cause, NOW + 1);
  const r2 = {}; w.team.applyBreaker([], r2);
  assert.deepEqual(r2.breaker.resumed[0].cleared, [cause]);
  assert.equal(w.mk().s.breaker.halts[cause], undefined, 'saved');
  assert.deepEqual(takeBreakerResumeRequests(w.team.root), [], 'requests are consumed');
  // global halt: survives a restart, is cleared by a request for global
  w.team.s.breaker.global = { since: NOW, trippedBy: 'cost', jobs: 1, tokens: 1, cost: 16, prs: [], types: ['review'], causes: [] }; w.team.save();
  assert.deepEqual(w.mk().applyBreaker([{ type: 'implement', agent: 'claude', issue: 5 }], {}), []);
  requestBreakerResume(w.team.root, 'global', NOW + 2);
  w.team.applyBreaker([], {});
  assert.equal(w.mk().applyBreaker([{ type: 'implement', agent: 'claude', issue: 5 }], {}).length, 1);
});

test('a malformed resume request file is dropped, never applied', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bresume-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const d = path.join(root, 'dashboard', 'breaker-resume'); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, '1-a.json'), '{not json'); fs.writeFileSync(path.join(d, '2-b.json'), JSON.stringify({ scope: 5, at: 'x' }));
  assert.deepEqual(takeBreakerResumeRequests(root), []); assert.deepEqual(fs.readdirSync(d), []);
});

test('the halt card has a Resume button per halt, and the output carries no secret-shaped text', async t => {
  const w = world(t);
  const secret = 'gh' + 'p_' + crypto.randomBytes(12).toString('hex');
  for (const id of ['r1', 'r2', 'r3']) reviewBlocked(w, id, 40);
  await w.team.ingest({ ingested: [], skipped: [] }); w.team.applyBreaker([], {});
  w.team.breakerFailed(new Error(`failed with ${secret}`), {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'breakerdash-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const view = await buildView({ config: config(), root, jobs: [], events: [], state: w.team.s, register: '', cache: { tick: { at: NOW - 1000, status: 'ok', error: null, lastOkAt: NOW - 1000 }, pulls: [], issues: [] }, snapshots: [], now: NOW });
  const html = renderRoute(view, matchRoute('/')).html;
  assert.match(html, /<form method="post" action="\/breaker-resume"[^>]*><input type="hidden" name="scope" value="review:blocked:postcondition_not_met">/);
  assert.match(html, /Resume review:blocked:postcondition_not_met/);
  assert.ok(!html.includes(secret) && !JSON.stringify(view).includes(secret), 'a secret-shaped value never reaches the page or the view');
});

test('a review halt can clear itself through the planner: a review of another PR is allowed, and its success clears the halt', () => {
  const s = stateWith(...[1, 2, 3].map(() => blocked()));
  B.evaluate(s, L, NOW);
  const h = s.halts['review:blocked:postcondition_not_met'];
  assert.deepEqual(h.subjects, ['pr:10']);
  assert.ok(B.blocks(s, L, { type: 'review', pr: 10 }), 'the failing pull request stays held');
  assert.equal(B.blocks(s, L, { type: 'review', pr: 99 }), null, 'another pull request may start a review');
  assert.equal(B.filterActions(s, L, [{ type: 'review', pr: 99 }]).kept.length, 1);
  assert.deepEqual(B.succeeded(s, { type: 'review', createdAt: h.since + 1 }, NOW + 5), [h.cause]);
  assert.equal(B.blocks(s, L, { type: 'review', pr: 10 }), null);
  // a cost trip holds every contributing pull request, not the others
  const c = stateWith(blocked({ usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 3 } }), blocked({ usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 3 } }));
  c.waste[Object.keys(c.waste)[1]].pr = 11;
  B.evaluate(c, L, NOW);
  assert.deepEqual(Object.values(c.halts)[0].subjects, ['pr:10', 'pr:11']);
  assert.ok(B.blocks(c, L, { type: 'review', pr: 11 })); assert.equal(B.blocks(c, L, { type: 'review', pr: 12 }), null);
});

// Issue #737
test('a halt recorded before subjects existed keeps holding the whole type after evaluate, instead of an empty list', () => {
  const cheap = { usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 0.1 } }, s = B.emptyState();
  for (const pr of [10, 11, 12]) { const j = blocked(cheap); B.record(s, waste(j, { pr }), NOW); }
  const cause = 'review:blocked:postcondition_not_met';
  B.evaluate(s, L, NOW);
  assert.equal(s.halts[cause], undefined, 'three different pull requests do not trip it');
  s.halts[cause] = { cause, since: NOW - 1000, trippedBy: 'count', jobs: 3, tokens: 0, cost: 0, prs: [10, 11, 12], issues: [], types: ['review'], jobIds: [] };
  B.evaluate(s, L, NOW);
  assert.equal(s.halts[cause].subjects, undefined, 'no empty list is invented');
  assert.ok(B.blocks(s, L, { type: 'review', pr: 99 }), 'the old whole-type hold still applies');
});

test('a continue job carrying both pr and issue is held when either subject is held', () => {
  const s = B.emptyState();
  for (let i = 0; i < 3; i++) { const j = blocked({ usage: { inputTokens: 1, outputTokens: 1, costUsdEstimate: 0.1 } }); B.record(s, waste(j, { pr: null, issue: 7 }), NOW); }
  B.evaluate(s, L, NOW);
  const h = Object.values(s.halts)[0];
  assert.deepEqual(h.subjects, ['issue:7']);
  const type = h.types[0];
  assert.ok(B.blocks(s, L, { type, pr: 50, issue: 7 }), 'issue-scoped halt holds a job that also has a pr');
  assert.equal(B.blocks(s, L, { type, pr: 50, issue: 8 }), null, 'unrelated pr and issue still run');
});

test('a resume request file survives a failed save and is applied by the next tick', async t => {
  const w = world(t);
  for (const id of ['r1', 'r2', 'r3']) reviewBlocked(w, id, 40);
  await w.team.ingest({ ingested: [], skipped: [] }); w.team.applyBreaker([], {});
  const cause = 'review:blocked:postcondition_not_met';
  requestBreakerResume(w.team.root, cause, NOW + 1);
  const save = w.team.save; w.team.save = () => { throw new Error('disk full'); };
  assert.throws(() => w.team.applyResumeRequests({}), /disk full/);
  w.team.save = save;
  const r = {}; w.team.s.breaker.halts[cause] ||= {}; w.team.applyResumeRequests(r);
  assert.deepEqual(r.breaker?.resumed?.[0]?.scope, cause, 'the click was not lost');
  assert.deepEqual(takeBreakerResumeRequests(w.team.root), []);
});
