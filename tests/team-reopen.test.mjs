// Issue #490: `team reopen ISSUE` clears the implemented mark so the planner can start an implement job again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const cfg = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23, 24] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const ID = 'a'.repeat(32);

function world(t, { jobStatus = 'completed', ingested = true, prs = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { issues: [{ number: 23, title: 'A', state: 'OPEN', body: '', labels: [] }, { number: 24, title: 'B', state: 'OPEN', body: '', labels: [] }], prs,
    listPulls: async () => gh.prs, getPull: async () => null, listIssues: async () => gh.issues, board: async () => {}, listMergedPulls: async () => [],
    comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} };
  const jobs = { states: { [ID]: { id: ID, status: jobStatus } }, listActive: async () => [], get: async id => jobs.states[id] || null, create: async () => ({ id: 'b'.repeat(32) }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: cfg(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 5000 } });
  team.s.jobs[ID] = { kind: 'implement', agent: 'claude', key: '23', issue: 23, branch: 'claude/issue-23-a', ingested, at: 1 };
  team.s.implemented[23] = 1; team.s.implemented[24] = 2; team.save();
  return { gh, jobs, team };
}
const implementsOf = async team => (await team.plan()).filter(a => a.type === 'implement').map(a => a.issue);

test('refused while the implemented mark does not exist, the issue is closed or missing', async t => {
  const w = world(t);
  delete w.team.s.implemented[23];
  await assert.rejects(w.team.reopen(23), /not marked implemented/);
  w.team.s.implemented[23] = 1; w.gh.issues[0].state = 'CLOSED';
  await assert.rejects(w.team.reopen(23), /not open/);
  await assert.rejects(w.team.reopen(99), /not found/);
  assert.equal(w.team.s.implemented[23], 1); assert.equal(w.team.s.unblock.log.length, 0);
});

test('refused while an open pull request exists for the issue', async t => {
  const w = world(t, { prs: [{ number: 411, headRefName: 'claude/issue-23-a', isDraft: false, labels: [] }] });
  await assert.rejects(w.team.reopen(23), /open pull request \(#411\)/);
  assert.equal(w.team.s.implemented[23], 1); assert.equal(w.team.s.unblock.log.length, 0);
});

test('refused while a job is running or not yet ingested', async t => {
  const running = world(t, { jobStatus: 'running', ingested: true });
  await assert.rejects(running.team.reopen(23), /running job/);
  const pending = world(t, { jobStatus: 'completed', ingested: false });
  await assert.rejects(pending.team.reopen(23), /not finished or not yet ingested/);
  assert.equal(running.team.s.implemented[23], 1); assert.equal(pending.team.s.implemented[23], 1);
});

test('after reopen the planner plans an implement job for the issue, the audit record is written and no other issue changes', async t => {
  const w = world(t);
  assert.ok(!(await implementsOf(w.team)).includes(23), 'skipped before');
  assert.equal(await w.team.reopen(23), true);
  assert.equal(w.team.s.implemented[23], undefined); assert.equal(w.team.s.implemented[24], 2);
  const [entry] = w.team.s.unblock.log;
  assert.equal(w.team.s.unblock.log.length, 1);
  assert.equal(entry.target, 23); assert.equal(entry.tk, 'issue'); assert.equal(entry.at, 5000); assert.match(entry.what, /reopened/);
  assert.ok((await implementsOf(w.team)).includes(23), 'planned after');
  assert.ok(!(await implementsOf(w.team)).includes(24), 'the other issue stays marked');
  // Persisted: a fresh Team on the same state root sees it.
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.team.dir, 'state.json'), 'utf8')).implemented?.[23], undefined);
});
