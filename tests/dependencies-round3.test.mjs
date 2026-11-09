// Issue #1118: the unlinked prerequisite, the escalated round given back, reads kept across passes, and one source for dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencyPlain, dependencyAttention, enforceStops } from '../supervisor/teamdeps.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const sha = c => c.repeat(40);
const INSTALLED = sha('a'), MERGED_IN = sha('b');
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const issue = (n, body = '', state = 'OPEN', stateReason = null, extra = {}) => ({ number: n, title: `Issue ${n}`, state, stateReason, body, labels: [], ...extra });

function world(t, { issues, active = [], dir = null, getPull = null }) {
  const root = dir || fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'deps3-'));
  if (!dir) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const reads = { listIssues: 0, getIssue: 0, getPull: 0 }, stopped = [];
  const gh = { listPulls: async () => [], listIssues: async () => { reads.listIssues++; return issues; }, listMergedPulls: async () => [],
    getIssue: async n => { reads.getIssue++; return issues.find(i => i.number === n) || { number: n, state: 'CLOSED', stateReason: 'COMPLETED', closedByPullRequestsReferences: [{ number: 90 }] }; },
    getPull: async n => { reads.getPull++; return getPull ? getPull(n) : null; } };
  const jobs = { listActive: async () => active, get: async () => ({ status: 'stopped', lastEvent: 'manual_stop' }), stop: async id => { stopped.push(id); } };
  const team = new Team({ config: config(), root: stateRoot(path.join(root, 'state')), gh, jobs, git: {}, register: REGISTER, clock: { now: () => 1000 } });
  team.depEnv = { installedSha: () => INSTALLED, isAncestor: (a, b) => a === MERGED_IN && b === INSTALLED };
  return { team, stopped, reads, root };
}

test('a prerequisite closed as completed with no linked pull request raises a Needs you item and still holds', async t => {
  const id = 'a'.repeat(32);
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20, '', 'CLOSED', 'COMPLETED', { closedByPullRequestsReferences: [] })], active: [{ id, provider: 'claude', status: 'running' }] });
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', at: 500 };
  await enforceStops(w.team, {});
  const entry = w.team.dependencies.byIssue.get(9);
  assert.equal(entry.met, false);
  assert.equal(entry.dependsOn[0].state, 'unknown');
  assert.equal(entry.dependsOn[0].unlinked, true);
  assert.deepEqual(w.stopped, [id]);
  const items = dependencyAttention({ dependencies: dependencyPlain(w.team.dependencies) });
  assert.deepEqual(items.map(i => i.id), ['dependency-unlinked-9-20']);
  assert.match(items[0].text, /no linked pull request/);
});

test('a failed lookup of the closing pull request is not reported as unlinked', async t => {
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20, '', 'CLOSED', 'COMPLETED', { closedByPullRequestsReferences: [{ number: 90 }] })] });
  await w.team.plan();
  assert.equal(w.team.dependencies.byIssue.get(9).dependsOn[0].unlinked, undefined);
});

test('a dependency stop of an escalated fix gives the one final round back', async t => {
  const id = 'b'.repeat(32);
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)], active: [{ id, provider: 'claude', status: 'running' }] });
  w.team.s.fixAttempts['50'] = 3;
  w.team.s.unblock.escalated[50] = { head: sha('1'), at: 1 };
  w.team.s.jobs[id] = { kind: 'fix', agent: 'claude', key: '50', pr: 50, branch: 'claude/issue-9-x', head: sha('1'), escalated: true, ingested: false, at: 500 };
  await enforceStops(w.team, {});
  assert.equal(w.team.s.fixAttempts['50'], 2);
  assert.equal(w.team.s.unblock.escalated[50], undefined, 'the final round can run again');
});

test('a closed prerequisite is remembered across passes: a new Team does not ask GitHub again', async t => {
  const issues = [issue(5, 'Depends on: #20'), issue(5000)];
  const first = world(t, { issues, getPull: async n => ({ number: n, state: 'MERGED', mergeCommit: { oid: MERGED_IN } }) });
  await first.team.plan();
  assert.equal(first.team.dependencies.byIssue.get(5).dependsOn[0].state, 'installed');
  assert.deepEqual([first.reads.getIssue, first.reads.getPull], [1, 1]);
  const second = world(t, { issues, dir: first.root, getPull: async () => { throw new Error('asked again'); } });
  await second.team.plan();
  assert.equal(second.team.dependencies.byIssue.get(5).dependsOn[0].state, 'installed');
  assert.deepEqual([second.reads.getIssue, second.reads.getPull], [0, 0]);
});

test('the stop step and the planner read the issue list once per pass', async t => {
  const id = 'c'.repeat(32);
  const w = world(t, { issues: [issue(9), issue(20)], active: [{ id, provider: 'claude', status: 'running' }] });
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', at: 500 };
  await enforceStops(w.team, {});
  await w.team.plan();
  assert.equal(w.reads.listIssues, 1);
  await w.team.plan();
  assert.equal(w.reads.listIssues, 2, 'the hand-over is used once');
});

test('only the Depends on line holds an issue: Prerequisites, prose and depends_on_overrides do not', async t => {
  const w = world(t, { issues: [issue(9, 'Prerequisites: #20\nafter PR 20\nBlocked by #20'), issue(20)] });
  w.team.c.depends_on_overrides = { 9: [20] };
  const plan = await w.team.plan();
  assert.ok(plan.some(a => a.type === 'implement' && a.issue === 9), 'issue 9 is eligible');
});
