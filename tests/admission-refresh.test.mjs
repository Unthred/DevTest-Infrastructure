// Issue #1163: the allowance refresh runs at the admission decision. A job planned on an agent with a stale reading is preceded by one probe and
// judged against the fresh reading; with nothing planned there is no probe however old the reading is (no timer).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { HOUR } from '../supervisor/budget.mjs';
import { MINUTE } from '../supervisor/probe.mjs';
import { refreshBeforeAdmission } from '../supervisor/admissionrefresh.mjs';

const RESET = Date.parse('2026-11-12T04:00:00Z'), NOW = RESET - 3.5 * 24 * HOUR;
const al = (weekly, ageMin) => ({ provider: 'claude', status: 'allowed', observedAt: NOW - ageMin * MINUTE, source: 'probe',
  windows: [{ type: 'seven_day', utilization: weekly, resetsAt: RESET, status: 'allowed' }], billing: { overageStatus: 'rejected', usingOverage: false } });
const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };

function world(t, reading, fresh) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ar-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => [], listIssues: async () => [], listMergedPulls: async () => [] };
  const tm = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs: { listActive: async () => [] }, git: {}, register: '', clock: { now: () => NOW },
    usage: { allowance: { claude: reading }, jobs: [], snapshots: [] }, timeZone: 'Europe/London', alert: async () => {} });
  tm.modes = tm.budgets();
  const calls = [];
  tm.admissionProbe = { canProbe: () => true, run: async due => { calls.push(due.reason); return fresh; } };
  return { tm, calls };
}
const act = { type: 'implement', agent: 'claude', issue: 5 };

test('a job planned on a normal agent with a 2 hour old reading gets one probe first, and starts when the fresh reading admits it', async t => {
  const w = world(t, al(0.5, 120), al(0.5, 0));
  assert.equal(await refreshBeforeAdmission(w.tm, act), null);
  assert.deepEqual(w.calls, ['stale']);
  assert.equal(await refreshBeforeAdmission(w.tm, act), null);
  assert.equal(w.calls.length, 1, 'a second job in the same interval does not probe again');
});

test('a probe result above the exhausted threshold blocks the job that triggered it', async t => {
  const w = world(t, al(0.5, 120), al(0.997, 0));
  const refused = await refreshBeforeAdmission(w.tm, act);
  assert.equal(refused.out, true);
  assert.match(refused.reason, /fresh reading/);
});

test('no probe when the reading is fresh and above the reserve, when nothing is planned, or for a merge', async t => {
  const fresh = world(t, al(0.5, 10), al(0.5, 0));
  assert.equal(await refreshBeforeAdmission(fresh.tm, act), null);
  assert.deepEqual(fresh.calls, []);
  const idle = world(t, al(0.5, 600), al(0.5, 0));
  assert.deepEqual(idle.tm.probesDue(() => true), [], 'an old reading alone never asks for a probe');
  assert.deepEqual(idle.calls, []);
  const none = world(t, al(0.5, 600), al(0.5, 0)); none.tm.admissionProbe = null;
  assert.equal(await refreshBeforeAdmission(none.tm, act), null, 'a dry run or a hold has no probe hook');
});

test('a probe that yields no reading leaves the job to the existing reading and is not retried inside the interval', async t => {
  const w = world(t, al(0.5, 120), null);
  assert.equal(await refreshBeforeAdmission(w.tm, act), null);
  assert.equal(await refreshBeforeAdmission(w.tm, act), null);
  assert.equal(w.calls.length, 1);
});
