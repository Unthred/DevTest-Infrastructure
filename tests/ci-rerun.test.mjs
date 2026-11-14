// Issue #1375: a failed CI check is rerun once before a CI fix job is planned; a red main raises one Needs you item.
// Everything goes through Team.tick with a fake GitHub adapter, never through the helpers alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { classify } from '../supervisor/api/attention.mjs';
import { mainCiStatus, ciRerunStats } from '../supervisor/cirerun.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const RUN = 25_000_000_001;
const failedTest = [{ name: 'test', workflowName: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-13T19:30:00Z', completedAt: '2026-11-13T19:44:00Z', detailsUrl: `https://github.com/o/r/actions/runs/${RUN}/job/1` }];
const greenTest = [{ ...failedTest[0], conclusion: 'SUCCESS', startedAt: '2026-11-13T20:00:00Z', completedAt: '2026-11-13T20:10:00Z' }];
const scanner = [{ name: 'GitGuardian Security Checks', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-13T19:30:00Z', completedAt: '2026-11-13T19:31:00Z', detailsUrl: 'https://dashboard.gitguardian.com/x' }];
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2, cancelled_wait_ms: 0, unblock: { per_pr: 6, per_day: 20, cooldown_ms: 0 } },
  models: { agents: { claude: { fix: { model: 'sonnet' }, 'ci-fix': { model: 'sonnet' }, strong: { model: 'opus' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
});
const pr = (rollup, head = H(1)) => ({ number: 1309, title: 't', headRefName: 'claude/issue-23-x', headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: rollup });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';

function world(t, { rollup = failedTest, rerun = async () => {}, mainRuns = async () => [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cirerun-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { reruns: [], created: [], mainReads: 0 }, clock = { t: 1_000_000, now: () => clock.t };
  const gh = {
    pulls: [pr(rollup)], issues: [{ number: 23, title: 'Issue 23 title', state: 'CLOSED', body: '', labels: [] }],
    listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues,
    rerunFailedJobs: async r => { calls.reruns.push(r); await rerun(r); }, comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {},
    hasComment: async () => false, findIssueByMarker: async () => null, issueComments: async () => [{ association: 'OWNER', body: '' }],
    merge: async () => {}, board: async () => {}, listMergedPulls: async () => [], mainCheckRuns: async () => { calls.mainReads++; return mainRuns(); },
  };
  const jobs = { seq: 0, states: {}, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued' }; return { id }; }, resume: async () => {} };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock, alert: async () => {} });
  return { dir, gh, team, calls, clock };
}
const cifix = r => r.actions.some(a => a.type === 'cifix');

test('valid: red, one rerun of the failed jobs, no CI fix; green rerun records an unreliable failure with the job name', async t => {
  const w = world(t);
  let r = await w.team.tick();
  assert.deepEqual(w.calls.reruns, [String(RUN)], 'the failed run was rerun');
  assert.equal(cifix(r), false, 'no CI fix while the rerun runs');
  assert.equal(w.team.ciState(w.gh.pulls[0]), 'pending', 'the pull request counts as waiting for CI');
  w.clock.t += 30_000; r = await w.team.tick();
  assert.deepEqual(w.calls.reruns, [String(RUN)], 'a second tick while the rerun runs requests no second rerun');
  assert.equal(cifix(r), false);
  w.clock.t += 60_000; w.gh.pulls[0] = pr(greenTest);
  r = await w.team.tick();
  assert.equal(cifix(r), false, 'a green rerun plans no CI fix');
  const rec = w.team.s.ciRerun[`1309:${H(1)}`];
  assert.equal(rec.result, 'unreliable'); assert.deepEqual(rec.jobs, ['test']);
  assert.deepEqual(ciRerunStats(w.team.s), { requested: 1, unreliable: 1, real: 0, requestFailed: 0 });
});

test('boundary: red then red plans exactly one CI fix and never reruns the head again', async t => {
  const w = world(t);
  await w.team.tick();
  w.clock.t += 120_000;
  let r = await w.team.tick();
  assert.equal(r.actions.filter(a => a.type === 'cifix').length, 1, 'exactly one CI fix');
  assert.equal(w.team.s.ciRerun[`1309:${H(1)}`].result, 'real');
  r = await w.team.tick();
  assert.deepEqual(w.calls.reruns, [String(RUN)], 'one rerun per head');
  assert.equal(ciRerunStats(w.team.s).real, 1);
});

test('a new head that fails gets its own single rerun', async t => {
  const w = world(t);
  await w.team.tick(); w.clock.t += 120_000; await w.team.tick();
  w.gh.pulls[0] = pr(failedTest, H(2)); w.clock.t += 1000;
  const r = await w.team.tick();
  assert.equal(w.calls.reruns.length, 2); assert.equal(cifix(r), false);
});

test('invalid: the rerun request fails, so the CI fix is planned as today and the failure is logged', async t => {
  const w = world(t, { rerun: async () => { throw new Error('HTTP 403'); } });
  const r = await w.team.tick();
  assert.equal(cifix(r), true, 'the CI fix is planned');
  assert.match(JSON.stringify(r.warnings), /rerun of the failed CI jobs on PR #1309 could not be requested: HTTP 403/);
  await w.team.tick();
  assert.equal(w.calls.reruns.length, 1, 'not repeated');
  assert.equal(ciRerunStats(w.team.s).requestFailed, 1);
});

test('scanner-only failures keep their handling: no rerun', async t => {
  const w = world(t, { rollup: scanner });
  await w.team.tick();
  assert.deepEqual(w.calls.reruns, []);
});

test('a red check with no run to rerun plans the CI fix as today', async t => {
  const noUrl = [{ ...failedTest[0], detailsUrl: undefined }];
  const w = world(t, { rollup: noUrl });
  assert.equal(cifix(await w.team.tick()), true);
  assert.deepEqual(w.calls.reruns, []);
});

// The failed run on main of 13 Nov 2026 19:44 UTC, at the merge of PR #1309.
const MERGE_1309 = '5d9b4e3e5e8e0c83b3dde62b63f727170b6d40a2';
const mainRed = [{ name: 'test', status: 'completed', conclusion: 'failure', head_sha: MERGE_1309, completed_at: '2026-11-13T19:44:00Z' }];
const mainGreen = [{ name: 'test', status: 'completed', conclusion: 'success', head_sha: H(9), completed_at: '2026-11-13T20:30:00Z' }];

async function needsYou(w) {
  const v = await buildView({ config: config(), root: w.dir, jobs: [], events: [], state: w.team.s, cache: { pulls: [], issues: [] }, snapshots: [], now: w.clock.t + 1000, register: REGISTER });
  return v.panels.needsYou.filter(i => i.id === 'main-ci-red');
}

test('main: a failed newest run raises one item naming commit, job and time; a later green run clears it', async t => {
  let runs = mainRed;
  const w = world(t, { rollup: greenTest, mainRuns: async () => runs });
  w.gh.pulls = [];
  await w.team.tick(); await w.team.tick();
  assert.equal(w.calls.mainReads, 2, 'one read per tick');
  const items = await needsYou(w);
  assert.equal(items.length, 1, 'raised once');
  assert.match(items[0].text, /5d9b4e3.*test.*2026-11-13 19:44 UTC/);
  const c = classify(items[0], []);
  assert.equal(c.attention, 'fault'); assert.equal(c.actions[0].refusal_code, 'not_built', 'the rerun control is listed as not built');
  runs = [{ ...mainRed[0], status: 'in_progress', conclusion: null, head_sha: H(9) }];
  await w.team.tick();
  assert.equal((await needsYou(w)).length, 1, 'a run still in progress does not clear it');
  runs = mainGreen;
  await w.team.tick();
  assert.equal((await needsYou(w)).length, 0, 'a later green run clears it');
});

test('main: a failed read of main is logged and raises nothing', async t => {
  const w = world(t, { rollup: greenTest, mainRuns: async () => { throw new Error('boom'); } });
  const r = await w.team.tick();
  assert.match(JSON.stringify(r.warnings), /main's CI status could not be read/);
  assert.equal((await needsYou(w)).length, 0);
});

test('mainCiStatus: cancelled runs are not a failure and an empty list is pending', () => {
  assert.equal(mainCiStatus([]).state, 'pending');
  assert.equal(mainCiStatus([{ name: 'x', status: 'completed', conclusion: 'cancelled', head_sha: H(1) }]).state, 'green');
});

test('an unreliable failure outlasts the closing pull request: the Activity log names the job and the dashboard counts it', async t => {
  const w = world(t);
  await w.team.tick();
  w.clock.t += 60_000;
  w.gh.pulls[0] = pr(greenTest);
  await w.team.tick();
  w.gh.pulls = [];
  w.clock.t += 1000;
  await w.team.tick();
  assert.deepEqual(w.team.s.ciRerun, {}, 'the per-head record is dropped with the pull request');
  const entry = w.team.s.unblock.log.find(e => /unreliable CI failure on PR #1309: test/.test(e.what));
  assert.ok(entry, 'the outcome is kept in the Activity log with the failed job name');
  const v = await buildView({ config: config(), root: w.dir, jobs: [], events: [], state: w.team.s, cache: { pulls: [], issues: [] }, snapshots: [], now: w.clock.t + 1000, register: REGISTER });
  assert.deepEqual(v.robustness.ciReruns, { requested: 1, unreliable: 1, real: 0, requestFailed: 0 });
});
