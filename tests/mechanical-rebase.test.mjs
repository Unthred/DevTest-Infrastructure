// Issue #1050: a branch that is only behind its base and merges cleanly is rebased by git itself (no agent). Fake GitHub, jobs and git.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import * as robust from '../supervisor/robust.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', statusCheckRollup: green, ...extra });
const PASS = { verdict: 'PASS', reviewer: 'codex', job: 'j1', findings: [], commandsRun: ['x'], at: 1 };
const D25 = '## D-025 — carry\n- Status: homeowner-approved\n';

function world(t, { pulls, conflicts = false, mech, register = D25, equal = true }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], created: [], mech: [] };
  const gh = { pulls, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async (n, b) => calls.comments.push([n, b]), hasComment: async (n, m) => calls.comments.some(([x, b]) => x === n && b.includes(m)), addLabel: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null, create: async spec => { calls.created.push(spec); return { id: 'a'.repeat(32) }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null, mergeProbe: async () => ({ conflicts }), checkRebase: async () => ({ commits: [], missing: [], resolvedConflicts: false }),
    rangeEqual: async () => equal,
    ...(mech ? { mechanicalRebase: async a => { calls.mech.push(a); return mech(a, gh); } } : {}) };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register, clock: { now: () => 1000 }, limitedOf: () => ({ out: false }) });
  return { team, gh, calls };
}
const act = { type: 'rebase', pr: 10, head: H(1), base: 'main', branch: 'claude/issue-5-x', key: `10:${H(1)}`, agent: 'claude', behind: true };
const movesHead = (a, gh) => { gh.pulls[0] = { ...gh.pulls[0], headRefOid: H(2), mergeStateStatus: 'CLEAN' }; return { ok: true, newHead: H(2) }; };

test('rebaseNeeded marks only a clean, only-behind branch as mechanical', () => {
  const ok = { mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' };
  assert.equal(robust.rebaseNeeded({ probe: { conflicts: false }, pull: ok }).mechanical, true);
  assert.equal(robust.rebaseNeeded({ probe: { conflicts: true }, pull: ok }).mechanical, undefined);
  assert.equal(robust.rebaseNeeded({ probe: { conflicts: false }, pull: { ...ok, mergeable: 'CONFLICTING' } }).mechanical, undefined);
  assert.equal(robust.rebaseNeeded({ probe: null, pull: ok }).mechanical, undefined);
});

test('behind and clean: git rebases it, no agent job starts, the record has agent none, model none, tokens 0, resolvedConflicts false; a PASS carries (D-025)', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], mech: movesHead });
  w.team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  const report = {}; await w.team.execute(act, report);
  assert.deepEqual(w.calls.mech, [{ branch: 'claude/issue-5-x', base: 'main', head: H(1) }]);
  assert.equal(w.calls.created.length, 0, 'no agent job');
  assert.equal(w.team.s.rebaseAttempts[act.key] || 0, 0);
  const [id, j] = Object.entries(w.team.s.jobs)[0];
  assert.match(id, /^mech-/);
  assert.equal(j.kind, 'rebase'); assert.equal(j.agent, 'none'); assert.equal(j.model, 'none'); assert.equal(j.tokens, 0); assert.equal(j.rebase.resolvedConflicts, false);
  const v = w.team.s.verdicts[`10:${H(2)}`];
  assert.equal(v.verdict, 'PASS'); assert.equal(v.carriedFrom, H(1)); assert.equal(v.carry.evidence.resolvedConflicts, false);
  assert.equal(report.mechanicalRebases.length, 1);
  // writer evidence: the mechanical rebase is not a model writer
  assert.deepEqual(w.team.writersOf({ number: 10, headRefName: 'claude/issue-5-x', headRefOid: H(2) }).filter(x => x.model === 'none'), []);
});

test('a PASS does not carry when D-025 is not approved, or when the patch changed', async t => {
  const a = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], mech: movesHead, register: '' });
  a.team.s.verdicts[`10:${H(1)}`] = { ...PASS }; await a.team.execute(act, {});
  assert.equal(a.team.s.verdicts[`10:${H(2)}`], undefined);
  const b = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], mech: movesHead, equal: false });
  b.team.s.verdicts[`10:${H(1)}`] = { ...PASS }; await b.team.execute(act, {});
  assert.equal(b.team.s.verdicts[`10:${H(2)}`], undefined);
});

test('carry waits while GitHub still shows the old head, then completes on a retry', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], mech: () => ({ ok: true, newHead: H(2) }) });
  w.team.s.verdicts[`10:${H(1)}`] = { ...PASS };
  await w.team.execute(act, {});
  const j = Object.values(w.team.s.jobs)[0];
  assert.equal(j.carry.state, 'pending'); assert.equal(w.team.s.verdicts[`10:${H(2)}`], undefined);
  w.gh.pulls[0] = { ...w.gh.pulls[0], headRefOid: H(2), mergeStateStatus: 'CLEAN' };
  await w.team.retryCarries({}); assert.equal(w.team.s.verdicts[`10:${H(2)}`].verdict, 'PASS');
});

test('a real conflict takes the agent path; git is never asked', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], conflicts: true, mech: movesHead });
  await w.team.execute(act, {});
  assert.equal(w.calls.mech.length, 0); assert.equal(w.calls.created.length, 1); assert.equal(w.calls.created[0].kind, 'rebase');
});

test('a failed mechanical rebase or red checks fall back to one agent rebase job, and it is not retried mechanically', async t => {
  for (const stage of ['rebase', 'checks', 'push']) {
    const w = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], mech: () => ({ ok: false, stage, detail: 'x' }) });
    await w.team.execute(act, {});
    assert.equal(w.calls.created.length, 1, stage); assert.equal(w.calls.created[0].kind, 'rebase');
    assert.equal(w.team.s.mechanicalFailed[act.key].stage, stage);
    assert.equal(Object.keys(w.team.s.jobs).filter(k => k.startsWith('mech-')).length, 0);
  }
  const thrown = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))], mech: () => { throw new Error('boom'); } });
  await thrown.team.execute(act, {}); assert.equal(thrown.calls.created.length, 1);
  const none = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))] });   // no mechanical capability: unchanged behaviour
  await none.team.execute(act, {}); assert.equal(none.calls.created.length, 1);
});

test('a PR waiting in the queue behind another is not planned for a rebase until its review is next', async t => {
  const ahead = pr(301, 'claude/issue-5-a', H(3), { mergeStateStatus: 'CLEAN' });
  const waiting = pr(302, 'claude/issue-6-b', H(4), { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: [] });
  const w = world(t, { pulls: [waiting, ahead] }); w.team.otherReviewers = () => ['codex'];
  assert.deepEqual((await w.team.plan()).filter(a => a.type === 'rebase').map(a => a.pr), []);
  const only = world(t, { pulls: [waiting] });
  assert.deepEqual((await only.team.plan()).filter(a => a.type === 'rebase').map(a => a.pr), [302]);
  // behind without a PASS is never planned
  const behind = world(t, { pulls: [pr(10, 'claude/issue-5-x', H(1))] });
  assert.deepEqual((await behind.team.plan()).filter(a => a.type === 'rebase'), []);
});
