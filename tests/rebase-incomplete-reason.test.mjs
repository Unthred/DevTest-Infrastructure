// Issue #460: a rebase that ends incomplete records why; limits.roles.rebaser is validated. Fake GitHub, fake jobs, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, overallCap, roleCount } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const config = roles => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });

function world(t, { pull, jobRecord, roles = { implementer: 1, reviewer: 1 } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbreason-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { pulls: [pull], listPulls: async () => gh.pulls, getPull: async () => gh.pulls[0], listIssues: async () => [], listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { listActive: async () => [], get: async () => jobRecord, create: async () => ({ id: 'x'.repeat(32) }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  return new Team({ config: config(roles), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 1_800_000_000_000 }, providerModels: { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'high'] } }, sleep: async () => {} });
}
const pull = (extra = {}) => ({ number: 7, title: 't', headRefName: 'claude/issue-7-x', headRefOid: H(2), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [], ...extra });
const job = (over = {}) => ({ id: 'j'.repeat(32), status: 'blocked', lastEvent: 'incomplete', attempts: 2, postcondition: { kind: 'rebased', pr: 7, baseHead: H(1) }, ...over });

test('issue #460: the rebased post-condition names why it was not met', async t => {
  const cases = [
    [{ headRefOid: H(1) }, /no new head was pushed/],
    [{ mergeable: 'CONFLICTING' }, /still conflicts/],
    [{ mergeable: 'UNKNOWN' }, /did not report it mergeable/],
  ];
  for (const [extra, re] of cases) {
    const team = world(t, { pull: pull(extra) }), j = job();
    assert.equal(await team.postconditions()(j), false);
    assert.match(j.postconditionDetail, re);
  }
  const ok = job(); assert.equal(await world(t, { pull: pull() }).postconditions()(ok), true);
  assert.equal(ok.postconditionDetail, undefined, 'negative: a met post-condition records no reason');
});

test('issue #460: an incomplete rebase job records cause, detail and attempts; a completed one records none', async t => {
  const id = 'j'.repeat(32), rec = job({ incompleteReason: { cause: 'postcondition_not_met', detail: 'a new head was pushed but the pull request still conflicts with its base', attempt: 2 } });
  const team = world(t, { pull: pull(), jobRecord: rec });
  const j = team.s.jobs[id] = { kind: 'rebase', agent: 'claude', pr: 7, head: H(1), key: `7:${H(1)}`, ingested: false, at: 1 };
  const report = { ingested: [] };
  await team.ingestOne(id, j, report);
  assert.deepEqual(j.incomplete, { cause: 'conflict', detail: rec.incompleteReason.detail, attempts: 2, status: 'blocked' });
  assert.equal(report.incompleteRebases[0].pr, 7);
  // a crash-type stop records the run event as the cause
  const crash = world(t, { pull: pull(), jobRecord: job({ status: 'failed', lastEvent: 'crash', incompleteReason: { cause: 'crash', detail: 'the run ended with crash (exit 1)', attempt: 1 } }) });
  const jc = crash.s.jobs[id] = { kind: 'rebase', agent: 'claude', pr: 7, head: H(1), key: 'k', ingested: false, at: 1 };
  await crash.ingestOne(id, jc, { ingested: [] });
  assert.equal(jc.incomplete.cause, 'crash');
  // negative: a completed rebase and a non-rebase job record nothing
  const done = world(t, { pull: pull({ headRefOid: H(3) }), jobRecord: job({ status: 'completed', lastEvent: 'completed' }) });
  const jd = done.s.jobs[id] = { kind: 'rebase', agent: 'claude', pr: 7, head: H(1), key: 'k', ingested: false, at: 1 };
  await done.ingestOne(id, jd, { ingested: [] });
  assert.equal(jd.incomplete, undefined);
  const fix = world(t, { pull: pull(), jobRecord: job({ kind: 'fix' }) });
  const jf = fix.s.jobs[id] = { kind: 'fix', agent: 'claude', pr: 7, head: H(1), key: 'k', ingested: false, at: 1 };
  await fix.ingestOne(id, jf, { ingested: [] });
  assert.equal(jf.incomplete, undefined);
});

test('issue #460: limits.roles.rebaser is optional (default 1), counted in the overall cap, and validated', async t => {
  assert.equal(roleCount({ roles: { implementer: 1, reviewer: 1 } }, 'rebaser'), 1);
  assert.equal(roleCount({ roles: { implementer: 1, reviewer: 1, rebaser: 3 } }, 'rebaser'), 3);
  assert.equal(overallCap({ roles: { implementer: 1, reviewer: 1, rebaser: 3 } }), 5);
  for (const bad of [0, -1, 1.5, '2']) assert.throws(() => world(t, { pull: pull(), roles: { implementer: 1, reviewer: 1, rebaser: bad } }), /invalid team limit: roles/);
  assert.throws(() => world(t, { pull: pull(), roles: { implementer: 1, reviewer: 1, rebaser: 1, extra: 1 } }), /invalid team limit: roles/);
});
