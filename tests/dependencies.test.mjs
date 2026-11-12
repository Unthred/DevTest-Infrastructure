import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STATE_TEXT } from '../supervisor/dependencies.mjs';
import { STATE_TEXT as MCP_TEXT } from '../foreman-mcp/dependencyview.mjs';
import { parseDependsOn, prerequisiteState, findCycles, evaluateDependencies } from '../supervisor/dependencies.mjs';
import { dependencyView, dependencySkips } from '../foreman-mcp/dependencyview.mjs';
import { dependencyPlain, dependencyAttention, enforceDependencies } from '../supervisor/teamdeps.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const sha = c => c.repeat(40);
const INSTALLED = sha('a'), MERGED_IN = sha('b'), MERGED_LATER = sha('c');
const ancestor = (a, b) => a === MERGED_IN && b === INSTALLED;

test('parseDependsOn: one canonical line, nothing else is guessed', () => {
  assert.deepEqual(parseDependsOn('x\nDepends on: #12, #15\ny').numbers, [12, 15]);
  assert.deepEqual(parseDependsOn('**Depends on:** #3').numbers, [3]);
  assert.deepEqual(parseDependsOn('no line, but Prerequisites: #4 and Depends on #5 in prose'), { numbers: [], malformed: null, line: null });
  assert.deepEqual(parseDependsOn('```\nDepends on: #7\n```').numbers, [], 'inside code');
  for (const bad of ['Depends on: soon', 'Depends on: #1 and #2', 'Depends on:', 'Depends on: #1\nDepends on: #2', 'Depends on: PR 3']) {
    assert.ok(parseDependsOn(bad).malformed, `malformed: ${bad}`);
    assert.deepEqual(parseDependsOn(bad).numbers, []);
  }
  assert.match(parseDependsOn('Depends on: #9', 9).malformed, /itself/);
});

test('prerequisiteState covers open, merged not installed, installed, closed not planned and unknown', () => {
  const env = { installedSha: INSTALLED, isAncestor: ancestor };
  assert.equal(prerequisiteState({ issue: { state: 'OPEN' }, ...env }), 'open');
  assert.equal(prerequisiteState({ pr: { state: 'OPEN' }, ...env }), 'open');
  assert.equal(prerequisiteState({ issue: { state: 'CLOSED', stateReason: 'COMPLETED' }, pr: { state: 'MERGED', mergeSha: MERGED_LATER }, ...env }), 'merged_not_installed');
  assert.equal(prerequisiteState({ issue: { state: 'CLOSED', stateReason: 'COMPLETED' }, pr: { state: 'MERGED', mergeSha: MERGED_IN }, ...env }), 'installed');
  assert.equal(prerequisiteState({ pr: { state: 'MERGED', mergeSha: INSTALLED }, ...env }), 'installed', 'the installed commit itself');
  assert.equal(prerequisiteState({ issue: { state: 'CLOSED', stateReason: 'NOT_PLANNED' }, ...env }), 'closed_not_planned');
  assert.equal(prerequisiteState({ issue: { state: 'CLOSED', stateReason: 'NOT_PLANNED' }, pr: { state: 'MERGED', mergeSha: MERGED_IN }, ...env }), 'closed_not_planned');
  assert.equal(prerequisiteState({ ...env }), 'unknown', 'failed lookup');
  assert.equal(prerequisiteState({ issue: { state: 'CLOSED', stateReason: 'COMPLETED' }, ...env }), 'unknown', 'closed with no merged PR is not proof');
  assert.equal(prerequisiteState({ pr: { state: 'MERGED', mergeSha: null }, ...env }), 'unknown', 'no merge commit');
  assert.equal(prerequisiteState({ pr: { state: 'MERGED', mergeSha: MERGED_IN }, installedSha: null, isAncestor: ancestor }), 'unknown', 'nothing installed');
  assert.equal(prerequisiteState({ pr: { state: 'MERGED', mergeSha: MERGED_IN }, installedSha: INSTALLED, isAncestor: () => { throw new Error('git'); } }), 'unknown', 'git failure is unknown, not met');
});

test('findCycles lists each loop once and ignores chains', () => {
  assert.deepEqual(findCycles(new Map([[1, [2]], [2, [3]], [3, [1]], [4, [1]], [5, []]])), [[1, 2, 3]]);
  assert.deepEqual(findCycles(new Map([[1, [2]], [2, []]])), []);
});

test('evaluateDependencies: a cycle blocks every member, a met chain does not', () => {
  const issues = [{ number: 1, body: 'Depends on: #2' }, { number: 2, body: 'Depends on: #1' }, { number: 3, body: '' }, { number: 4, body: 'Depends on: #3' }];
  const lookup = d => (d === 3 ? { issue: { state: 'CLOSED', stateReason: 'COMPLETED' }, pr: { state: 'MERGED', mergeSha: MERGED_IN } } : { issue: { state: 'OPEN' } });
  const { byIssue, cycles } = evaluateDependencies({ issues, lookup, installedSha: INSTALLED, isAncestor: ancestor });
  assert.deepEqual(cycles, [[1, 2]]);
  assert.equal(byIssue.get(1).met, false);
  assert.match(byIssue.get(2).reasons.join(), /cycle/);
  assert.equal(byIssue.get(3).met, true, 'no line, no prerequisites');
  assert.equal(byIssue.get(4).met, true);
});

const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const issue = (n, body = '', state = 'OPEN', stateReason = null) => ({ number: n, title: `Issue ${n}`, state, stateReason, body, labels: [] });
const merged = (n, issueNo, oid) => ({ number: n, title: `PR ${n}`, headRefName: `claude/issue-${issueNo}-x`, mergedAt: '2026-11-07T00:00:00Z', closingIssuesReferences: [{ number: issueNo }], mergeCommit: { oid } });
function world(t, { issues, mergedPulls = [], pulls = [], active = [], installed = INSTALLED } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'deps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stopped = [];
  const gh = { listPulls: async () => pulls, listIssues: async () => issues, listMergedPulls: async () => mergedPulls, getIssue: async n => issues.find(i => i.number === n) || null };
  const jobs = { listActive: async () => active, get: async () => null, stop: async id => { stopped.push(id); }, create: async () => ({ id: 'a'.repeat(32) }) };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: {}, register: REGISTER, clock: { now: () => 1000 } });
  team.depEnv = { installedSha: () => installed, isAncestor: ancestor };
  return { team, stopped };
}
const started = plan => plan.filter(a => a.type === 'implement').map(a => a.issue).sort((a, b) => a - b);

test('an issue starts only when its prerequisite is installed; each unmet state holds it', async t => {
  const cases = [
    ['open', [issue(5, 'Depends on: #20'), issue(20)], [], false],
    ['merged, not installed', [issue(5, 'Depends on: #20'), issue(20, '', 'CLOSED', 'COMPLETED')], [merged(90, 20, MERGED_LATER)], false],
    ['installed', [issue(5, 'Depends on: #20'), issue(20, '', 'CLOSED', 'COMPLETED')], [merged(90, 20, MERGED_IN)], true],
    ['closed as not planned', [issue(5, 'Depends on: #20'), issue(20, '', 'CLOSED', 'NOT_PLANNED')], [], false],
    ['unknown', [issue(5, 'Depends on: #77')], [], false],
    ['malformed line', [issue(5, 'Depends on: soon')], [], false],
    ['no line', [issue(5, 'nothing')], [], true]
  ];
  for (const [name, issues, mergedPulls, starts] of cases) {
    const { team } = world(t, { issues, mergedPulls });
    assert.deepEqual(started(await team.plan()), starts ? [5] : issues.some(i => i.number === 20 && i.state === 'OPEN') ? [20] : [], name);
  }
});

test('a dependency cycle starts none of its members and raises one Needs you item', async t => {
  const issues = [issue(1, 'Depends on: #2'), issue(2, 'Depends on: #1'), issue(3)];
  const { team } = world(t, { issues });
  assert.deepEqual(started(await team.plan()), [3]);
  const items = dependencyAttention({ dependencies: dependencyPlain(team.dependencies) });
  assert.equal(items.filter(i => i.id.startsWith('dependency-cycle')).length, 1);
  assert.match(items[0].text, /#1 -> #2/);
});

test('Needs you: a malformed line and a prerequisite closed as not planned each raise one item naming the issue', async t => {
  const { team } = world(t, { issues: [issue(5, 'Depends on: later'), issue(6, 'Depends on: #20'), issue(20, '', 'CLOSED', 'NOT_PLANNED')] });
  await team.plan();
  const ids = dependencyAttention({ dependencies: dependencyPlain(team.dependencies) }).map(i => i.id).sort();
  assert.deepEqual(ids, ['dependency-malformed-5', 'dependency-notplanned-6-20']);
});

test('every lane waits: review, fix, rebase and merge of an issue with an unmet prerequisite are gated', async t => {
  const issues = [issue(5, 'Depends on: #20'), issue(20)];
  const pr = { number: 50, headRefName: 'claude/issue-5-x', headRefOid: sha('d'), baseRefName: 'main' };
  const { team } = world(t, { issues, pulls: [pr] });
  await team.plan();
  for (const type of ['review', 'fix', 'rebase', 'cifix', 'merge', 'continue']) {
    const g = team.gateReason({ type, pr: 50, head: pr.headRefOid });
    assert.equal(g?.kind, 'dependency', type);
    assert.match(g.why, /#20 still open/);
  }
  assert.equal(team.gateReason({ type: 'review', pr: 51, head: sha('e') }), null, 'a PR of another issue is not held');
});

test('the waiting record keeps its start time and clears when the prerequisite is installed', async t => {
  const { team } = world(t, { issues: [issue(5, 'Depends on: #20'), issue(20)] });
  await team.plan();
  assert.equal(team.s.depWait[5].since, 1000);
  team.clock = { now: () => 5000 };
  await team.plan();
  assert.equal(team.s.depWait[5].since, 1000, 'since is the first time it waited');
  team.gh.listIssues = async () => [issue(5, 'Depends on: #20'), issue(20, '', 'CLOSED', 'COMPLETED')];
  team.gh.listMergedPulls = async () => [merged(90, 20, MERGED_IN)];
  await team.plan();
  assert.equal(team.s.depWait[5], undefined);
});

test('the MCP view names dependsOn, blockedBy and unlocks', async t => {
  const { team } = world(t, { issues: [issue(5, 'Depends on: #20, #21'), issue(20), issue(21, '', 'CLOSED', 'COMPLETED')], mergedPulls: [merged(91, 21, MERGED_IN)] });
  await team.plan();
  const plain = dependencyPlain(team.dependencies);
  const v5 = dependencyView(plain, 5);
  assert.deepEqual(v5.dependsOn.map(d => [d.number, d.state]), [[20, 'open'], [21, 'installed']]);
  assert.deepEqual(v5.blockedBy.map(d => d.number), [20]);
  assert.deepEqual(dependencyView(plain, 20).unlocks, [5]);
  assert.equal(dependencyView(plain, 99), null);
  assert.deepEqual(dependencySkips([{ number: 5, kind: 'dependency', reason: 'r' }, { number: 6, kind: 'label', reason: 'x' }]), [{ number: 5, reason: 'r' }]);
});

test('a running job whose issue gains an unmet prerequisite stops cleanly, waits and uses no attempt', async t => {
  const id = 'c'.repeat(32);
  const w = world(t, { issues: [issue(9, 'Depends on: #20'), issue(20)], active: [{ id, provider: 'claude', status: 'running' }] });
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', ingested: false, at: 500 };
  w.team.s.implemented[9] = 500;
  await w.team.plan();
  const report = {};
  await enforceDependencies(w.team, report);
  assert.deepEqual(w.stopped, [id]);
  assert.equal(w.team.s.jobs[id].dependencyStop.reasons[0], '#20 still open');
  await enforceDependencies(w.team, report);
  assert.deepEqual(w.stopped, [id], 'stopped once');
  // the stopped job is ingested: no failure counted, the issue is requeued, and the plan holds it while the prerequisite is open
  w.team.jobs.get = async () => ({ id, status: 'stopped', lastEvent: 'manual_stop' });
  await w.team.ingestOneInner(id, w.team.s.jobs[id], { ingested: [], notified: [] });
  assert.equal(w.team.s.jobs[id].capCounted, undefined, 'no attempt counted');
  assert.deepEqual(w.team.s.sameCause, {});
  assert.equal(w.team.s.implemented[9], undefined, 'requeued');
  assert.deepEqual(started(await w.team.plan()), [20], 'issue 9 waits; issue 20 may start');
});

test('an unknown prerequisite also stops a running job cleanly, with no attempt (rule 4)', async t => {
  const id = 'd'.repeat(32);
  const w = world(t, { issues: [issue(9, 'Depends on: #77')], active: [{ id, provider: 'claude', status: 'running' }] });
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '9', issue: 9, branch: 'claude/issue-9-x', at: 500 };
  await w.team.plan();
  await enforceDependencies(w.team, {});
  assert.deepEqual(w.stopped, [id]);
  assert.equal(w.team.s.jobs[id].dependencyStop.reasons[0], '#77 status unknown');
});

test('any number of references resolves: every one is looked up, none is left unknown by a cap', async t => {
  const refs = Array.from({ length: 45 }, (_, k) => k + 100);
  const { team } = world(t, { issues: [issue(5, `Depends on: ${refs.map(n => `#${n}`).join(', ')}`)] });
  const asked = [];
  team.gh.getIssue = async n => { asked.push(n); return issue(n); };
  await team.plan();
  assert.deepEqual(asked.sort((a, b) => a - b), refs);
  assert.ok(team.dependencies.byIssue.get(5).dependsOn.every(d => d.state === 'open'));
});

test('a prerequisite merged long ago, outside the cached merged list, is found through its closing pull request', async t => {
  const old = { ...issue(20, '', 'CLOSED', 'COMPLETED'), closedByPullRequestsReferences: [{ number: 90 }] };
  const { team } = world(t, { issues: [issue(5, 'Depends on: #20')] });
  team.gh.getIssue = async () => old;
  team.gh.getPull = async n => ({ number: n, state: 'MERGED', headRefName: 'claude/issue-20-x', mergeCommit: { oid: MERGED_IN }, closingIssuesReferences: [{ number: 20 }] });
  assert.deepEqual(started(await team.plan()), [5]);
  assert.equal(team.dependencies.byIssue.get(5).dependsOn[0].state, 'installed');
});

test('the supervisor and the MCP server say the same words for each state', () => {
  assert.deepEqual(STATE_TEXT, MCP_TEXT);
});

test('parseDependsOn: a Depends on declaration inside a sentence is held, not read as no prerequisites (issue #1182)', () => {
  for (const body of ['V2 item 27. Batch 1. Depends on: #1156\nSlice 2 of 3', 'V2 item 30. Depends on: #1156 (decision table and card controls).']) {
    const p = parseDependsOn(body, 1157);
    assert.match(p.malformed, /own line/, body);
    assert.deepEqual(p.numbers, []);
  }
  assert.equal(parseDependsOn('Batch 1. Depends on: none. Slices 2 and 3 depend on this one.').malformed, null, 'no number named');
  assert.equal(parseDependsOn('see `Batch 1. Depends on: #5` in code').malformed, null, 'inside code');
  assert.equal(parseDependsOn("Batch 1. Depends on: #9\nDepends on: #3").malformed, null, "a standing line wins");
  assert.deepEqual(parseDependsOn('Batch 1. Depends on: #9\nDepends on: #3').numbers, [3]);
});

test('evaluateDependencies: an inline Depends on holds the issue so no job starts (issue #1182)', () => {
  const r = evaluateDependencies({ issues: [{ number: 1157, body: 'V2 item 27. Depends on: #1156' }], lookup: () => ({}), installedSha: INSTALLED, isAncestor: ancestor });
  assert.equal(r.byIssue.get(1157).met, false);
  assert.match(r.byIssue.get(1157).reasons[0], /own line/);
});
