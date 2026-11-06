// Issue #630: Foreman's self-check. Each kind of mismatch is found, the safe one is fixed once and logged, an unsafe one raises exactly one
// item (not one per tick), and nothing changes when the records agree. Secret-shaped fixtures are assembled at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selfCheck, applySelfCheck } from '../supervisor/selfcheck.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const HEAD = 'a'.repeat(40), JOB = 'b'.repeat(32), NOW = 10 * 3600000;
const TOKEN = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const base = () => ({ unblock: { flags: {} }, verdicts: {}, secondOpinions: {}, exceptionReviews: {}, refusedReviews: {}, reviewRefusals: {}, reviewAttempts: {}, jobs: {} });
const run = (state, o = {}) => selfCheck({ state, prs: [], issues: [], active: [], now: NOW, ...o });

test('records that agree with GitHub and the running jobs change nothing and raise nothing', () => {
  const s = base();
  s.unblock.flags[7] = { x: { kind: 'ci', at: 0 } };
  s.jobs[JOB] = { kind: 'review', ingested: true, pr: 7, head: HEAD, key: `7:${HEAD}:claude` }; s.verdicts[`7:${HEAD}`] = { verdict: 'PASS' };
  const r = run(s, { prs: [{ number: 7, headRefOid: HEAD, labels: ['needs-homeowner'] }], active: [{ id: JOB, status: 'running' }], aliveById: { [JOB]: true } });
  assert.deepEqual(r, { fixes: [], items: [], covered: [] });
  const before = JSON.stringify(s.unblock), applied = applySelfCheck(s, r, NOW);
  assert.deepEqual(applied, []); assert.equal(JSON.stringify(s.unblock), before); assert.deepEqual(s.selfcheck.log, []);
});

test('a needs-homeowner record whose label is gone is fixed once and logged; a recent record or an unlisted target is left alone', () => {
  const s = base();
  s.unblock.flags[7] = { x: { kind: 'ci', at: 0 } }; s.unblock.flags[8] = { x: { kind: 'ci', at: NOW - 1000 } }; s.unblock.flags[9] = { x: { kind: 'ci', at: 0 } };
  const lists = { prs: [{ number: 7, labels: [] }, { number: 8, labels: [] }], issues: [] };   // 9 is in neither list
  const r = run(s, lists);
  assert.deepEqual(r.fixes.map(f => f.target), [7]);
  assert.equal(applySelfCheck(s, r, NOW).length, 1);
  assert.deepEqual(Object.keys(s.unblock.flags), ['8', '9']);
  assert.equal(s.selfcheck.log.length, 1); assert.match(s.selfcheck.log[0].what, /#7/);
  // The next tick finds nothing and records nothing more.
  assert.deepEqual(applySelfCheck(s, run(s, lists), NOW + 60000), []); assert.equal(s.selfcheck.log.length, 1);
});

test('a job recorded as running with no live process raises one item; a live job, an unknown liveness and a paused job do not', () => {
  const r = run(base(), { active: [{ id: JOB, status: 'running' }, { id: 'c'.repeat(32), status: 'running' }, { id: 'd'.repeat(32), status: 'paused_limit' }], aliveById: { [JOB]: false, ['c'.repeat(32)]: true } });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].id, 'selfcheck-job-bbbbbbbb'); assert.equal(r.items[0].kind, 'job-no-process'); assert.match(r.items[0].action, /reconcile/);
});

test('a finished review with no verdict raises one item only when it is the open head, unexplained and out of attempts', () => {
  const key = `7:${HEAD}:claude`, job = { kind: 'review', ingested: true, pr: 7, head: HEAD, key, refusal: 'verdict_invalid' };
  const mk = () => { const s = base(); s.jobs[JOB] = { ...job }; s.reviewAttempts[key] = 2; return s; };
  const open = [{ number: 7, headRefOid: HEAD, labels: [] }];
  const r = run(mk(), { prs: open });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].id, 'selfcheck-review-7'); assert.equal(r.items[0].ref, 7);
  // Negative controls: each of these explains the missing verdict or leaves the planner a retry.
  assert.equal(run(mk(), { prs: [{ number: 7, headRefOid: 'f'.repeat(40) }] }).items.length, 0, 'head moved on');
  assert.equal(run(mk(), { prs: [] }).items.length, 0, 'pull request not open');
  const withVerdict = mk(); withVerdict.verdicts[`7:${HEAD}`] = {}; assert.equal(run(withVerdict, { prs: open }).items.length, 0);
  const refused = mk(); refused.refusedReviews[`7:${HEAD}`] = {}; assert.equal(run(refused, { prs: open }).items.length, 0);
  const left = mk(); left.reviewAttempts[key] = 1; assert.equal(run(left, { prs: open }).items.length, 0, 'an attempt is left');
  const indep = mk(); indep.jobs[JOB].refusal = 'independence'; assert.equal(run(indep, { prs: open }).items.length, 0, 'already a refused-verdict card');
  const running = mk(); running.jobs[JOB].ingested = false; assert.equal(run(running, { prs: open }).items.length, 0);
});

test('an implemented mark with no pull request is counted but left to the existing stale-mark item', () => {
  const r = run(base(), { stale: { 23: { issue: 23 } } });
  assert.deepEqual(r.covered, [{ kind: 'implemented-no-pr', ref: 23, item: 'stale-mark-23' }]); assert.deepEqual(r.items, []);
});

test('an unsafe item is raised once: it keeps its first-seen time across ticks and disappears when the mismatch does', () => {
  const s = base(), act = { active: [{ id: JOB, status: 'running' }], aliveById: { [JOB]: false } };
  applySelfCheck(s, run(s, act), 1000); applySelfCheck(s, run(s, act), 2000);
  assert.equal(Object.keys(s.selfcheck.items).length, 1); assert.equal(s.selfcheck.items['selfcheck-job-bbbbbbbb'].since, 1000);
  applySelfCheck(s, run(s, {}), 3000);
  assert.deepEqual(s.selfcheck.items, {});
});

test('no secret-shaped text escapes into an item or the log', () => {
  const s = base(), key = `7:${HEAD}:claude`;
  s.jobs[JOB] = { kind: 'review', ingested: true, pr: 7, head: HEAD, key, refusal: `token=${TOKEN}` }; s.reviewAttempts[key] = 2;
  const r = run(s, { prs: [{ number: 7, headRefOid: HEAD, labels: [] }] });
  applySelfCheck(s, r, NOW);
  assert.ok(!JSON.stringify(s.selfcheck).includes(TOKEN)); assert.equal(r.items.length, 1);
});

// The wiring: a real Team tick pass applies the fix, saves it, and exposes the items for the dashboard.
const CFG = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
test('Team.runSelfCheck fixes the stale label record, raises the orphaned job once, saves, and a second run changes nothing', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => [{ number: 7, labels: [], headRefName: 'x', headRefOid: HEAD }], listIssues: async () => [], listMergedPulls: async () => [] };
  const jobs = { listActive: async () => [{ id: JOB, status: 'running' }], get: async id => ({ id, status: 'running' }), alive: async () => false };
  const team = new Team({ config: CFG, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: {}, register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n', clock: { now: () => NOW } });
  team.s.unblock.flags[7] = { x: { kind: 'ci', at: 0 } }; team.save();
  team.view = { prs: await gh.listPulls(), issues: [] };
  const report = {}; await team.runSelfCheck(report);
  assert.equal(report.selfChecked.length, 1); assert.deepEqual(team.selfCheckItems().map(i => i.id), ['selfcheck-job-bbbbbbbb']);
  const saved = JSON.parse(fs.readFileSync(team.file, 'utf8')); assert.deepEqual(saved.unblock.flags, {}); assert.equal(saved.selfcheck.log.length, 1);
  const again = {}; await team.runSelfCheck(again);
  assert.equal(again.selfChecked, undefined); assert.equal(team.selfCheckItems().length, 1); assert.equal(team.s.selfcheck.log.length, 1);
});
