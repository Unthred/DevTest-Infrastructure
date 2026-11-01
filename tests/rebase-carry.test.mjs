// Issue #79: fewer rebase/re-review cycles. Rebase only on a conflict or right before merge; carry a PASS across a rebase whose
// commits are all unchanged; hold reviews for a reviewer at its usage limit or in waiting mode. Fake GitHub, jobs and git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team, rebasePrompt } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { rangeEqual } from '../supervisor/rangediff.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green, ...extra });

function world(t, { pulls, out = {}, equal = true, modes = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], created: [], range: [] };
  const gh = { pulls, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async (n, b) => calls.comments.push([n, b]), hasComment: async (n, m) => calls.comments.some(([x, b]) => x === n && b.includes(m)) };
  const jobs = { states: {}, listActive: async () => [], get: async id => jobs.states[id] || null, create: async spec => { calls.created.push(spec); return { id: 'a'.repeat(32) }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null, rangeEqual: async a => { calls.range.push(a); if (equal instanceof Error) throw equal; return equal; } };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: '', clock: { now: () => 1000 }, limitedOf: a => (out[a] ? { out: true, reason: out[a] } : { out: false }) });
  if (modes) team.budgets = () => modes;
  return { team, gh, jobs, calls };
}
const PASS = { verdict: 'PASS', reviewer: 'codex', job: 'j1', findings: [], commandsRun: ['x'], at: 1 };
const plan = async (w, agent) => (await w.team.plan()).find(x => x.agent === agent);

test('main moving alone schedules no rebase: a clean, up-to-date-or-merely-moved PR is left alone', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1), { mergeStateStatus: 'BEHIND' }), pr(11, 'codex/issue-2-y', H(2), { mergeStateStatus: 'BEHIND' })] });
  assert.notEqual((await plan(w, 'claude'))?.type, 'rebase');
  assert.notEqual((await plan(w, 'codex'))?.type, 'rebase');
});

test('a conflicting PR is still rebased; a BEHIND PR is rebased only with PASS and green CI (right before merge)', async t => {
  const conflict = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1), { mergeable: 'CONFLICTING', statusCheckRollup: [] })] });
  const c = await plan(conflict, 'claude'); assert.equal(c.type, 'rebase'); assert.equal(c.behind, undefined);
  assert.match(rebasePrompt({ pr: 10, head: H(1), base: 'main', branch: 'b' }), /conflicts with main/);
  const behind = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1), { mergeStateStatus: 'BEHIND' })] });
  behind.team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  const b = await plan(behind, 'claude'); assert.equal(b.type, 'rebase'); assert.equal(b.behind, true);
  assert.match(rebasePrompt({ ...b, branch: 'b' }), /right before merge/); assert.match(rebasePrompt({ ...b, branch: 'b' }), /carries over to the new head only when every commit is unchanged/);
  // negative: BEHIND with a CHANGES verdict, or red CI, is not rebased
  const changes = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1), { mergeStateStatus: 'BEHIND' })] });
  changes.team.s.verdicts[`10:${H(1)}`] = { ...PASS, verdict: 'CHANGES' };
  assert.notEqual((await plan(changes, 'claude'))?.type, 'rebase');
  const red = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1), { mergeStateStatus: 'BEHIND', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })] });
  red.team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  assert.equal((await plan(red, 'claude'))?.type, 'cifix');   // red CI on the merged result is the CI-fix path
});

async function rebased(t, equal) {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(2))], equal });
  w.team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  w.team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  w.jobs.states.r1 = { status: 'completed' };
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report);
  return { w, report };
}

test('a rebase with every commit equal carries the PASS to the new head, publicly, once; the merge gate then accepts it', async t => {
  const { w, report } = await rebased(t, true);
  assert.deepEqual(w.calls.range, [{ base: 'origin/main', oldHead: H(1), newHead: H(2) }]);
  const v = w.team.s.verdicts[`10:${H(2)}`];
  assert.equal(v.verdict, 'PASS'); assert.equal(v.carriedFrom, H(1)); assert.equal(v.reviewer, 'codex');
  assert.equal(w.calls.comments.length, 1); assert.match(w.calls.comments[0][1], /Verdict carried/); assert.deepEqual(report.carried, [{ pr: 10, head: H(2), carried: true }]);
  assert.equal((await w.team.plan()).find(a => a.type === 'merge')?.head, H(2));
  await w.team.ingest({ ingested: [], skipped: [] });   // a second pass posts and records nothing more
  assert.equal(w.calls.comments.length, 1);
});

test('a rebase whose patch changed, whose comparison failed or errored carries nothing and is re-reviewed', async t => {
  for (const equal of [false, new Error("boom"), null]) {
    const { w, report } = await rebased(t, equal);
    assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined); assert.equal(w.calls.comments.length, 0);
    assert.deepEqual(report.carried, [{ pr: 10, head: H(2), carried: false }]);
    assert.equal((await w.team.plan()).find(a => a.agent === 'codex')?.type, 'review');
  }
});

test('a CHANGES verdict, a head that did not change, or an incomplete rebase job never carries', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(2))], equal: true });
  w.team.s.verdicts[`10:${H(1)}`] = { ...PASS, verdict: 'CHANGES' };
  w.team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  w.jobs.states.r1 = { status: 'completed' };
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined);
  const same = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], equal: true });
  same.team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  same.team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  same.jobs.states.r1 = { status: 'completed' };
  await same.team.ingest({ ingested: [], skipped: [] });
  assert.equal(same.calls.range.length, 0);
  const failed = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(2))], equal: true });
  failed.team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  failed.team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  failed.jobs.states.r1 = { status: 'failed' };
  await failed.team.ingest({ ingested: [], skipped: [] });
  assert.equal(failed.team.s.verdicts[`10:${H(2)}`], undefined);
});

test('no review is scheduled for a reviewer at its usage limit; the hold and its reason are recorded', async t => {
  const pulls = [pr(10, 'claude/issue-5-x', H(1))];
  const limited = world(t, { pulls, out: { codex: 'codex reports a used-up five_hour window' } });
  assert.equal(await plan(limited, 'codex'), undefined);
  assert.match(limited.team.held.codex.review, /review held: codex is out of allowance \(codex reports a used-up five_hour window\)/);
  const fine = world(t, { pulls });
  assert.equal((await plan(fine, 'codex')).type, 'review');
  assert.equal(fine.team.held.codex?.review, undefined);
});

test('no review is scheduled for a reviewer in waiting mode, and the reason is recorded', async t => {
  const waiting = { mode: 'waiting', reason: 'weekly window used up, resets Wed', known: true, used: 1, costs: { cost: () => null } };
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], modes: { codex: waiting, claude: { mode: 'normal', known: false, costs: { cost: () => null } } } });
  assert.equal(await plan(w, 'codex'), undefined);
  assert.match(w.team.held.codex.review, /resets Wed/);
});

test('real git: rangeEqual is true for a clean rebase and false once a patch changes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'a'), '1\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat'); fs.writeFileSync(path.join(dir, 'f'), 'f\n'); g('add', '.'); g('commit', '-qm', 'feature');
  const old = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'b'), '2\n'); g('add', '.'); g('commit', '-qm', 'main moves');
  g('checkout', '-q', 'feat'); g('rebase', '-q', 'main'); const clean = g('rev-parse', 'HEAD');
  fs.appendFileSync(path.join(dir, 'f'), 'more\n'); g('commit', '-qam', 'feature'); const changed = g('rev-parse', 'HEAD');
  assert.notEqual(old, clean);
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: clean }), true);
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: changed }), false);
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: old }), true);
  assert.throws(() => rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: 'f'.repeat(40) }));
});

test('real git: rangeEqual refuses a range holding a merge commit, even an evil merge that reverts a main fix', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'vulnerable\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat'); fs.writeFileSync(path.join(dir, 'f'), 'f\n'); g('add', '.'); g('commit', '-qm', 'feature');
  g('checkout', '-q', 'main'); fs.writeFileSync(path.join(dir, 'a.txt'), 'fixed\n'); g('commit', '-qam', 'security fix');
  g('checkout', '-q', 'feat'); g('merge', '-q', '--no-ff', '-m', 'Merge main', 'main'); const clean = g('rev-parse', 'HEAD');
  g('reset', '-q', '--hard', 'HEAD~1'); g('merge', '-q', '--no-ff', '--no-commit', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'vulnerable\n'); g('add', '.'); g('commit', '-qm', 'Merge main'); const evil = g('rev-parse', 'HEAD');
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: clean, newHead: evil }), false);
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: clean, newHead: clean }), false);
});
