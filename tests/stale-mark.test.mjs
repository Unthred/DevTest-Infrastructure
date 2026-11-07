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

// Issue #597: a later completed ingest clears endedNoPr; a transient stop awaiting its one resume is not surfaced before it.
test('endedNoPr: cleared by a completed ingest; not set for a transient stop that will be resumed once', async t => {
  const w = world(t), id = 'd'.repeat(32), states = {};
  w.team.jobs.get = async i => states[i] || null;
  w.team.jobs.resume = async () => {};
  const entry = () => w.team.s.jobs[id];
  const ingest = async job => { states[id] = { id, ...job }; entry().ingested = false; await w.team.ingestOneInner(id, entry(), { ingested: [] }); };
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '23', issue: 23, ingested: false, at: NOW - 1000 };
  await ingest({ status: 'failed', lastEvent: 'checkpoint_failed' });
  assert.equal(entry().endedNoPr, undefined, 'transient stop, resume still pending: not surfaced yet');
  w.team.s.unblock.resumed[id] = NOW;
  await ingest({ status: 'failed', lastEvent: 'checkpoint_failed' });
  assert.equal(entry().endedNoPr.event, 'checkpoint_failed', 'stopped again after its one resume: surfaced');
  await ingest({ status: 'completed', lastEvent: 'completed' });
  assert.equal(entry().endedNoPr, undefined, 'a later completed ingest clears the stale cause');
  await ingest({ status: 'blocked', lastEvent: 'retry_exhausted' });
  assert.equal(entry().endedNoPr.event, 'retry_exhausted', 'a non-transient stop is surfaced at once');
});

// Issue #660: the ingest-time resumable test matches resumeTransient (7-day window), and a recorded noResume sets the stale cause.
test('endedNoPr: set at ingest for a job outside the resume window; set when resumeTransient records noResume', async t => {
  const w = world(t), id = 'e'.repeat(32), states = {};
  w.team.jobs.get = async i => states[i] || null;
  w.team.jobs.resume = async () => {};
  const entry = () => w.team.s.jobs[id];
  const ingest = async job => { states[id] = { id, ...job }; entry().ingested = false; await w.team.ingestOneInner(id, entry(), { ingested: [] }); };
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '24', issue: 24, ingested: false, at: NOW - 8 * 86400000 };
  await ingest({ status: 'failed', lastEvent: 'checkpoint_failed' });
  assert.equal(entry().endedNoPr.event, 'checkpoint_failed', 'older than the window: never resumed, surfaced at once');
  entry().at = NOW - 1000; delete entry().endedNoPr;
  await ingest({ status: 'failed', lastEvent: 'checkpoint_failed' });
  assert.equal(entry().endedNoPr, undefined, 'inside the window: awaits its resume');
  w.team.gh.listIssues = async () => [];   // the issue is no longer open
  states[id].updatedAt = 0;
  await w.team.resumeTransient({ ingested: [] });
  assert.match(w.team.s.unblock.noResume[id].why, /no longer open/);
  assert.equal(entry().endedNoPr.event, 'checkpoint_failed', 'noResume recorded: stale cause set');
});

// Issue #741: a job deferred until it aged out of the window gets its stale cause from resumeTransient; ingest defers on the same
// predicate as awaitingResume, so an exhausted unblock limit surfaces the cause at once.
test('endedNoPr: set when a deferred job ages out of the window; set at ingest when the unblock limit is exhausted', async t => {
  const w = world(t), id = 'f'.repeat(32), states = {};
  w.team.jobs.get = async i => states[i] || null;
  w.team.jobs.resume = async () => {};
  const entry = () => w.team.s.jobs[id];
  const ingest = async job => { states[id] = { id, ...job }; entry().ingested = false; await w.team.ingestOneInner(id, entry(), { ingested: [] }); };
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '23', issue: 23, ingested: false, at: NOW - 1000 };
  await ingest({ status: 'failed', lastEvent: 'checkpoint_failed', updatedAt: NOW });   // fresh stop: the resume cooldown holds it
  assert.equal(entry().endedNoPr, undefined, 'inside the window: awaits its resume');
  await w.team.resumeTransient({ ingested: [] });
  assert.equal(entry().endedNoPr, undefined, 'still inside the window: nothing recorded');
  entry().at = NOW - 8 * 86400000;
  await w.team.resumeTransient({ ingested: [] });
  assert.equal(entry().endedNoPr.event, 'checkpoint_failed', 'aged out: cause recorded');
  const at = entry().endedNoPr.at; entry().endedNoPr.at = at - 5;
  await w.team.resumeTransient({ ingested: [] });
  assert.equal(entry().endedNoPr.at, at - 5, 'recorded once, not rewritten');
  // negative: a non-implement job, and a completed job, get no cause
  const id2 = 'a1'.repeat(16);
  w.team.s.jobs[id2] = { kind: 'review', agent: 'claude', key: '24', issue: 24, ingested: true, at: NOW - 8 * 86400000 };
  states[id2] = { id: id2, status: 'failed', lastEvent: 'checkpoint_failed' };
  await w.team.resumeTransient({ ingested: [] });
  assert.equal(w.team.s.jobs[id2].endedNoPr, undefined);
  // shared predicate: an exhausted unblock limit means no resume is awaited, so ingest records the cause now
  entry().at = NOW - 1000; delete entry().endedNoPr;
  w.team.s.unblock.pr[23] = 999;
  await ingest({ status: 'failed', lastEvent: 'checkpoint_failed' });
  assert.equal(entry().endedNoPr.event, 'checkpoint_failed');
});

// Issue #826: an aged-out implement job whose record is gone is settled, so it is not looked up on every tick; a job that still exists
// in a non-final status is not settled (it may yet stop).
test('resumeTransient: an aged-out job with a missing record is settled; a running one is not', async t => {
  const w = world(t), gone = 'b1'.repeat(16), live = 'b2'.repeat(16), states = {}, looked = [];
  w.team.jobs.get = async i => { looked.push(i); return states[i] || null; };
  w.team.jobs.resume = async () => {};
  const old = NOW - 8 * 86400000;
  w.team.s.jobs[gone] = { kind: 'implement', agent: 'claude', key: '31', issue: 31, ingested: true, at: old };
  w.team.s.jobs[live] = { kind: 'implement', agent: 'claude', key: '32', issue: 32, ingested: true, at: old };
  states[live] = { id: live, status: 'running' };
  await w.team.resumeTransient({ ingested: [] });
  assert.equal(w.team.s.jobs[gone].settled, true);
  assert.equal(w.team.s.jobs[live].settled, undefined);
  looked.length = 0;
  await w.team.resumeTransient({ ingested: [] });
  assert.ok(!looked.includes(gone), 'the settled job is not looked up again');
  assert.ok(looked.includes(live), 'the running job still is');
});
