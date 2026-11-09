// Issue #1107, planner scenario invariants: infrastructure faults never use an attempt, never set a retry cap, never trip the
// breaker, raise at most one Needs you item per agent, never launch a parked agent before its probe passes, and let another worker
// take the item meanwhile. Fake GitHub, fake jobs, fake clock; no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { stoppedAttention } from '../supervisor/faultview.mjs';
import { robustnessView } from '../supervisor/dashboard.mjs';

const H = n => String(n).repeat(40).slice(0, 40), MIN = 60000;
const green = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';
const agent = (name, issues) => ({ provider: name, branch_prefix: `${name}/`, issues });
const config = (agents) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 4 }, overall: 6, max_review_attempts: 2, max_fix_attempts: 2, cancelled_wait_ms: 0 },
  agents, board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, branch, head) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green });

function world(t, { agents, pulls, probeOk = () => false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'infra-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [], created: [] };
  const clock = { t: 1_000_000, now: () => clock.t };
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => [],
    comment: async (n, body) => calls.comments.push([n, body]), addLabel: async (n, l) => calls.labels.push([n, l]), removeLabel: async () => {},
    hasComment: async () => false, findIssueByMarker: async () => null, createIssue: async () => 1, issueComments: async () => [{ association: 'OWNER', body: '' }],
    merge: async () => {}, board: async () => {}, listMergedPulls: async () => [] };
  const jobs = { states: {}, seq: 0, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push({ id, spec }); jobs.states[id] = { id, status: 'running', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: config(agents), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock, alert: async () => {} });
  const probed = [];
  team.faults.probe = async a => { probed.push(a); return probeOk(a, clock.t); };
  return { team, jobs, calls, clock, probed };
}
const reviewers = w => w.calls.created.filter(c => c.spec.kind === 'review');
const fail = (w, id, lastEvent, usage = {}) => { w.jobs.states[id] = { id, status: 'blocked', lastEvent, usage, updatedAt: w.clock.t - 1000 }; };
const AGENTS = { claude: agent('claude', [23]), codex: agent('codex', [2]) };

test('PR #1104 style: two sign-in failures leave no retry cap, no spent attempt and no homeowner label', async t => {
  let signedIn = false;
  const w = world(t, { agents: AGENTS, pulls: [pr(10, 'claude/issue-23-x', H(1))], probeOk: () => signedIn });
  await w.team.tick();
  assert.equal(reviewers(w).length, 1, 'codex starts the review');
  fail(w, reviewers(w)[0].id, 'auth_error');
  await w.team.tick();
  assert.deepEqual(w.team.s.reviewAttempts, { [`10:${H(1)}:codex`]: 0 }, 'the launch attempt was handed back');
  assert.deepEqual(w.team.s.sameCause, {}); assert.deepEqual(w.calls.labels, []); assert.equal(w.calls.comments.length, 0);
  assert.ok(w.team.s.infra.parked.codex);
  // Parked: nothing is launched, however many ticks pass, until the probe passes.
  for (let i = 0; i < 3; i++) { w.clock.t += MIN; await w.team.tick(); }
  assert.equal(reviewers(w).length, 1, 'a parked agent is never launched'); assert.deepEqual(w.probed, [], 'not probed before the first backoff');
  w.clock.t += 5 * MIN; await w.team.tick();
  assert.deepEqual(w.probed, ['codex']); assert.equal(reviewers(w).length, 1, 'the probe failed: still parked');
  signedIn = true; w.clock.t += 15 * MIN; await w.team.tick();
  assert.equal(w.team.s.infra.parked.codex, undefined, 'released when the probe passes');
  await w.team.tick();
  assert.equal(reviewers(w).length, 2, 'launched only after the probe passed');
  // The second sign-in failure (the report's case): still no cap.
  fail(w, reviewers(w)[1].id, 'auth_error'); await w.team.tick();
  assert.deepEqual(w.team.s.sameCause, {}); assert.equal(w.team.retryCapItems().length, 0);
  assert.equal(w.team.s.reviewAttempts[`10:${H(1)}:codex`], 0); assert.deepEqual(w.calls.labels, []);
  assert.equal(w.team.s.infra.counts.auth_error, 2);
});

test('many infrastructure faults: no cap, no breaker, at most one Needs you item per agent, shown apart in status', async t => {
  const w = world(t, { agents: AGENTS, pulls: [pr(10, 'claude/issue-23-x', H(1)), pr(11, 'claude/issue-23-y', H(2))] });
  const causes = ['auth_error', 'network_error', 'preflight_failed', 'crash', 'network_error', 'auth_error', 'crash', 'preflight_failed'];
  let launched = 0;
  for (const ev of causes) {
    // every probe fails; the backoff is walked past on each round so the agent would run if it were not parked
    await w.team.tick();
    const fresh = reviewers(w).slice(launched); launched = reviewers(w).length;
    for (const c of fresh) fail(w, c.id, ev);
    w.clock.t += 61 * MIN;
    await w.team.tick();
  }
  assert.deepEqual(w.team.s.sameCause, {}); assert.equal(w.team.retryCapItems().length, 0);
  assert.ok(Object.values(w.team.s.reviewAttempts).every(n => n === 0), JSON.stringify(w.team.s.reviewAttempts));
  assert.deepEqual(w.team.s.breaker.halts || {}, {}); assert.ok(!w.team.s.breaker.global); assert.deepEqual(w.team.s.breaker.waste || {}, {});
  assert.deepEqual(w.team.s.failCauses.records, {}, 'faults are not work failure causes');
  assert.ok(w.team.s.infra.counts.auth_error >= 1);
  const items = stoppedAttention(w.team).filter(i => i.id.startsWith('agentfault-'));
  assert.ok(items.length <= 1 && items.every(i => i.id === 'agentfault-codex'), JSON.stringify(items.map(i => i.id)));
  const view = robustnessView(w.team.s, w.team, [], w.clock.t);
  assert.ok(view.infraFaults.counts.auth_error >= 1); assert.equal(view.infraFaults.parked[0].agent, 'codex');
});

test('the Needs you item appears only after 30 minutes, once per agent, and clears when the probe passes', async t => {
  let ok = false;
  const w = world(t, { agents: AGENTS, pulls: [pr(10, 'claude/issue-23-x', H(1))], probeOk: () => ok });
  await w.team.tick(); fail(w, reviewers(w)[0].id, 'auth_error'); await w.team.tick();
  const ids = () => stoppedAttention(w.team).filter(i => i.id.startsWith('agentfault-')).map(i => i.id);
  assert.deepEqual(ids(), []);
  w.clock.t += 31 * MIN; await w.team.tick();
  assert.deepEqual(ids(), ['agentfault-codex']);
  w.clock.t += 61 * MIN; await w.team.tick(); assert.deepEqual(ids(), ['agentfault-codex'], 'still one item');
  assert.match(stoppedAttention(w.team).find(i => i.id === 'agentfault-codex').action, /sign the codex CLI in on Tower/);
  ok = true; w.clock.t += 61 * MIN; await w.team.tick();
  assert.deepEqual(ids(), [], 'cleared by itself');
});

test('another eligible worker takes the item while one agent is parked', async t => {
  const agents = { claude: agent('claude', [23]), codex: agent('codex', [2]), gemini: agent('gemini', [3]) };
  const w = world(t, { agents, pulls: [pr(10, 'claude/issue-23-x', H(1))] });
  await w.team.tick();
  const first = reviewers(w)[0]; assert.ok(first);
  fail(w, first.id, 'auth_error');
  const parkedAgent = w.team.s.jobs[first.id].agent;
  await w.team.tick();
  assert.ok(w.team.s.infra.parked[parkedAgent]);
  const other = reviewers(w).slice(1).map(c => w.team.s.jobs[c.id].agent);
  assert.ok(other.length >= 1 && other.every(a => a !== parkedAgent && a !== 'claude'), `a different worker reviews: ${other}`);
});

test('a work failure with tokens still counts and caps (the rule is not weakened)', async t => {
  const w = world(t, { agents: AGENTS, pulls: [pr(10, 'claude/issue-23-x', H(1))] });
  await w.team.tick(); fail(w, reviewers(w)[0].id, 'crash', { inputTokens: 500, outputTokens: 20 }); await w.team.tick();
  assert.ok(w.team.s.reviewAttempts[`10:${H(1)}:codex`] >= 1, 'the attempt stays counted');
  assert.equal(w.team.s.infra?.parked?.codex, undefined); assert.equal(Object.values(w.team.s.sameCause)[0].count, 1);
});

test('install: caps set by infrastructure faults are cleared once, one log line each', async t => {
  const w = world(t, { agents: AGENTS, pulls: [] });
  w.team.s.sameCause = { 'review:10': { cause: 'auth_error', count: 2, head: H(1), at: w.clock.t }, 'fix:11': { cause: 'postcondition_not_met', count: 2, head: H(2), at: w.clock.t } };
  const r = await w.team.tick();
  assert.deepEqual(Object.keys(w.team.s.sameCause), ['fix:11'], 'only the infrastructure cap goes');
  assert.equal(r.infraCapsCleared.length, 1); assert.match(r.infraCapsCleared[0], /review:10.*auth_error/);
  w.team.s.sameCause['review:12'] = { cause: 'auth_error', count: 2, head: H(3), at: w.clock.t };
  const r2 = await w.team.tick();
  assert.ok(!r2.infraCapsCleared, 'once only'); assert.ok(w.team.s.sameCause['review:12']);
});
