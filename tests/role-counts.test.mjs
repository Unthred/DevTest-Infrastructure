// Issue #344 step 1: the count per role is the homeowner's setting, with no fixed ceiling, and the overall cap follows the role counts.
// Fake GitHub, fake jobs, fake clock: no model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig, overallCap } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n';
const manifest = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'high'] } };
const nums = Array.from({ length: 12 }, (_, i) => i + 20);
const config = limits => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { max_review_attempts: 2, max_fix_attempts: 2, ...limits },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: nums } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const plan = async (t, limits, active = []) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'counts-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const issues = nums.map(n => ({ number: n, title: `Issue ${n} title here`, state: 'OPEN', body: '', labels: [] }));
  const gh = { listPulls: async () => [], getPull: async () => null, listIssues: async () => issues, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { listActive: async () => active, get: async () => null, create: async () => ({ id: 'x' }) };
  const team = new Team({ config: config(limits), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1_800_000_000_000 }, limitedOf: () => ({ out: false }), providerModels: manifest });
  return (await team.plan()).filter(a => a.type === 'implement');
};

test('overall follows the role counts when it is not set; an explicit overall still wins', () => {
  assert.equal(overallCap({ roles: { implementer: 1, reviewer: 1 } }), 2);   // identical to today's shipped 2
  assert.equal(overallCap({ roles: { implementer: 5, reviewer: 5 } }), 10);
  assert.equal(overallCap({ roles: { implementer: 5, reviewer: 5 }, overall: 3 }), 3);
});

test('implementer counts of 1, 2 and 5 fill exactly that many slots, on distinct issues', async t => {
  for (const n of [1, 2, 5]) {
    const acts = await plan(t, { roles: { implementer: n, reviewer: 1 } });
    assert.equal(acts.length, n, `implementer ${n}`);
    assert.equal(new Set(acts.map(a => a.issue)).size, n);
  }
});

test('a count above the old ceiling of 8 is accepted, and running jobs use up the slots', async t => {
  const ten = await plan(t, { roles: { implementer: 10, reviewer: 1 } });
  assert.equal(ten.length, 10); assert.equal(new Set(ten.map(a => a.issue)).size, 10);
  const active = [1, 2, 3].map(i => ({ id: 'j' + i, provider: 'claude', status: 'running' }));
  assert.equal((await plan(t, { roles: { implementer: 5, reviewer: 1 } }, active)).length, 2);   // 3 unrecorded jobs use 3 of the 5 implementer slots
});

test('an explicit overall below the role counts still caps the total', async t => {
  assert.equal((await plan(t, { roles: { implementer: 5, reviewer: 5 }, overall: 3 })).length, 3);
});

test('validation: counts must be positive integers, overall is optional and unbounded above', () => {
  validateTeamConfig(config({ roles: { implementer: 20, reviewer: 20 } }));
  validateTeamConfig(config({ roles: { implementer: 1, reviewer: 1 }, overall: 40 }));
  for (const bad of [{ implementer: 0, reviewer: 1 }, { implementer: 1.5, reviewer: 1 }, { implementer: 1 }, { implementer: 1, reviewer: -2 }])
    assert.throws(() => validateTeamConfig(config({ roles: bad })), /invalid team limit: roles/);
  for (const overall of [0, -1, 2.5, '3']) assert.throws(() => validateTeamConfig(config({ roles: { implementer: 1, reviewer: 1 }, overall })), /invalid team limit: overall/);
  assert.throws(() => validateTeamConfig(config({ roles: { implementer: 1, reviewer: 1 }, max_fix_attempts: 9 })), /max_fix_attempts/);   // other limits keep their bounds
});
