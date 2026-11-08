// Issue #1086: a held action (retry cap, circuit breaker) must not idle its lane. Fake GitHub, fake jobs, fake clock.
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
const conflicting = n => ({ ...pr(n), mergeable: 'CONFLICTING' });
const cap = (w, n, head) => { for (let i = 0; i < 2; i++) robust.noteFailure(w.team.s, { type: 'rebase', subject: n, cause: 'postcondition_not_met', head }, 1); };
const rebases = acts => acts.filter(a => a.type === 'rebase').map(a => a.pr);

test('a capped rebase is skipped inside the planner: the next PR rebases in its place, and the hold says why', async t => {
  const w = world(t, { roles: { implementer: 1, reviewer: 1, rebaser: 1 }, pulls: [conflicting(1), conflicting(2)] });
  cap(w, 1, conflicting(1).headRefOid);
  const acts = await w.team.plan();
  assert.deepEqual(rebases(acts), [2], 'the capped PR #1 does not hold #2 back');
  assert.match(Object.values(w.team.held).map(h => h.rebase).filter(Boolean).join(' | '), /rebase #1 skipped.*retry cap: 2 attempts.*postcondition_not_met/);
  assert.deepEqual(w.team.gateStops.map(x => [x.type, x.ref, x.kind, x.attempts]), [['rebase', 1, 'retry', 2]]);
});
test('negative: the capped PR is planned again once its head changes', async t => {
  const w = world(t, { roles: { implementer: 1, reviewer: 1, rebaser: 1 }, pulls: [conflicting(1), conflicting(2)] });
  cap(w, 1, 'f'.repeat(40));   // the cap belongs to an older head
  assert.deepEqual(rebases(await w.team.plan()), [1]);
});
test('a held rebase leaves the review and implement lanes running', async t => {
  const w = world(t, { roles: { implementer: 1, reviewer: 1, rebaser: 1 }, issues: [issue(5)], pulls: [conflicting(1), pr(3)] });
  cap(w, 1, conflicting(1).headRefOid);
  const acts = await w.team.plan();
  assert.deepEqual(rebases(acts), []);
  assert.ok(acts.some(a => a.type === 'review' && a.pr === 3), 'review lane runs');
  assert.ok(acts.some(a => a.type === 'implement' && a.issue === 5), 'implement lane runs');
});
test('a circuit-breaker halt on rebases is skipped in the planner too, with its cause in the tick report', async t => {
  const w = world(t, { roles: { implementer: 1, reviewer: 1, rebaser: 1 }, pulls: [conflicting(1), conflicting(2)] });
  w.team.c.breaker = { ...(w.team.c.breaker || {}), enabled: true };
  w.team.s.breaker = { halts: { 'c1': { types: ['rebase'], subjects: ['none'], since: 1, cause: 'c1' } }, global: null };
  const acts = await w.team.plan();
  assert.deepEqual(rebases(acts), [], 'every rebase is halted');
  const report = {}; w.team.applyBreaker(acts, report, true);
  assert.deepEqual(report.breaker.stopped.map(x => [x.type, x.ref, x.lane]).sort(), [['rebase', 1, 'rebaser'], ['rebase', 2, 'rebaser']].sort());
});
test('a capped review does not count as ahead of a conflicting PR in rebase order', async t => {
  const w = world(t, { roles: { implementer: 1, reviewer: 1, rebaser: 1 }, pulls: [pr(1), conflicting(2)] });
  assert.equal(w.team.rebaseNotNext(conflicting(2), [pr(1), conflicting(2)]), true, 'an unreviewed green PR ahead holds the rebase');
  for (let i = 0; i < 2; i++) robust.noteFailure(w.team.s, { type: 'review', subject: 1, cause: 'x', head: pr(1).headRefOid }, 1);
  assert.equal(w.team.rebaseNotNext(conflicting(2), [pr(1), conflicting(2)]), false, 'held, so not ahead');
});
test('clear_retry_cap removes only the capped records of that pull request; refused when none is capped', async t => {
  const w = world(t, { roles: { implementer: 1, reviewer: 1, rebaser: 1 }, pulls: [conflicting(1), conflicting(2)] });
  cap(w, 1, conflicting(1).headRefOid); cap(w, 2, conflicting(2).headRefOid);
  const msg = await w.team.applyInboxAction({ action: 'clear_retry_cap', target: '1', reason: 'fixed' }, {});
  assert.match(msg, /PR #1: retry cap cleared for rebase/);
  assert.equal(w.team.s.sameCause['rebase:1'], undefined);
  assert.ok(w.team.s.sameCause['rebase:2']);
  await assert.rejects(w.team.applyInboxAction({ action: 'clear_retry_cap', target: '1', reason: 'again' }, {}), /nothing to clear/);
  await assert.rejects(w.team.applyInboxAction({ action: 'clear_retry_cap', target: '99', reason: 'x' }, {}), /not open/);
  assert.deepEqual(rebases(await w.team.plan()), [1]);
});
test('clear_retry_cap also frees a rebase whose attempts are used up (real attempt counts)', async t => {
  const w = world(t, { roles: { implementer: 1, reviewer: 1, rebaser: 1 }, pulls: [conflicting(1)] });
  cap(w, 1, conflicting(1).headRefOid);
  w.team.s.rebaseAttempts[`1:${conflicting(1).headRefOid}`] = 2;
  assert.deepEqual(rebases(await w.team.plan()), [], 'capped and out of attempts');
  await w.team.applyInboxAction({ action: 'clear_retry_cap', target: '1', reason: 'fixed' }, {});
  assert.deepEqual(rebases(await w.team.plan()), [1], 'planned again after the clear');
});
