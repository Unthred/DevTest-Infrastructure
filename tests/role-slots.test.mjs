// Concurrency by role, not by agent (issue #148): one implementer slot and one reviewer slot, filled by whichever agent has allowance.
// Fake GitHub, fake jobs, fake clock: no model call, no network, no real repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, applyLocalOverride, validateTeamConfig, roleOfType } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n';
const limits = (over = {}) => ({ roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...over });
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, interim_review: { enabled: true, decision: 'D-021', weekly_at: 0.95 },
  limits: limits(),
  models: { agents: { claude: { implement: { model: 'opus', effort: 'high' }, review: { model: 'sonnet', effort: 'medium' }, 'interim-review': { model: 'haiku', effort: 'low' } },
    codex: { implement: { model: 'big', effort: 'high' }, review: { model: 'mid', effort: 'medium' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5, 6] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, state = 'OPEN') => ({ number: n, title: `Issue ${n} title here`, state, body: '', labels: [] });
const manifest = { claude: { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: ['big', 'mid'], efforts: ['low', 'medium', 'high'] } };

function world(t, { pulls = [], issues = [issue(5), issue(6), issue(2)], out = {}, cfg = config(), active = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roles-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { created: [] };
  const gh = { pulls, issues, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues, listMergedPulls: async () => [],
    comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { active, states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const limitedOf = agent => (out[agent] ? { out: true, reason: out[agent] } : { out: false });
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 1_800_000_000_000 }, limitedOf, providerModels: manifest });
  return { gh, jobs, team, calls };
}
// Record a running job the way the dispatcher does, so the slot it holds is known.
const running = (w, id, kind, agent, extra = {}) => {
  w.jobs.active.push({ id, provider: w.team.c.agents[agent].provider, status: 'running' });
  w.team.s.jobs[id] = { kind, agent, key: String(extra.issue ?? extra.pr), ingested: false, ...extra };
};
const codexOut = { codex: 'codex weekly limit' };

test('one agent in allowance: an implement job and an interim review run at the same time, each with its role model', async t => {
  const w = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))], out: codexOut });
  const report = await w.team.tick();
  assert.deepEqual(w.calls.created.map(s => [s.provider, s.kind]).sort(), [['claude', 'implement'], ['claude', 'review']]);
  const by = Object.fromEntries(w.calls.created.map(s => [s.kind, s]));
  assert.deepEqual([by.implement.model, by.implement.effort], ['opus', 'high']);
  assert.deepEqual([by.review.model, by.review.effort], ['haiku', 'low']);   // the interim-review entry, never the implement entry
  assert.equal(report.actions.length, 2);
});

test('negative: two implement jobs never run at once with implementer: 1, even from two agents', async t => {
  const w = world(t);   // claude owns #5, #6 and codex owns #2, nothing is out of allowance
  const acts = await w.team.plan();
  assert.equal(acts.filter(a => a.type === 'implement').length, 1);
  assert.equal(acts[0].agent, 'claude');   // team.json order breaks the tie
  // with the slot busy, no further implement job is planned
  const busy = world(t); running(busy, 'a', 'implement', 'claude', { issue: 5 });
  assert.deepEqual(await busy.team.plan(), []);
  // a repair job holds the same slot as an implement job
  const fixing = world(t); running(fixing, 'f', 'fix', 'codex', { pr: 9 });
  assert.deepEqual(await fixing.team.plan(), []);
  // two slots allow two, never the same issue twice
  const two = world(t, { cfg: config({ limits: limits({ roles: { implementer: 2, reviewer: 1 } }) }) });
  const issues = (await two.team.plan()).filter(a => a.type === 'implement').map(a => a.issue);
  assert.equal(new Set(issues).size, issues.length); assert.equal(issues.length, 2);
});

test('an interim review fills the reviewer slot while the same agent implements; a second review waits', async t => {
  const w = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5)), pr(78, 'claude/issue-73-x', H(6))], out: codexOut });
  running(w, 'i', 'implement', 'claude', { issue: 5 });
  const acts = await w.team.plan();
  assert.deepEqual(acts.map(a => [a.agent, a.type, a.pr, !!a.interim]), [['claude', 'review', 77, true]]);
  const full = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))], out: codexOut });
  running(full, 'i', 'implement', 'claude', { issue: 5 }); running(full, 'r', 'review', 'claude', { pr: 76 });
  assert.deepEqual(await full.team.plan(), []);   // both slots busy (and overall 2 reached)
});

test('the reviewer slot is not blocked by an implementer job, and a review does not block implementing', async t => {
  const w = world(t, { pulls: [pr(10, 'codex/issue-2-x', H(1))] });
  running(w, 'r', 'review', 'claude', { pr: 3 });
  const acts = await w.team.plan();
  assert.deepEqual(acts.map(a => a.type), ['implement']);   // the review slot is taken; the implementer slot is free
  assert.ok(roleOfType('review') === 'reviewer' && ['implement', 'continue', 'fix', 'cifix', 'rebase'].every(k => roleOfType(k) === 'implementer'));
});

test('with both agents available a review goes to the opposite agent of the author, not the author', async t => {
  const w = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))] });
  const rev = (await w.team.plan()).filter(a => a.type === 'review');
  assert.deepEqual(rev.map(a => [a.agent, !!a.interim]), [['codex', false]]);
});

test('overall is still honoured across the slots', async t => {
  const w = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))], out: codexOut, cfg: config({ limits: limits({ overall: 1 }) }) });
  assert.equal((await w.team.plan()).length, 1);
  const full = world(t, { pulls: [pr(77, 'claude/issue-72-x', H(5))], out: codexOut }); running(full, 'a', 'implement', 'claude', { issue: 5 }); running(full, 'b', 'implement', 'claude', { issue: 6 });
  assert.deepEqual(await full.team.plan(), []);
});

test('the same issue or worktree is not planned twice: an unfinished job for it blocks a duplicate', async t => {
  const w = world(t, { issues: [issue(5)], cfg: config({ agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } }, limits: limits({ roles: { implementer: 2, reviewer: 1 } }) }) });
  w.team.s.jobs.old = { kind: 'implement', agent: 'claude', key: '5', ingested: false };
  assert.deepEqual(await w.team.plan(), []);
  const unusable = world(t, { issues: [issue(5)] }); unusable.team.s.unusable['implement:5'] = { worktree: '/x', at: 1_800_000_000_000 - 1000 };
  assert.equal((await unusable.team.plan()).filter(a => a.issue === 5).length, 0);
});

test('limits.roles is validated; per_agent is deprecated, mapped to both slots and reported on the tick', async t => {
  assert.deepEqual(validateTeamConfig(config()).deprecations, []);
  for (const bad of [{ implementer: 0, reviewer: 1 }, { implementer: 1 }, { implementer: 1, reviewer: 9 }, { implementer: 1, reviewer: 1, extra: 1 }, [], 'x'])
    assert.throws(() => validateTeamConfig(config({ limits: limits({ roles: bad }) })), /roles/);
  const old = config({ limits: { per_agent: 2, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } });
  const c = validateTeamConfig(old);
  assert.deepEqual(c.limits.roles, { implementer: 2, reviewer: 2 }); assert.match(c.deprecations[0], /per_agent is deprecated/);
  assert.throws(() => validateTeamConfig(config({ limits: { per_agent: 0, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } })), /per_agent/);
  assert.throws(() => validateTeamConfig(config({ limits: { overall: 2, max_review_attempts: 2, max_fix_attempts: 2 } })), /roles/);
  const w = world(t, { cfg: old });
  const report = await w.team.tick({ dryRun: true });
  assert.ok(report.warnings.some(x => /per_agent is deprecated/.test(x.warning)));
  assert.equal((await world(t).team.tick({ dryRun: true })).warnings, undefined);
  // roles wins over a stale per_agent
  assert.deepEqual(validateTeamConfig(config({ limits: limits({ per_agent: 3 }) })).limits.roles, { implementer: 1, reviewer: 1 });
});

test('team.local.json: roles override merges per role; a local per_agent still works (with a warning)', () => {
  const base = config();
  const merged = validateTeamConfig(applyLocalOverride(base, { limits: { roles: { reviewer: 2 } } }));
  assert.deepEqual(merged.limits.roles, { implementer: 1, reviewer: 2 });
  const legacy = validateTeamConfig(applyLocalOverride(base, { limits: { per_agent: 2 } }));
  assert.deepEqual(legacy.limits.roles, { implementer: 2, reviewer: 2 }); assert.equal(legacy.deprecations.length, 1);
  assert.throws(() => validateTeamConfig(applyLocalOverride(base, { limits: { roles: { reviewer: 0 } } })), /roles/);
});
