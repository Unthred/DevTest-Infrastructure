// Issue #402: reviewers are chosen by spare allowance; per-provider role limits; independence and gates are unchanged.
// Fake GitHub, fake jobs, fake clock, stubbed allowance modes: no model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig, resumeDecision } from '../supervisor/team.mjs';
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
async function plan(t, { pulls, written = {}, projected = {}, out = [], limits = {}, active = [], states = {}, records = {}, resumed = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revallow-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n), listIssues: async () => [], listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  // records: job records `jobs.get` returns by id; resumed: an array that collects the ids passed to `jobs.resume` (none given: no such function).
  const jobs = { listActive: async () => active, get: async id => records[id] ?? null, create: async () => ({ id: 'x' }), ...(resumed ? { resume: async id => { resumed.push(id); } } : {}) };
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
  assert.match(acts[0].why, /claude has the most spare allowance.*claude estimate 55%.*codex estimate 140%/);
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

test('both far over the limit: the one projected less over still wins, not config order', async t => {
  const a = await plan(t, { pulls: sonnetPr, written: bothWritten, projected: { claude: 4.75, codex: 2.25 } });
  assert.deepEqual(a.acts.map(x => x.agent), ['codex']);
  const b = await plan(t, { pulls: sonnetPr, written: bothWritten, projected: { claude: 2.25, codex: 4.75 } });
  assert.deepEqual(b.acts.map(x => x.agent), ['claude']);
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

// Issue #402, review of 3777c58: a paused job that resumes (issue #380) and a job resumed after a transient stop obey provider_roles too.
const provLimits = { roles: { implementer: 1, reviewer: 3 }, overall: 6, provider_roles: { claude: { reviewer: 1 }, codex: { reviewer: 1 } } };
const rev = (id, provider) => ({ id, kind: 'review', provider });

test('resumeDecision: a paused Claude review does not resume while a Claude review runs and Claude\'s reviewer limit is 1', () => {
  const nameOf = o => `job ${o.id}`;
  const held = resumeDecision({ job: rev('p1', 'claude'), others: [rev('r1', 'claude')], limits: provLimits, nameOf });
  assert.equal(held.go, false);
  assert.match(held.reason, /waiting for the claude reviewer slot \(limits.provider_roles 1\): job r1/);
});

test('resumeDecision: a running Codex job does not count against Claude\'s limit, and a full Claude limit does not hold a Codex job', () => {
  assert.deepEqual(resumeDecision({ job: rev('p1', 'claude'), others: [rev('r2', 'codex')], limits: provLimits }), { go: true });
  // Claude at its limit; a paused Codex review is a different provider and resumes (the role and overall limits still have room).
  assert.deepEqual(resumeDecision({ job: rev('p2', 'codex'), others: [rev('r1', 'claude')], limits: provLimits }), { go: true });
  // Both at their own limit: each waits for its own provider only.
  assert.equal(resumeDecision({ job: rev('p2', 'codex'), others: [rev('r1', 'claude'), rev('r2', 'codex')], limits: provLimits }).go, false);
});

test('resumeDecision: without provider_roles, or for a role it omits, the result is the same as before', () => {
  const plain = { roles: { implementer: 1, reviewer: 2 }, overall: 4 };
  assert.deepEqual(resumeDecision({ job: rev('p1', 'claude'), others: [rev('r1', 'claude')], limits: plain }), { go: true });
  const role = resumeDecision({ job: rev('p1', 'claude'), others: [rev('r1', 'claude'), rev('r2', 'claude')], limits: plain });
  assert.match(role.reason, /^waiting for the reviewer slot:/);   // still the shared role limit, with the old wording
  const omitted = { ...plain, provider_roles: { claude: { implementer: 1 } } };   // no reviewer count for Claude
  assert.deepEqual(resumeDecision({ job: rev('p1', 'claude'), others: [rev('r1', 'claude')], limits: omitted }), { go: true });
  assert.deepEqual(resumeDecision({ job: { id: 'p1', kind: 'review' }, others: [rev('r1', 'claude')], limits: provLimits }), { go: true });   // a job record without a provider
});

test('resume gate: the running jobs\' providers reach the decision; a paused Claude review waits for Claude only', async t => {
  const { team } = await plan(t, { pulls: [], limits: provLimits, active: [{ id: 'r1', provider: 'claude', status: 'running' }, { id: 'q1', provider: 'codex', status: 'queued' }, { id: 'x1', provider: 'claude', status: 'paused_limit' }],
    states: { r1: { kind: 'review', agent: 'claude', pr: 20 }, q1: { kind: 'review', agent: 'codex', pr: 21 }, x1: { kind: 'review', agent: 'claude', pr: 22 } } });
  const gate = team.resumeGate();
  const wait = await gate({ id: 'p1', kind: 'review', provider: 'claude' });
  assert.equal(wait.go, false); assert.match(wait.reason, /claude reviewer slot \(limits.provider_roles 1\): claude review on PR #20/);
  assert.doesNotMatch(wait.reason, /PR #21|PR #22/);   // the Codex job and the other paused job are not Claude's holders
  const codex = await gate({ id: 'p2', kind: 'review', provider: 'codex' });
  assert.equal(codex.go, false); assert.match(codex.reason, /codex reviewer slot \(limits.provider_roles 1\): codex review on PR #21/);   // Codex is at its own limit
  // Only Codex runs: the paused Claude review resumes, and the lock is released for the next one.
  const only = await plan(t, { pulls: [], limits: provLimits, active: [{ id: 'q1', provider: 'codex', status: 'running' }], states: { q1: { kind: 'review', agent: 'codex', pr: 21 } } });
  const go = await only.team.resumeGate()({ id: 'p1', kind: 'review', provider: 'claude' });
  assert.equal(go.go, true); go.release();
});

test('resume gate: the provider comes from the job record when the active list has none', async t => {
  const { team } = await plan(t, { pulls: [], limits: provLimits, active: [{ id: 'r1', status: 'running' }], records: { r1: { id: 'r1', kind: 'review', provider: 'claude' } } });
  const wait = await team.resumeGate()({ id: 'p1', kind: 'review', provider: 'claude' });
  assert.equal(wait.go, false); assert.match(wait.reason, /claude reviewer slot/);
});

test('one resume after a transient stop waits while the job\'s provider is at its limit, and is not used up', async t => {
  const blocked = { id: 'j1', status: 'blocked', lastEvent: 'crash', provider: 'claude', kind: 'review', updatedAt: 0 };
  const run = async (opts) => {
    const resumed = [];
    const { team } = await plan(t, { pulls: [pr(10, 'claude/issue-1-x', H(1))], records: { j1: blocked }, resumed, ...opts });
    team.s.jobs.j1 = { kind: 'review', agent: 'claude', pr: 10, ingested: true, at: 1_800_000_000_000 - 1000, ...(opts.states?.j1 || {}) };
    const report = { actions: [], notified: [], ingested: [], skipped: [], waiting: [], unblocked: [] };
    await team.resumeTransient(report);
    return { resumed, team };
  };
  const full = await run({ limits: provLimits, active: [{ id: 'r1', provider: 'claude', status: 'running' }], states: { r1: { kind: 'review', agent: 'claude', pr: 20 } } });
  assert.deepEqual(full.resumed, []);                       // Claude is at its reviewer limit
  assert.equal(full.team.s.unblock.resumed.j1, undefined);  // the one resume is kept for later
  const other = await run({ limits: provLimits, active: [{ id: 'r2', provider: 'codex', status: 'running' }], states: { r2: { kind: 'review', agent: 'codex', pr: 21 } } });
  assert.deepEqual(other.resumed, ['j1']);                  // a Codex job does not count against Claude's limit
  const none = await run({ limits: { roles: { implementer: 1, reviewer: 3 }, overall: 6 }, active: [{ id: 'r1', provider: 'claude', status: 'running' }], states: { r1: { kind: 'review', agent: 'claude', pr: 20 } } });
  assert.deepEqual(none.resumed, ['j1']);                   // no provider_roles: as before
});
