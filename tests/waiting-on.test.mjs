// Issue #1023: prose dependencies keep an issue out of the queue; a job that stopped on an open prerequisite waits and is queued again when it merges.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, proseDependencies, waitingOnRefs, implementPrompt } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } });
const issue = (n, body = '', state = 'OPEN') => ({ number: n, title: `Issue ${n}`, state, body, labels: [] });
const pr = (n, branch) => ({ number: n, title: `PR title ${n}`, headRefName: branch, headRefOid: H(n % 9), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
function world(t, { issues = [], pulls = [], merged = [], jobs = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waiton-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, listIssues: async () => issues, listMergedPulls: async () => merged, getIssue: async n => issues.find(i => i.number === n) || null };
  const jobStore = { listActive: async () => [], get: async id => jobs[id] || null, create: async () => ({ id: 'a'.repeat(32) }) };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs: jobStore, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1000 } });
  return { team, dir };
}
const implemented = plan => plan.filter(a => a.type === 'implement').map(a => a.issue);

test('prose dependency lines are parsed; code, other phrasing and unspecific "after #N" are not', () => {
  assert.deepEqual(proseDependencies('Depends on #12, PR 13 and #14.'), { prs: [13], numbers: [12, 14] });
  assert.deepEqual(proseDependencies('Do this after PR 980 and after #985 merges.'), { prs: [980], numbers: [985] });
  assert.deepEqual(proseDependencies('after PR #5 merges'), { prs: [5], numbers: [] });
  assert.deepEqual(proseDependencies('We reply after #7 was seen. See #8.'), { prs: [], numbers: [] });
  assert.deepEqual(proseDependencies('```\nDepends on #99\n```\nand `after PR 98`'), { prs: [], numbers: [] });
  assert.deepEqual(proseDependencies('Depends on #N and after PR N'), { prs: [], numbers: [] });
  assert.deepEqual(proseDependencies(''), { prs: [], numbers: [] });
});

test('prose dependencies no longer hold an issue; only the Depends on line does (issue #1103)', async t => {
  const w = world(t, { issues: [issue(30, 'Depends on #20.\nafter PR 21'), issue(20, '', 'CLOSED')], pulls: [pr(21, 'codex/issue-2-x')] });
  assert.deepEqual(implemented(await w.team.plan()), [30]);
});

test('waitingOnRefs ignores merged, closed and unknown items', () => {
  const byNo = new Map([[5, issue(5)], [6, issue(6, '', 'CLOSED')]]);
  assert.deepEqual(waitingOnRefs(issue(1, 'Depends on #5, #6, #7 and PR 8'), byNo, [pr(8, 'x/y')]), [5, 8]);
  assert.deepEqual(waitingOnRefs(issue(1, ''), byNo, [], [5, 6, 9]), [5]);
});

test('the implement prompt tells a job to report an open prerequisite instead of failing', () => {
  const p = implementPrompt({ issue: 9, branch: 'claude/issue-9-x', waitingFile: '/state/inbox/abc/waiting-on.json' });
  assert.match(p, /waiting_on/); assert.match(p, /\/state\/inbox\/abc\/waiting-on\.json/);
  assert.doesNotMatch(implementPrompt({ issue: 9, branch: 'claude/issue-9-x' }), /waiting_on/);
});

test('post-condition: no PR and an open prerequisite sets waitingOn; a PR clears it; closed items and bad reports count for nothing', async t => {
  const w = world(t, { issues: [issue(9, 'Depends on: #20, #22'), issue(20), issue(21, '', 'CLOSED')], pulls: [] });
  const ticket = 'f'.repeat(32), inbox = path.join(w.team.dir, 'inbox', ticket); fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'waiting-on.json'), JSON.stringify({ waiting_on: [20, 21, 'x', -3, 9, 22] }));
  const check = w.team.postconditions();
  const job = { issue: 9, postcondition: { kind: 'pr_opened', branch: 'claude/issue-9-x', ticket } };
  assert.equal(await check(job), false); assert.deepEqual(job.waitingOn, [20], 'only the open one; self, closed, unknown and malformed are dropped');
  w.team.gh.listPulls = async () => [pr(40, 'claude/issue-9-x')];
  assert.equal(await check(job), true); assert.equal(job.waitingOn, undefined);
  const none = world(t, { issues: [issue(9, 'no deps')] }), j2 = { issue: 9, postcondition: { kind: 'pr_opened', branch: 'b', ticket: 'none' } };
  assert.equal(await none.team.postconditions()(j2), false); assert.equal(j2.waitingOn, undefined);
});

test('a waiting_on implement job is recorded without a failure, notice or implemented mark, and the issue is queued again after the item merges', async t => {
  const id = 'b'.repeat(32), job = { id, status: 'waiting_on', lastEvent: 'waiting_on', waitingOn: [20] };
  const w = world(t, { issues: [issue(9)], pulls: [pr(20, 'codex/issue-19-x')], jobs: { [id]: job } });
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', ingested: false, at: 1000 };
  w.team.s.implemented[9] = 500;
  const report = { ingested: [], notified: [] };
  await w.team.ingestOneInner(id, w.team.s.jobs[id], report);
  assert.deepEqual(w.team.s.waitingOn[9].items, [20]);
  assert.equal(w.team.s.implemented[9], undefined, 'not marked implemented');
  assert.equal(w.team.s.jobs[id].endedNoPr, undefined);
  assert.deepEqual(report.waiting, [{ job: id, issue: 9, items: [20] }]);
  assert.deepEqual(report.notified, [], 'no notice and no needs-homeowner');
  assert.deepEqual(implemented(await w.team.plan()), [], 'held while PR 20 is open');
  w.team.gh.listPulls = async () => []; w.team.gh.listMergedPulls = async () => [{ number: 20, title: 'x', mergedAt: '2026-11-07T00:00:00Z' }];
  assert.deepEqual(implemented(await w.team.plan()), [9], 'queued again on the first tick after the merge');
});

test('issue #1118: the issue body is not read for the stop; only the reported numbers count', async t => {
  const w = world(t, { issues: [issue(9, 'Prerequisites: #20\nDepends on: #20\nafter PR 20'), issue(20), issue(30)], pulls: [] });
  w.team.c.depends_on_overrides = { 9: [20] };
  const ticket = 'e'.repeat(32), inbox = path.join(w.team.dir, 'inbox', ticket); fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'waiting-on.json'), JSON.stringify({ waiting_on: [30] }));
  const job = { issue: 9, postcondition: { kind: 'pr_opened', branch: 'claude/issue-9-x', ticket } };
  assert.equal(await w.team.postconditions()(job), false);
  assert.deepEqual(job.waitingOn, [30], 'the body, its Depends on line and the override add nothing');
});

test('issue #1107: a waiting_on end goes through the one classifier and is neither a fault nor an attempt', async t => {
  const id = 'c'.repeat(32), job = { id, status: 'waiting_on', lastEvent: 'waiting_on', waitingOn: [20] };
  const w = world(t, { issues: [issue(9)], pulls: [pr(20, 'codex/issue-19-x')], jobs: { [id]: job } });
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', ingested: false, at: 1000 };
  const seen = [], onEnd = w.team.faults.onEnd.bind(w.team.faults);
  w.team.faults.onEnd = (...a) => { const c = onEnd(...a); seen.push(c); return c; };
  const report = { ingested: [], notified: [] };
  await w.team.ingestOneInner(id, w.team.s.jobs[id], report);
  assert.deepEqual(seen.map(c => [c.kind, c.cause]), [['none', 'waiting_on']]);
  assert.equal(report.infraFaults, undefined, 'a prerequisite wait is not an infrastructure fault');
  assert.deepEqual(w.team.s.waitingOn[9].items, [20]);
});

test('issue #1107: a completed end goes through the one classifier', async t => {
  const id = 'd'.repeat(32), job = { id, status: 'completed', lastEvent: 'completed' };
  const w = world(t, { issues: [issue(9)], pulls: [], jobs: { [id]: job } });
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', ingested: false, at: 1000 };
  const seen = [], onEnd = w.team.faults.onEnd.bind(w.team.faults);
  w.team.faults.onEnd = (...a) => { const c = onEnd(...a); seen.push(c); return c; };
  await w.team.ingestOneInner(id, w.team.s.jobs[id], { ingested: [], notified: [] });
  assert.deepEqual(seen.map(c => [c.kind, c.cause]), [['work', 'completed']]);
});
