// Issue #521: an implemented mark whose pull request was closed unmerged is surfaced, never silently skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const NOW = 10 * 3600000, MARKED = NOW - 3600000;
const cfg = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23, 24] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });

function world(t, { open = [], merged = [], closed = [{ number: 411, headRefName: 'claude/issue-23-a', mergedAt: null }], markedAt = MARKED } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { issues: [{ number: 23, title: 'A', state: 'OPEN', body: '', labels: [] }, { number: 24, title: 'B', state: 'OPEN', body: '', labels: [] }], prs: open,
    listPulls: async () => gh.prs, getPull: async () => null, listIssues: async () => gh.issues, board: async () => {}, listMergedPulls: async () => merged,
    listClosedPulls: async () => closed, comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'b'.repeat(32) }) };
  const team = new Team({ config: cfg(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => NOW } });
  team.s.implemented[23] = markedAt; team.save();
  return { gh, team };
}

test('closed unmerged: the mark is reported stale with the closed PR named, and the mark itself is not cleared', async t => {
  const w = world(t);
  await w.team.plan();
  assert.deepEqual(Object.keys(w.team.stale), ['23']);
  assert.deepEqual(w.team.stale[23].prs, [411]);
  assert.match(w.team.staleText(23), /PR #411 closed unmerged/);
  assert.equal(w.team.s.implemented[23], MARKED);
});

test('merged PR: the issue is delivered and never reported stale', async t => {
  const w = world(t, { merged: [{ number: 411, headRefName: 'claude/issue-23-a', closingIssuesReferences: [{ number: 23 }] }], closed: [] });
  await w.team.plan();
  assert.deepEqual(w.team.stale, {});
});

test('reopened (open) PR: not stale, and the report clears itself', async t => {
  const w = world(t);
  await w.team.plan();
  assert.ok(w.team.stale[23]);
  w.gh.prs = [{ number: 412, headRefName: 'claude/issue-23-a', isDraft: false, labels: [], headRefOid: 'a'.repeat(40) }];
  await w.team.plan();
  assert.deepEqual(w.team.stale, {});
  assert.equal(w.team.s.closedUnmerged[23], undefined);
});

test('a fresh mark, an unmarked issue and a live job are not stale; no closed-PR lookup still reports it, without a PR number', async t => {
  const fresh = world(t, { markedAt: NOW - 1000 });
  await fresh.team.plan(); assert.deepEqual(fresh.team.stale, {});
  const live = world(t);
  live.team.s.jobs['c'.repeat(32)] = { kind: 'implement', agent: 'claude', key: '23', issue: 23, ingested: false, at: 1 };
  await live.team.plan(); assert.deepEqual(live.team.stale, {});
  const nolookup = world(t); delete nolookup.gh.listClosedPulls;
  await nolookup.team.plan();
  assert.deepEqual(nolookup.team.stale[23].prs, []);
  assert.match(nolookup.team.staleText(23), /no open or merged pull request/);
});

test('dashboard: Needs you names the issue and the reopen action; the queue and estimate say why it is not next', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-dash-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const cache = { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls: [], issues: [{ number: 23, title: 'A', state: 'OPEN', body: '', labels: [] }, { number: 24, title: 'B', state: 'OPEN', body: '', labels: [] }] };
  const state = { implemented: { 23: MARKED }, closedUnmerged: { 23: [411] } };
  const v = await buildView({ config: cfg(), root, jobs: [], events: [], state, cache, snapshots: [], now: NOW });
  const item = v.attention.find(a => a.id === 'stale-mark-23');
  assert.ok(item); assert.match(item.text, /#23.*PR #411 closed unmerged/); assert.match(item.action, /team reopen 23/);
  const q = Object.values(v.queues).flat().find(x => x.type === 'issue' && x.ref === 23);
  assert.match(q.reason, /^stuck: /); assert.equal(q.next, false);
  const est = v.estimates.items['issue:23'];
  assert.equal(est.status, 'blocked'); assert.match(est.text, /stuck/);
  assert.ok(v.plan.some(a => a.issue === 24), 'the later item starts');
  // not stale for a merged one
  const merged = await buildView({ config: cfg(), root, jobs: [], events: [], state, cache: { ...cache, delivered: [23] }, snapshots: [], now: NOW });
  assert.ok(!merged.attention.some(a => a.id === 'stale-mark-23'));
});
