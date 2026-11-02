// Issue #266: a backlog of conflicting PRs must not starve a queued implement job. Fake GitHub, fake jobs, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [258, 259] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'CONFLICTING', statusCheckRollup: green, ...extra });
const issue = n => ({ number: n, title: `Issue ${n} title`, state: 'OPEN', body: '', labels: [] });

function world(t, pulls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'starve-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { pulls, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [issue(258), issue(259)], listMergedPulls: async () => [],
    comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'x'.repeat(32) }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const manifest = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'high'] } };
  return new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 1_800_000_000_000 }, providerModels: manifest });
}
const backlog = () => [pr(301, H(1)), pr(302, H(2)), pr(303, H(3))];

test('a backlog of conflicting PRs: only the PR next to merge is rebased, never several', async t => {
  const team = world(t, backlog());
  const acts = await team.plan();
  const rebases = acts.filter(a => a.type === 'rebase');
  assert.deepEqual(rebases.map(a => a.pr), [301]);
});

test('after a rebase job, a queued implement job gets the implementer slot instead of the next rebase', async t => {
  const team = world(t, backlog());
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 301, key: `301:${H(1)}`, ingested: true, at: 100 };
  const acts = await team.plan();
  assert.deepEqual(acts.map(a => [a.type, a.issue ?? a.pr]), [['implement', 258]]);
});

test('after the implement job, rebasing resumes (alternation, not a permanent block)', async t => {
  const team = world(t, backlog());
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 301, key: 'k', ingested: true, at: 100 };
  team.s.jobs.i1 = { kind: 'implement', agent: 'claude', issue: 258, key: '258', ingested: true, at: 200 };
  team.s.implemented[258] = 1;
  const acts = await team.plan();
  assert.deepEqual(acts.map(a => [a.type, a.pr]), [['rebase', 301]]);
});

test('negative: with no implement job startable, rebases are not held back after a rebase', async t => {
  const team = world(t, backlog());
  team.s.implemented[258] = 1; team.s.implemented[259] = 1;
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 301, key: 'k', ingested: true, at: 100 };
  assert.deepEqual((await team.plan()).map(a => [a.type, a.pr]), [['rebase', 301]]);
});

test('negative: a next-to-merge PR that exhausted its rebase attempts does not block the next one', async t => {
  const team = world(t, backlog());
  team.s.rebaseAttempts[`301:${H(1)}`] = 2;
  assert.deepEqual((await team.plan()).filter(a => a.type === 'rebase').map(a => a.pr), [302]);
});

// ---- multi-agent, unusable worktree and budget cases (review round on PR #268)
const twoConfig = () => { const c = config(); c.models.agents.codex = { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } };
  c.agents.codex = { provider: 'codex', branch_prefix: 'codex/', issues: [] }; return c; };
function world2(t, pulls) {
  const team = world(t, pulls); team.c = twoConfig(); return team;
}
const cpr = (n, head, extra = {}) => pr(n, head, { headRefName: `codex/issue-${n}-x`, ...extra });
const costs = { cost: type => ({ implement: 0.10, review: 0.05, rebase: 0.01 })[type] ?? 0.01 };
const mode = (m, used = 0.1) => ({ mode: m, reason: 'test', known: true, used, costs });

test('a lowest-numbered PR whose author is waiting does not hold another agent\'s rebase', async t => {
  const team = world2(t, [cpr(300, H(3)), pr(301, H(1))]);
  team.s.implemented[258] = 1; team.s.implemented[259] = 1;
  team.budgets = () => ({ claude: mode('normal'), codex: mode('waiting') });
  assert.deepEqual((await team.plan()).filter(a => a.type === 'rebase').map(a => [a.agent, a.pr]), [['claude', 301]]);
});

test('a lowest-numbered PR whose rebase worktree is unusable does not hold the next rebase', async t => {
  const team = world(t, [pr(301, H(1)), pr(302, H(2))]);
  team.s.unusable[`rebase:301:${H(1)}`] = { worktree: '/p/x', at: 1_800_000_000_000 };
  assert.deepEqual((await team.plan()).filter(a => a.type === 'rebase').map(a => a.pr), [302]);
});

test('the rebase is not deferred for an implement job the reserve for owed reviews refuses', async t => {
  const team = world2(t, [pr(301, H(1)), cpr(305, H(5), { mergeable: 'MERGEABLE' })]);
  team.budgets = () => ({ claude: mode('normal', 0.86), codex: mode('normal', 0.1) });
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 300, key: 'k', ingested: true, at: 100 };
  const acts = await team.plan();
  assert.ok(acts.some(a => a.type === 'rebase' && a.pr === 301), JSON.stringify(acts));
});

test('probing for a startable implement job leaves the dashboard hold reasons untouched', async t => {
  const team = world(t, backlog());
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 301, key: 'k', ingested: true, at: 100 };
  team.budgets = () => ({ claude: mode('normal', 0.1) });
  await team.plan();
  assert.equal(team.held.claude?.implement, undefined);
});

// ---- issue #326: a deferred PR is skipped, never ends the search; idle Needs you item
test('#326 conflicting PRs listed newest first: the lowest number is rebased', async t => {
  const team = world(t, backlog().reverse());
  assert.deepEqual((await team.plan()).filter(a => a.type === 'rebase').map(a => a.pr), [301]);
});
test('#326 conflicting PRs listed oldest first: the lowest number is rebased', async t => {
  const team = world(t, backlog());
  assert.deepEqual((await team.plan()).filter(a => a.type === 'rebase').map(a => a.pr), [301]);
});
test('#326 a single conflicting PR is rebased', async t => {
  const team = world(t, [pr(305, H(5))]);
  assert.deepEqual((await team.plan()).filter(a => a.type === 'rebase').map(a => a.pr), [305]);
});
test('#326 negative: newest first, after a rebase with an implement job startable, the implement job still takes the slot', async t => {
  const team = world(t, backlog().reverse());
  team.s.jobs.r1 = { kind: 'rebase', agent: 'claude', pr: 301, key: 'k', ingested: true, at: 100 };
  assert.deepEqual((await team.plan()).map(a => [a.type, a.issue ?? a.pr]), [['implement', 258]]);
});
test('#326 negative: newest first, an exhausted lowest PR is skipped for the next lowest', async t => {
  const team = world(t, backlog().reverse());
  team.s.rebaseAttempts[`301:${H(1)}`] = 2;
  assert.deepEqual((await team.plan()).filter(a => a.type === 'rebase').map(a => a.pr), [302]);
});

test('#326 idle Needs you item: appears after idle_minutes with the work and reason, clears when a job starts', async t => {
  let now = 1_800_000_000_000;
  const team = world(t, [pr(301, H(1))]); team.clock = { now: () => now };
  team.s.rebaseAttempts[`301:${H(1)}`] = 2;      // nothing can be planned for it
  team.s.implemented[258] = 1; team.s.implemented[259] = 1;
  team.s.rebaseAttempts[`301:${H(1)}`] = 0;
  team.modes = {}; team.gh.listPulls = async () => team.gh.pulls;
  // nothing can be planned for it
  const realChoose = team.choose.bind(team); team.choose = () => null;
  let acts = await team.plan(); assert.deepEqual(acts, []);
  await team.trackIdle(acts);
  assert.ok(team.s.idle); assert.equal(team.idleItem(now), null, 'not yet');
  now += 29 * 60000; assert.equal(team.idleItem(now), null);
  now += 2 * 60000; const item = team.idleItem(now);
  assert.ok(item && item.minutes >= 30 && /#301 conflicts/.test(item.work.join()) && item.reason);
  // a job starts: cleared
  team.choose = realChoose;
  acts = await team.plan(); assert.equal(acts[0].type, 'rebase');
  await team.trackIdle(acts);
  assert.equal(team.s.idle, undefined); assert.equal(team.idleItem(now), null);
});
test('#326 negative: no queued work means no idle item; idle_minutes is configurable and validated', async t => {
  const team = world(t, []); team.s.implemented[258] = 1; team.s.implemented[259] = 1;
  await team.plan(); await team.trackIdle([]);
  assert.equal(team.s.idle, undefined);
  const { validateTeamConfig } = await import('../supervisor/team.mjs');
  const c = config(); c.limits.idle_minutes = 5; validateTeamConfig(c);
  c.limits.idle_minutes = 0; assert.throws(() => validateTeamConfig(c), /idle_minutes/);
});
