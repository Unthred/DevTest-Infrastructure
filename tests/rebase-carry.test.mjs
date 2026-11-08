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
import { rangeEqual, normalisePatch } from '../supervisor/rangediff.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green, ...extra });

const APPROVED_D25 = '## D-025 — carry\n- Status: homeowner-approved\n';
function world(t, { pulls, out = {}, equal = true, modes = null, resolved = false, register: o_register = APPROVED_D25 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], created: [], range: [] };
  const gh = { pulls, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async (n, b) => calls.comments.push([n, b]), hasComment: async (n, m) => calls.comments.some(([x, b]) => x === n && b.includes(m)) };
  const jobs = { states: {}, listActive: async () => [], get: async id => jobs.states[id] || null, create: async spec => { calls.created.push(spec); return { id: 'a'.repeat(32) }; } };
  const git = { checkRebase: async a => ({ commits: [], missing: [], ...(resolved === 'unknown' ? {} : { resolvedConflicts: resolved }) }), ensureWorktree: async o => o.path, worktreeFor: async () => null, rangeEqual: async a => { calls.range.push(a); if (equal instanceof Error) throw equal; return equal; } };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: o_register, clock: { now: () => 1000 }, limitedOf: a => (out[a] ? { out: true, reason: out[a] } : { out: false }) });
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

async function rebased(t, equal, o = {}) {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(2), o.pr)], equal, resolved: o.resolved ?? false });
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
  assert.equal(v.carry.oldHead, H(1)); assert.equal(v.carry.newHead, H(2)); assert.deepEqual(v.carry.evidence, { resolvedConflicts: false, patchUnchanged: true, ci: 'green' });
  assert.equal((await w.team.plan()).find(a => a.type === 'merge')?.head, H(2));
  await w.team.ingest({ ingested: [], skipped: [] });   // a second pass posts and records nothing more
  assert.equal(w.calls.comments.length, 1);
});

test('a rebase whose patch changed, whose comparison failed or errored carries nothing and is re-reviewed', async t => {
  for (const equal of [false, new Error("boom"), null]) {
    const { w, report } = await rebased(t, equal);
    assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined); assert.equal(w.calls.comments.length, 0);
    assert.deepEqual(report.carried, [{ pr: 10, head: H(2), carried: false, reason: 'the patch changed or could not be compared' }]);
    assert.equal((await w.team.plan()).find(a => a.agent === 'codex')?.type, 'review');
  }
});

test('a head that did not change, or an incomplete rebase job never carries', async t => {
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

test('real git: rangeEqual refuses a rebase that changes only whitespace (indentation is behaviour in Python), but carries one that only shifts lines', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } }).trim();
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  const pad = Array.from({ length: 8 }, (_, i) => `x${i} = ${i}\n`).join('');
  w('p.py', `${pad}def get(u):\n    pass\n`); g('add', '.'); g('commit', '-qm', 'base');
  const guarded = 'def get(u):\n    if not u.admin:\n        raise PermissionError()\n    return secret()\n';
  g('checkout', '-qb', 'feat'); w('p.py', pad + guarded); g('commit', '-qam', 'feature'); const old = g('rev-parse', 'HEAD');
  // main moves in the same file, well above the change, so only the hunk line numbers shift in a clean rebase
  g('checkout', '-q', 'main'); w('p.py', `# header\n\n${pad}def get(u):\n    pass\n`); g('commit', '-qam', 'main moves');
  g('checkout', '-q', 'feat'); g('rebase', '-q', 'main'); const clean = g('rev-parse', 'HEAD');
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: clean }), true);
  const variant = body => { g('checkout', '-q', '--detach', 'main'); w('p.py', `# header\n\n${pad}${body}`); g('commit', '-qam', 'feature'); return g('rev-parse', 'HEAD'); };
  // same message, but `return secret()` is now inside the raise branch: patch-id treats it as identical
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: variant(guarded.replace('    return', '        return')) }), false);
  // a trailing-space-only change does not carry either
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: variant(guarded.replace('secret()', 'secret() ')) }), false);
});

test('real git: rangeEqual carries nothing when the net change is empty', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'a'), '1\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat'); g('commit', '-q', '--allow-empty', '-m', 'empty'); const old = g('rev-parse', 'HEAD');
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: old }), false);
});

test('real git: rangeEqual carries nothing when main changed the context lines around a patch (git range-diff shows !)', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' } }).trim();
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  w('p.py', 'def get(u):\n    pass\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat'); w('p.py', 'def get(u):\n    return 1\n'); g('commit', '-qam', 'feature'); const old = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main'); w('p.py', '# header\ndef get(u):\n    pass\n'); g('commit', '-qam', 'main moves');
  g('checkout', '-q', 'feat'); g('rebase', '-q', 'main');
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: g('rev-parse', 'HEAD') }), false);
});

test('normalisePatch drops only blob hashes and hunk line numbers, keeping whitespace and function context', () => {
  const p = 'diff --git a/x b/x\nindex 142a295..af6a0ba 100644\n--- a/x\n+++ b/x\n@@ -10,2 +12,3 @@ def f():\n     a\n+    b \n';
  assert.equal(normalisePatch(p), 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ def f():\n     a\n+    b \n');
});

test('issue #290: a resolved conflict, unknown conflict status, red CI or a changed patch never carries; each is re-reviewed', async t => {
  const red = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
  for (const [name, o, eq] of [['resolved conflict', { resolved: true }, true], ['unknown conflict status', { resolved: 'unknown' }, true], ['red CI', { pr: { statusCheckRollup: red } }, true], ['changed patch', {}, false], ['undeterminable comparison', {}, null]]) {
    const { w } = await rebased(t, eq, o);
    assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined, name); assert.equal(w.calls.comments.length, 0, name);
  }
});

test('issue #290: pending CI waits, then carries once CI is green; red CI or a moved head ends the wait', async t => {
  const pending = [{ status: 'IN_PROGRESS', conclusion: null }];
  const { w, report } = await rebased(t, true, { pr: { statusCheckRollup: pending } });
  assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined); assert.equal(w.team.s.jobs.r1.carry.state, 'pending'); assert.equal(report.carried, undefined);
  assert.equal((await w.team.plan()).find(a => a.agent === 'codex' && a.type === 'review'), undefined);   // no review while CI runs
  await w.team.retryCarries({ ingested: [] });
  assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined);
  w.gh.pulls[0].statusCheckRollup = green;
  await w.team.retryCarries({ ingested: [] });
  assert.equal(w.team.s.verdicts[`10:${H(2)}`].verdict, 'PASS'); assert.equal(w.team.s.jobs.r1.carry.state, 'carried');
  const red = await rebased(t, true, { pr: { statusCheckRollup: pending } });
  red.w.gh.pulls[0].statusCheckRollup = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
  await red.w.team.retryCarries({ ingested: [] });
  assert.equal(red.w.team.s.verdicts[`10:${H(2)}`], undefined); assert.equal(red.w.team.s.jobs.r1.carry.state, 'refused');
  const moved = await rebased(t, true, { pr: { statusCheckRollup: pending } });
  moved.w.gh.pulls[0].headRefOid = H(3); moved.w.gh.pulls[0].statusCheckRollup = green;
  await moved.w.team.retryCarries({ ingested: [] });
  assert.equal(moved.w.team.s.verdicts[`10:${H(3)}`], undefined); assert.equal(moved.w.team.s.jobs.r1.carry.state, 'refused');
});

test('issue #290: merge re-verifies the carry record against the current head; a forged or stale record does not merge', async t => {
  const { w } = await rebased(t, true);
  const v = w.team.s.verdicts[`10:${H(2)}`];
  assert.equal((await w.team.plan()).find(a => a.type === 'merge')?.head, H(2));
  for (const bad of [{ ...v, carry: { ...v.carry, newHead: H(3) } }, { ...v, carry: undefined }, { ...v, carry: { ...v.carry, evidence: { ...v.carry.evidence, ci: 'pending' } } }, { ...v, carriedFrom: H(4) }]) {
    w.team.s.verdicts[`10:${H(2)}`] = bad;
    assert.equal((await w.team.plan()).find(a => a.type === 'merge'), undefined);
  }
});

test('issue #290: a second-opinion PASS carries with the primary PASS; one with an invalid record is owed again', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(2))], equal: true });
  w.team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  w.team.s.secondOpinions[`10:${H(1)}`] = { ...PASS, reviewer: 'codex', secondOpinion: true };
  w.team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  w.jobs.states.r1 = { status: 'completed' };
  await w.team.ingest({ ingested: [], skipped: [] });
  const so = w.team.s.secondOpinions[`10:${H(2)}`];
  assert.equal(so.verdict, 'PASS'); assert.equal(so.carry.newHead, H(2)); assert.equal(so.carriedFrom, H(1));
  assert.equal(w.team.carryOk(so, { headRefOid: H(2) }), true); assert.equal(w.team.carryOk(so, { headRefOid: H(3) }), false);
});

// ---- issue #1048: a CHANGES verdict carries across a clean rebase until a fix lands
const CHANGES = { verdict: 'CHANGES', reviewer: 'codex', job: 'j1', findings: [{ kind: 'blocking', text: 'fix the thing' }, { kind: 'follow-up', text: 'tidy' }], commandsRun: ['x'], at: 1 };
async function rebasedChanges(t, equal, o = {}) {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(2), o.pr)], equal, resolved: o.resolved ?? false, register: o.register });
  w.gh.addLabel = async () => {};
  w.team.s.verdicts[`10:${H(1)}`] = { ...CHANGES };
  w.team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 10, head: H(1), base: 'main', ingested: false, at: 1 };
  w.jobs.states.r1 = { status: 'completed' };
  const report = { ingested: [], skipped: [] };
  await w.team.ingest(report);
  return { w, report };
}

test('#1048 CHANGES then a clean rebase carries the verdict and findings, queues no review and stays in the fix lane', async t => {
  const { w, report } = await rebasedChanges(t, true);
  const v = w.team.s.verdicts[`10:${H(2)}`];
  assert.equal(v.verdict, 'CHANGES'); assert.equal(v.carriedFrom, H(1)); assert.deepEqual(v.findings, CHANGES.findings);
  assert.equal(v.carry.oldHead, H(1)); assert.equal(v.carry.newHead, H(2));
  assert.deepEqual(report.carried, [{ pr: 10, head: H(2), carried: true, verdict: 'CHANGES' }]);
  assert.equal(w.calls.comments.length, 1); assert.match(w.calls.comments[0][1], /Verdict carried: CHANGES/);
  const acts = await w.team.plan();
  assert.equal(acts.find(a => a.agent === 'codex')?.type, undefined);   // no review for the reviewer
  assert.equal(acts.find(a => a.agent === 'claude')?.type, 'fix');      // the author is in the fix lane
  await w.team.ingest({ ingested: [], skipped: [] });
  assert.equal(w.calls.comments.length, 1);
});

test('#1048 a carried CHANGES does not wait for CI or approval of D-025, and is not counted as a second CHANGES or a second review round', async t => {
  const { w } = await rebasedChanges(t, true, { pr: { statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] }, register: '' });
  const v = w.team.s.verdicts[`10:${H(2)}`];
  assert.equal(v.verdict, 'CHANGES'); assert.notEqual(v.carry.evidence.ci, 'green');
  assert.equal(w.team.reviewHistory(10).length, 1);
});

test('#1048 CHANGES then a rebase that resolved a conflict, changed the patch or lost changes carries nothing and a review is queued', async t => {
  for (const o of [{ equal: true, resolved: true }, { equal: false }, { equal: new Error('boom') }, { equal: true, resolved: 'unknown' }]) {
    const { w } = await rebasedChanges(t, o.equal, { resolved: o.resolved });
    assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined);
    assert.equal((await w.team.plan()).find(a => a.agent === 'codex')?.type, 'review');
  }
});

test('#1048 CHANGES then a fix commit (not a rebase) queues a fix-round re-review', async t => {
  const { w } = await rebasedChanges(t, true);
  // the author's fix lands: a new head with no verdict is reviewed again
  w.gh.pulls = [pr(10, 'claude/issue-5-x', H(3))];
  const a = (await w.team.plan()).find(x => x.agent === 'codex');
  assert.equal(a?.type, 'review'); assert.equal(a.head, H(3));
});

test('#1048 at the fix limit a carried CHANGES holds the PR (no rebase, no final round, no review) and the homeowner is asked once', async t => {
  const { w } = await rebasedChanges(t, true, { pr: { mergeable: 'CONFLICTING' } });
  w.team.s.fixAttempts[`10:${H(1)}`] = 2;
  assert.equal(w.team.carriedHold({ number: 10, headRefOid: H(2) }), true);
  const acts = await w.team.plan();
  assert.equal(acts.find(a => a.agent === 'claude'), undefined);   // neither rebase nor fix
  assert.equal(acts.find(a => a.agent === 'codex'), undefined);    // no review
  await w.team.notifyFixLimit({}); await w.team.notifyFixLimit({});
  const n = w.calls.comments.filter(c => /fix rounds/.test(c[1]));
  assert.equal(n.length, 1); assert.match(n[0][1], /carried across a rebase/);
  // negative: below the limit the same PR is not held
  w.team.s.fixAttempts[`10:${H(1)}`] = 1;
  assert.equal(w.team.carriedHold({ number: 10, headRefOid: H(2) }), false);
});

test('#1048 a held PR with red CI starts no CI-fix round, is not awaiting a final round, and is offered the three decisions', async t => {
  const red = [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci' }];
  const { w } = await rebasedChanges(t, true, { pr: { statusCheckRollup: red } });
  w.team.s.fixAttempts[`10:${H(1)}`] = 2;
  const p = w.gh.pulls[0];
  assert.equal(w.team.carriedHold(p), true);
  assert.equal(w.team.canEscalate(10, p), false);
  assert.equal(w.team.escalationPending(10, p), false);
  const acts = await w.team.plan();
  assert.equal(acts.find(a => a.agent === 'claude' && a.type === 'cifix'), undefined);
  assert.equal(acts.find(a => a.agent === 'codex'), undefined);
  const alerts = []; w.team.alert = async m => { alerts.push(m); };
  await w.team.notifyFixLimit({});
  const n = w.calls.comments.filter(c => /fix rounds/.test(c[1]));
  assert.equal(n.length, 1);
  assert.match(n[0][1], /named list of the findings to fix, restart it smaller, or close it/);
  assert.doesNotMatch(n[0][1], /wait for another agent/);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /named list of the findings to fix/);
  assert.doesNotMatch(alerts[0], /wait for another agent/);
});
