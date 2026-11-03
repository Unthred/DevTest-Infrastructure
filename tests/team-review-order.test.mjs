// Issue #405: review order. Closest to merge first, then oldest; a PR only this agent can review goes first; nothing waits forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const cfg = (limits = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...limits },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green, ...extra });

function world(t, pulls, { limits, now = 1000, setup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revord-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [] };
  const jobs = { listActive: async () => [], get: async () => null };
  const clock = { now: () => now };
  const team = new Team({ config: cfg(limits), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { worktreeFor: async () => null }, register: '', clock });
  setup?.(team);
  return { team, clock, setAt: n => { now = n; } };
}
const reviewOf = async (team, agent) => (await team.plan()).find(a => a.agent === agent && a.type === 'review');

test('#405 newest versus oldest: of two equal PRs the older is reviewed first, not the newest-first GitHub order', async t => {
  // GitHub lists newest first: 403, 388, 222
  const w = world(t, [pr(403, 'codex/issue-2-a', H(3)), pr(388, 'codex/issue-3-b', H(2)), pr(222, 'codex/issue-4-c', H(1))]);
  assert.equal((await reviewOf(w.team, 'claude')).pr, 222);
});

test('#405 closer to merge first: mergeable beats conflicting-unknown, more earlier rounds beats fewer, then age', async t => {
  const pulls = [pr(10, 'codex/issue-2-a', H(1), { mergeable: 'UNKNOWN' }), pr(20, 'codex/issue-3-b', H(2)), pr(30, 'codex/issue-4-c', H(3))];
  const w = world(t, pulls, { setup: team => { team.s.verdicts[`30:${H(9)}`] = { verdict: 'CHANGES', reviewer: 'claude', at: 1 }; } });
  const q = w.team.reviewQueue('claude', pulls);
  assert.deepEqual(q.map(r => r.pr.number), [30, 20, 10]);
  assert.match(q[0].reason, /1 earlier review round/); assert.match(q[1].reason, /mergeable/);
  // the unknown-mergeability PR is not eligible at all (existing gate stays), the planner picks the next one
});

test('#405 a PR only this agent can review goes before a PR either agent can review', async t => {
  // #5 was written by claude and #6 by codex; with one reviewer each, claude can only review codex-written PRs, so #6... use models:
  // Both agents have review models; #7 was written by a claude model that codex may also review, #8 by a model both providers' reviewers cannot match.
  const pulls = [pr(7, 'codex/issue-2-a', H(1)), pr(8, 'codex/issue-3-b', H(2))];
  const w = world(t, pulls);
  // Make codex unable to review #8 (it wrote it): everyone else can still review #7 (codex-written reviewed by codex is refused too), so stub the refusal.
  const real = w.team.reviewRefusal.bind(w.team);
  w.team.reviewRefusal = (agent, p, key) => (agent === 'codex' && p.number === 8 ? 'codex wrote it' : agent === 'codex' && p.number === 7 ? null : real(agent, p, key));
  const q = w.team.reviewQueue('claude', pulls);
  assert.deepEqual(q.map(r => r.pr.number), [8, 7]);
  assert.equal(q[0].scarce, true); assert.equal(q[1].scarce, false); assert.match(q[0].reason, /only claude can review it/);
  assert.equal((await reviewOf(w.team, 'claude')).pr, 8);
  // for codex's own slot, #8 is not its to review, and #7 is scarce for codex only if claude could not review it
  assert.deepEqual(w.team.reviewQueue('codex', pulls).map(r => r.scarce), [false, false]);
});

test('#405 starvation: a PR waiting longer than the limit goes first, even behind closer PRs, and the wait is kept across ticks', async t => {
  const pulls = [pr(50, 'codex/issue-2-a', H(1), { mergeable: 'UNKNOWN' }), pr(60, 'codex/issue-3-b', H(2))];
  const w = world(t, pulls, { limits: { review_starvation_hours: 2 }, now: 0, setup: team => { team.s.verdicts[`60:${H(9)}`] = { verdict: 'CHANGES', reviewer: 'claude', at: 1 }; } });
  w.team.recordReviewWaits(pulls.slice(0, 1)); w.setAt(2 * 3600000); w.team.recordReviewWaits(pulls); w.setAt(0);
  assert.deepEqual(w.team.reviewQueue('claude', pulls).map(r => r.pr.number), [60, 50]);   // closer PR first while nothing has starved
  w.setAt(3 * 3600000);
  const q = w.team.reviewQueue('claude', pulls);
  assert.deepEqual(q.map(r => r.pr.number), [50, 60]);
  assert.equal(q[0].starved, true); assert.match(q[0].reason, /waited 3h for a review \(limit 2h\)/);
  // a verdict on the current head ends the wait record; a closed PR is dropped
  w.team.s.verdicts[`50:${H(1)}`] = { verdict: 'PASS', reviewer: 'claude', at: 1 };
  w.team.recordReviewWaits(pulls.slice(0, 1)); assert.deepEqual(Object.keys(w.team.s.reviewSince), []);
});

test('#405 a new PR cannot jump ahead of an older equal PR however often it appears', async t => {
  const old = pr(222, 'codex/issue-2-a', H(1));
  for (const newer of [223, 400, 9999]) {
    const w = world(t, [pr(newer, 'codex/issue-3-b', H(2)), old]);
    assert.equal((await reviewOf(w.team, 'claude')).pr, 222);
  }
});

test('#405 the limit is validated', () => {
  for (const bad of [0, -1, 'x', 1000]) assert.throws(() => new Team({ config: cfg({ review_starvation_hours: bad }), root: '/x', gh: {}, jobs: {}, git: {}, clock: { now: () => 0 } }), /review_starvation_hours/);
});
