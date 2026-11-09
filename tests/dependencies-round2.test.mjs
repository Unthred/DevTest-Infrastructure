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

// ---- review follow-ups (issue #1118)
const runningJob = (id, extra = {}) => ({ kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', at: 500, ...extra });

test('a real tick stops a running job whose issue gained an unmet prerequisite', async t => {
  const id = 'd'.repeat(32);
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)], active: [{ id, provider: 'claude', status: 'running' }] });
  w.team.s.jobs[id] = runningJob(id);
  const report = await w.team.tickPass({ dryRun: false });
  assert.deepEqual(w.stopped, [id], `skipped: ${JSON.stringify(report.skipped)}`);
  assert.ok(w.team.s.jobs[id].dependencyStop, 'the stop is marked so ingest counts no attempt');
});

test('a stop that throws marks and refunds nothing, so the next pass looks again', async t => {
  const id = 'c'.repeat(32);
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)], active: [{ id, provider: 'claude', status: 'running' }] });
  w.team.s.jobs[id] = { ...runningJob(id), kind: 'review', pr: 50, key: 'k' };
  w.team.s.reviewAttempts.k = 1;
  w.team.jobs.stop = async () => { throw new Error('terminal job cannot be stopped'); };
  await assert.rejects(enforceStops(w.team, {}), /terminal job/);
  assert.equal(w.team.s.jobs[id].dependencyStop, undefined);
  assert.equal(w.team.s.reviewAttempts.k, 1, 'the attempt is not given back');
  w.team.jobs.stop = async sid => { w.stopped.push(sid); };
  await enforceStops(w.team, {});
  assert.deepEqual(w.stopped, [id]);
  assert.equal(w.team.s.reviewAttempts.k, 0);
});

test('a dependency stop of a secret-scan-only round gives back that round, and an ordinary cifix after one still refunds its attempt', async t => {
  const scan = 'b'.repeat(32), plain = 'a'.repeat(32);
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)], active: [{ id: scan, provider: 'claude', status: 'running' }] });
  w.team.s.jobs[scan] = { ...runningJob(scan), kind: 'cifix', pr: 50, key: 'k', scanOnly: true };
  w.team.s.scanOnlyRounds[50] = 2;
  w.team.s.fixAttempts.k = 1;
  await enforceStops(w.team, {});
  assert.equal(w.team.s.scanOnlyRounds[50], 1);
  assert.equal(w.team.s.fixAttempts.k, 1, 'a scan-only round never charged a fix attempt');
  const w2 = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)], active: [{ id: plain, provider: 'claude', status: 'running' }] });
  w2.team.s.jobs[plain] = { ...runningJob(plain), kind: 'cifix', pr: 50, key: 'k' };
  w2.team.s.scanOnlyRounds[50] = 2;
  w2.team.s.fixAttempts.k = 1;
  await enforceStops(w2.team, {});
  assert.equal(w2.team.s.fixAttempts.k, 0, 'an ordinary cifix is refunded even after an earlier scan-only round');
  assert.equal(w2.team.s.scanOnlyRounds[50], 2);
});
