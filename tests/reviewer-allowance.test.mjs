// Issue #402: reviewers are chosen by spare allowance; per-provider role limits; independence and gates are unchanged.
// Fake GitHub, fake jobs, fake clock, stubbed allowance modes: no model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-024 — z\n- Status: homeowner-approved\n- Date: 2026-11-01\n';
const config = (limits = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, max_review_attempts: 2, max_fix_attempts: 2, ...limits },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' } }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, branch, head) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green });
const manifests = { claude: { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };
// projected: fraction of the weekly allowance projected at the reset (null = unknown reading).
const mode = projected => ({ mode: 'normal', known: projected !== null, projected, used: 0.1, costs: { cost: () => 0.01 } });

// written: { prNumber: [agent, model] } records who wrote each head. out: agents out of allowance.
async function plan(t, { pulls, written = {}, projected = {}, out = [], limits = {}, active = [], states = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revallow-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n), listIssues: async () => [], listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { listActive: async () => active, get: async () => null, create: async () => ({ id: 'x' }) };
  const team = new Team({ config: config(limits), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER,
    clock: { now: () => 1_800_000_000_000 }, limitedOf: a => (out.includes(a) ? { out: true, reason: 'usage limit' } : { out: false }), providerModels: manifests });
  Object.entries(written).forEach(([n, [agent, model]], i) => { team.s.jobs['w' + i] = { kind: 'implement', agent, pr: Number(n), model, branch: pulls.find(p => p.number === Number(n)).headRefName }; });
  Object.assign(team.s.jobs, states);
  team.budgets = () => Object.fromEntries(Object.keys(team.c.agents).map(a => [a, projected[a] === undefined ? mode(null) : mode(projected[a])]));
  const acts = (await team.plan()).filter(a => a.type === 'review');
  return { acts, team };
}
const sonnetPr = [pr(10, 'claude/issue-1-x', H(1))], bothWritten = { 10: ['claude', 'sonnet'] };

test('both eligible: the reviewer with the most spare allowance is chosen, whichever provider wrote it', async t => {
  const { acts } = await plan(t, { pulls: sonnetPr, written: bothWritten, projected: { claude: 0.55, codex: 1.4 } });
  assert.deepEqual(acts.map(a => a.agent), ['claude']);
  assert.match(acts[0].why, /claude has the most spare allowance.*claude projected 55%.*codex projected 140%/);
  const flip = await plan(t, { pulls: sonnetPr, written: bothWritten, projected: { claude: 1.2, codex: 0.4 } });
  assert.deepEqual(flip.acts.map(a => a.agent), ['codex']);   // no "another provider first" preference any more
});

test('a Codex-written PR goes to Claude when Claude has more spare; a Claude-written one stays with Claude when Codex is scarcer', async t => {
  const pulls = [pr(11, 'codex/issue-2-x', H(2))];
  const { acts } = await plan(t, { pulls, written: { 11: ['codex', 'gpt-5'] }, projected: { claude: 0.3, codex: 1.5 } });
  assert.deepEqual(acts.map(a => [a.agent, a.pr]), [['claude', 11]]);
  const same = await plan(t, { pulls: sonnetPr, written: bothWritten, projected: { claude: 0.3, codex: 1.5 } });
  assert.deepEqual(same.acts.map(a => a.agent), ['claude']);
});

test('only one reviewer eligible: it reviews, and the reason says so', async t => {
  const { acts } = await plan(t, { pulls: sonnetPr, written: bothWritten, projected: { claude: 0.2, codex: 0.9 }, out: ['claude'] });
  assert.deepEqual(acts.map(a => a.agent), ['codex']);
  assert.match(acts[0].why, /codex is the only reviewer that can review PR #10 \(claude: out of allowance\)/);
});

test('an Opus-written PR can only be reviewed by Codex, and it goes there first even when Codex is scarce', async t => {
  const pulls = [pr(10, 'claude/issue-1-x', H(1)), pr(12, 'claude/issue-3-x', H(3))];   // 10 sonnet-written (shared), 12 opus-written (Codex only)
  const written = { 10: ['claude', 'sonnet'], 12: ['claude', 'opus'] };
  const { acts } = await plan(t, { pulls, written, projected: { claude: 0.2, codex: 1.6 }, limits: { roles: { implementer: 1, reviewer: 2 }, overall: 4 } });
  const by = Object.fromEntries(acts.map(a => [a.pr, a.agent]));
  assert.deepEqual(by, { 10: 'claude', 12: 'codex' });
  assert.match(acts.find(a => a.pr === 12).why, /only reviewer/);
  // One reviewer slot, Claude has more spare allowance: the PR only Codex can review still goes first.
  const solo = await plan(t, { pulls, written, projected: { claude: 1.4, codex: 1.6 } });
  assert.deepEqual(solo.acts.map(a => [a.agent, a.pr]), [['codex', 12]]);
  // Extreme spread (Codex projected far over, Claude far under): the sole-reviewer priority is still absolute.
  const extreme = await plan(t, { pulls, written, projected: { claude: 0.0, codex: 5 } });
  assert.deepEqual(extreme.acts.map(a => [a.agent, a.pr]), [['codex', 12]]);
  // Claude out of allowance: Codex is the only reviewer for both PRs, and with one slot it takes them in the review queue order (issue #405: PR 12, which only Codex may review, ahead of PR 10).
  const codexOnly = await plan(t, { pulls, written, projected: { claude: 1.4, codex: 0.2 }, out: ['claude'] });
  assert.deepEqual(codexOnly.acts.map(a => [a.agent, a.pr]), [['codex', 12]]);
});

test('unknown readings: known spare beats unknown, unknown beats a reviewer projected to run out, two unknowns keep config order', async t => {
  assert.deepEqual((await plan(t, { pulls: sonnetPr, written: bothWritten, projected: { claude: null, codex: 0.5 } })).acts.map(a => a.agent), ['codex']);
  assert.deepEqual((await plan(t, { pulls: sonnetPr, written: bothWritten, projected: { claude: 1.3, codex: null } })).acts.map(a => a.agent), ['codex']);
  const none = await plan(t, { pulls: sonnetPr, written: bothWritten, projected: {} });
  assert.deepEqual(none.acts.map(a => a.agent), ['claude']);
  assert.match(none.acts[0].why, /reading unknown/);
});

test('a provider out of allowance reviews nothing and does not hold up the other provider', async t => {
  const pulls = [pr(10, 'claude/issue-1-x', H(1)), pr(11, 'codex/issue-2-x', H(2))];
  const { acts, team } = await plan(t, { pulls, written: { 10: ['claude', 'sonnet'], 11: ['codex', 'gpt-5'] }, projected: { claude: 0.9, codex: 0.1 }, out: ['codex'],
    limits: { roles: { implementer: 1, reviewer: 2 }, overall: 4, provider_roles: { claude: { reviewer: 1 }, codex: { reviewer: 1 } } } });
  assert.deepEqual(acts.map(a => a.agent), ['claude']);   // codex's slot stays empty; claude uses its own
  assert.match(team.held.codex.review, /out of allowance/);
});

test('independence is unchanged: a provider that wrote the head with an unknown model is not offered the review', async t => {
  const { acts } = await plan(t, { pulls: [pr(11, 'codex/issue-2-x', H(2))], projected: { claude: 1.5, codex: 0.0 } });   // no writer record: Codex cannot show it differs
  assert.deepEqual(acts.map(a => a.agent), ['claude']);
});

test('per-provider limits: Codex and Claude reviewers run together, and one provider cannot fill the other\'s slot', async t => {
  const pulls = [pr(10, 'claude/issue-1-x', H(1)), pr(12, 'claude/issue-3-x', H(3)), pr(13, 'claude/issue-4-x', H(4))];
  const written = { 10: ['claude', 'sonnet'], 12: ['claude', 'sonnet'], 13: ['claude', 'opus'] };
  const limits = { roles: { implementer: 1, reviewer: 2 }, overall: 4, provider_roles: { claude: { reviewer: 1 }, codex: { reviewer: 1 } } };
  const { acts } = await plan(t, { pulls, written, projected: { claude: 0.1, codex: 1.5 }, limits });
  assert.deepEqual(acts.map(a => a.agent).sort(), ['claude', 'codex']);
  assert.equal(acts.find(a => a.agent === 'codex').pr, 13);   // Codex's slot goes to the PR only it can review
  // Claude already has a review running: its provider slot is full, so only Codex starts one, although the shared reviewer role has room.
  const running = await plan(t, { pulls, written, projected: { claude: 0.1, codex: 1.5 }, limits, active: [{ id: 'r1', provider: 'claude', status: 'running' }], states: { r1: { kind: 'review', agent: 'claude', pr: 99 } } });
  assert.deepEqual(running.acts.map(a => [a.agent, a.pr]), [['codex', 13]]);
  assert.match(running.team.held.claude.review, /claude reviewer slot full \(limits.provider_roles 1\)/);
  // The reverse: a running Codex review leaves Claude its slot.
  const rev = await plan(t, { pulls, written, projected: { claude: 0.1, codex: 1.5 }, limits, active: [{ id: 'r2', provider: 'codex', status: 'running' }], states: { r2: { kind: 'review', agent: 'codex', pr: 98 } } });
  assert.deepEqual(rev.acts.map(a => a.agent), ['claude']);
});

test('without provider_roles, slot counts behave as before: shared role slots, one reviewer', async t => {
  const pulls = [pr(10, 'claude/issue-1-x', H(1)), pr(12, 'claude/issue-3-x', H(3))];
  const { acts } = await plan(t, { pulls, written: { 10: ['claude', 'sonnet'], 12: ['claude', 'sonnet'] }, projected: { claude: 0.5, codex: 0.5 } });
  assert.equal(acts.length, 1);
  const two = await plan(t, { pulls, written: { 10: ['claude', 'sonnet'], 12: ['claude', 'sonnet'] }, projected: { claude: 0.5, codex: 0.5 }, limits: { roles: { implementer: 1, reviewer: 2 }, overall: 4 } });
  assert.equal(two.acts.length, 2);
});

test('validation: provider_roles names configured providers, known roles and positive integers', () => {
  const ok = config({ provider_roles: { codex: { reviewer: 1 }, claude: { reviewer: 1, implementer: 1 } } });
  assert.equal(validateTeamConfig(ok).limits.provider_roles.codex.reviewer, 1);
  for (const bad of [{ gemini: { reviewer: 1 } }, { codex: {} }, { codex: { reviewer: 0 } }, { codex: { reviewer: 1.5 } }, { codex: { writer: 1 } }, [], 'x', { codex: 3 }])
    assert.throws(() => validateTeamConfig(config({ provider_roles: bad })), /invalid team limit: provider_roles/);
});
