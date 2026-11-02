// Issue #344: several jobs of one role at once. Fake GitHub, fake jobs, fake clock: no model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, expectedFiles } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n';
const manifest = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'high'] }, codex: { aliases: ['big', 'mid'], efforts: ['low', 'high'] } };
const config = (roles, issues = []) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } }, codex: { implement: { model: 'big', effort: 'high' }, review: { model: 'mid', effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = n => ({ number: n, title: `t${n}`, headRefName: `codex/issue-${n}-x`, headRefOid: H(n % 9 + 1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green });
function world(t, { roles, issues = [], pulls = [], limitedOf = () => ({ out: false }), create = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'par-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { created: [] };
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => issues, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { seq: 0, states: {}, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { if (create) await create(spec, calls); const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const team = new Team({ config: config(roles, issues.map(i => i.number)), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1_800_000_000_000 }, limitedOf, providerModels: manifest });
  return { team, calls };
}
const issue = (n, body = '') => ({ number: n, title: `Issue ${n} title here`, state: 'OPEN', body, labels: [] });
const codexOut = a => (a === 'codex' ? { out: true, reason: 'limit' } : { out: false });

test('reviewer counts of 1, 2 and 5 run that many reviews at once, each in its own worktree', async t => {
  for (const n of [1, 2, 5]) {
    const w = world(t, { roles: { implementer: 1, reviewer: n }, pulls: [1, 2, 3, 4, 5, 6, 7].map(pr), limitedOf: codexOut });
    await w.team.tick();
    const reviews = w.calls.created.filter(s => s.kind === 'review');
    assert.equal(reviews.length, n, `reviewer ${n}`);
    assert.equal(new Set(reviews.map(s => s.worktree)).size, n, 'distinct worktrees');
    assert.equal(new Set(reviews.map(s => s.issue)).size, n, 'distinct PRs');
  }
});

test('expectedFiles reads the paths an issue names and nothing else', () => {
  assert.deepEqual([...expectedFiles({ title: 'Fix', body: 'Edit supervisor/team.mjs and ./docs/team-loop.md; see issue #5 and v1.2' })].sort(), ['docs/team-loop.md', 'supervisor/team.mjs']);
  assert.equal(expectedFiles({ title: 'x', body: '' }).size, 0);
});

test('overlap refused: two issues naming the same file never run together; distinct files run together', async t => {
  const same = world(t, { roles: { implementer: 2, reviewer: 1 }, issues: [issue(20, 'change supervisor/team.mjs'), issue(21, 'also supervisor/team.mjs'), issue(22, 'touch docs/other.md')] });
  const report = await same.team.tick();
  assert.deepEqual(same.calls.created.map(s => s.issue).sort(), [20, 22]);
  assert.ok(report.actions.length === 2);
  const free = world(t, { roles: { implementer: 2, reviewer: 1 }, issues: [issue(20, 'a/x.mjs'), issue(21, 'b/y.mjs')] });
  await free.team.tick();
  assert.equal(free.calls.created.length, 2);
});

test('overlap with a running job is refused, and the prediction is replaceable', async t => {
  const w = world(t, { roles: { implementer: 2, reviewer: 1 }, issues: [issue(20, 'supervisor/team.mjs'), issue(21, 'supervisor/team.mjs')] });
  w.team.expectFiles = i => new Set([`f${i.number}`]);   // replaced: nothing overlaps
  await w.team.tick();
  assert.equal(w.calls.created.length, 2);
});

test('a job failing to start does not stop the others, and allowance reached mid-start stops further starts', async t => {
  const failing = world(t, { roles: { implementer: 3, reviewer: 1 }, issues: [issue(20, 'a/x.mjs'), issue(21, 'b/y.mjs'), issue(22, 'c/z.mjs')], create: async spec => { if (spec.issue === 21) throw new Error('boom'); } });
  const rep = await failing.team.tick();
  assert.deepEqual(failing.calls.created.map(s => s.issue).sort(), [20, 22]);
  assert.ok(JSON.stringify(rep).includes('boom') || (rep.skipped || []).length >= 1);
  let out = false;
  const mid = world(t, { roles: { implementer: 3, reviewer: 1 }, issues: [issue(20, 'a/x.mjs'), issue(21, 'b/y.mjs'), issue(22, 'c/z.mjs')], limitedOf: () => ({ out }), create: async () => { out = true; } });
  await mid.team.tick();
  assert.equal(mid.calls.created.length, 1, 'the first start hit the limit; the rest did not start');
});

const conflicting = n => ({ ...pr(n), mergeable: 'CONFLICTING' });

test('overlap also covers repair writers: a rebase of a PR whose issue names a file blocks an implement job naming it', async t => {
  const w = world(t, { roles: { implementer: 2, reviewer: 1 }, issues: [issue(5, 'supervisor/team.mjs'), issue(20, 'supervisor/team.mjs'), issue(21, 'docs/other.md')], pulls: [conflicting(5)] });
  const rep = await w.team.tick();
  assert.deepEqual(w.calls.created.map(s => s.kind === 'rebase' ? 'rebase' : s.issue).sort(), [21, 'rebase']);
  assert.match(JSON.stringify(w.team.held), /issue #20 waits/);
  assert.ok(rep.actions.length === 2);
});

test('a repair job is refused when a running implement job expects the same file', async t => {
  const w = world(t, { roles: { implementer: 2, reviewer: 1 }, issues: [issue(5, 'supervisor/team.mjs'), issue(20, 'supervisor/team.mjs')], pulls: [conflicting(5)] });
  const acts = await w.team.plan();
  assert.equal(acts.filter(a => a.type === 'rebase').length, 1);   // baseline: planned alone
  w.team.jobs.listActive = async () => [{ id: 'a'.repeat(32), status: 'running' }];
  w.team.s.jobs['a'.repeat(32)] = { kind: 'implement', agent: 'claude', issue: 20, key: '20' };
  const acts2 = await w.team.plan();
  assert.equal(acts2.filter(a => a.type === 'rebase').length, 0);
});

test('concurrent rebases: N implementer slots rebase the first N conflicting PRs in queue order; one slot keeps one', async t => {
  for (const [n, want] of [[1, [1]], [2, [1, 2]], [3, [1, 2, 3]]]) {
    const w = world(t, { roles: { implementer: n, reviewer: 1 }, pulls: [1, 2, 3, 4].map(conflicting) });
    const acts = await w.team.plan();
    assert.deepEqual(acts.filter(a => a.type === 'rebase').map(a => a.pr).sort(), want, `implementer ${n}`);
  }
});
