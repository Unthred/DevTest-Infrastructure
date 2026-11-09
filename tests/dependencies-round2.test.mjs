// Issue #1103, review round 2: the stop on a fresh Team, the attempt refund per lane, old and pull-request prerequisites, the cached view.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dependencyPlain, dependencyAttention, enforceStops, chargedCounter, refreshDependencies } from '../supervisor/teamdeps.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const sha = c => c.repeat(40);
const INSTALLED = sha('a'), MERGED_IN = sha('b');
const ancestor = (a, b) => a === MERGED_IN && b === INSTALLED;
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const issue = (n, body = '', state = 'OPEN', stateReason = null, extra = {}) => ({ number: n, title: `Issue ${n}`, state, stateReason, body, labels: [], ...extra });
const pull = (n, state, oid = null) => ({ number: n, state, mergeCommit: oid ? { oid } : null });

function world(t, { issues, mergedPulls = [], getPull, getIssue, active = [] }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'deps2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stopped = [];
  const gh = { listPulls: async () => [], listIssues: async () => issues, listMergedPulls: async () => mergedPulls,
    getIssue: getIssue || (async n => issues.find(i => i.number === n) || null), ...(getPull ? { getPull } : {}) };
  const jobs = { listActive: async () => active, get: async () => ({ status: 'stopped', lastEvent: 'manual_stop' }), stop: async id => { stopped.push(id); } };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: {}, register: REGISTER, clock: { now: () => 1000 } });
  team.depEnv = { installedSha: () => INSTALLED, isAncestor: ancestor };
  return { team, stopped };
}

test('the tick stop step works on a fresh Team that has not planned yet', async t => {
  const id = 'e'.repeat(32);
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)], active: [{ id, provider: 'claude', status: 'running' }] });
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', at: 500 };
  assert.equal(w.team.dependencies, undefined, 'no plan() ran');
  await enforceStops(w.team, {});
  assert.deepEqual(w.stopped, [id]);
});

for (const act of [{ type: 'review', key: 'k' }, { type: 'fix', key: 'k' }, { type: 'continue', pr: 50, key: 'k' }, { type: 'rebase', key: 'k' }, { type: 'cifix', key: 'k' }]) {
  test(`a dependency stop of a ${act.type} job gives its attempt back`, async t => {
    const id = 'f'.repeat(32);
    const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)], active: [{ id, provider: 'claude', status: 'running' }] });
    const [counter, key] = chargedCounter({ ...act, pr: 50 });
    w.team.s[counter][key] = 1;
    w.team.s.jobs[id] = { kind: act.type, agent: 'claude', key: act.key, pr: 50, branch: 'claude/issue-9-x', head: sha('1'), ingested: false, at: 500 };
    await enforceStops(w.team, {});
    assert.equal(w.team.s[counter][key], 0, 'attempt refunded');
    await enforceStops(w.team, {});
    await w.team.ingestOneInner(id, w.team.s.jobs[id], { ingested: [], notified: [] });
    assert.equal(w.team.s[counter][key], 0, 'refunded once');
  });
}

test('a secret-scan-only fix charges no attempt, so none is refunded', () => {
  assert.equal(chargedCounter({ type: 'cifix', scanOnly: true, key: 'k' }), null);
  assert.equal(chargedCounter({ type: 'merge' }), null);
});

test('a closed prerequisite in the issue list still reaches its closing pull request', async t => {
  const w = world(t, { issues: [issue(5, 'Depends on: #20'), issue(20, '', 'CLOSED', 'COMPLETED', { closedByPullRequestsReferences: [{ number: 90 }] })],
    getPull: async n => (n === 90 ? pull(90, 'MERGED', MERGED_IN) : null) });
  await w.team.plan();
  assert.equal(w.team.dependencies.byIssue.get(5).dependsOn[0].state, 'installed');
});

test('a prerequisite that names a merged pull request resolves, however old', async t => {
  const w = world(t, { issues: [issue(5, 'Depends on: #77')], getIssue: async n => ({ number: n, state: 'MERGED', stateReason: '', labels: [] }),
    getPull: async n => (n === 77 ? pull(77, 'MERGED', MERGED_IN) : null) });
  await w.team.plan();
  assert.equal(w.team.dependencies.byIssue.get(5).dependsOn[0].state, 'installed');
});

test('a prerequisite pull request closed without a merge raises the repoint item', async t => {
  const w = world(t, { issues: [issue(5, 'Depends on: #77')], getIssue: async n => ({ number: n, state: 'CLOSED', stateReason: '', labels: [] }),
    getPull: async n => (n === 77 ? pull(77, 'CLOSED') : null) });
  await w.team.plan();
  assert.equal(w.team.dependencies.byIssue.get(5).dependsOn[0].state, 'closed_not_planned');
  assert.deepEqual(dependencyAttention({ dependencies: dependencyPlain(w.team.dependencies) }).map(i => i.id), ['dependency-notplanned-5-77']);
});

test('a failed pull request read stays unknown', async t => {
  const w = world(t, { issues: [issue(5, 'Depends on: #77')], getIssue: async n => ({ number: n, state: 'MERGED', stateReason: '', labels: [] }),
    getPull: async () => { throw new Error('gh'); } });
  await w.team.plan();
  assert.equal(w.team.dependencies.byIssue.get(5).dependsOn[0].state, 'unknown');
});

test('a Team restored from the dashboard cache keeps its dependencies; body-less cached issues do not clear them', async t => {
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)] });
  await w.team.plan();
  const plain = dependencyPlain(w.team.dependencies);
  const cached = world(t, { issues: [issue(9), issue(20)] });   // the cache drops issue bodies
  cached.team.dependencies = Team.dependencyTools.fromPlain(plain);
  cached.team.depFromCache = true;
  const plan = await cached.team.plan();
  assert.deepEqual(plan.filter(a => a.type === 'implement').map(a => a.issue), [20], 'issue 9 still waits');
  assert.equal(cached.team.exclusion(9, new Map([[9, issue(9)]]), []).kind, 'dependency');
  assert.equal(await refreshDependencies(cached.team, [], []), cached.team.dependencies);
});
