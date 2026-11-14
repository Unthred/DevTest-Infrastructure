// Issue #1407: a parked pull request is not counted in any reserve and no job is planned for it, in the real Team budgets() and plan(),
// and in the plan view the dashboard builds from the cache the tick writes. The data is PR #1139: parked, CHANGES, 4 fix rounds at a limit of 3.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { HOUR } from '../supervisor/budget.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { compactPulls } from '../supervisor/dashdata.mjs';
import { unparkedPulls, parkedPullList } from '../supervisor/parkedpr.mjs';

const RESET = Date.parse('2026-11-14T07:18:00Z');
const NOW = RESET - 72 * HOUR;
const H = n => String(n).repeat(40).slice(0, 40);
const weekly = (provider, used) => ({ provider, status: 'allowed', observedAt: NOW, billing: {},
  windows: [{ type: provider === 'claude' ? 'seven_day' : 'secondary', windowMinutes: 10080, utilization: used, resetsAt: RESET, status: 'allowed' }] });
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 3 },
  budget: { starting_capacity: { codex: 110.6e6, claude: 1e9 } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr1139 = (labels, extra = {}) => ({ number: 1139, title: 't', headRefName: 'codex/issue-1100-x', headRefOid: H(1), baseRefName: 'main', isDraft: false,
  labels, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], ...extra });
const finished = (kind, tokens, i) => ({ id: String(i).repeat(32), provider: 'codex', kind, status: 'completed', createdAt: NOW - (i + 1) * HOUR, usage: { inputTokens: tokens, outputTokens: 0 } });
const usage = () => ({ allowance: { codex: weekly('codex', 0.46), claude: weekly('claude', 0.1) }, jobs: [finished('fix', 3e6, 1), finished('review', 1e6, 2)], snapshots: [] });

function world(t, pulls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parked-pr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => [], comment: async () => {},
    addLabel: async () => {}, board: async () => {}, listMergedPulls: async () => [], hasComment: async () => false };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'f'.repeat(32) }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: '## D-020 — x\n- Status: homeowner-approved\n',
    clock: { now: () => NOW }, usage: usage(), limitedOf: () => ({ out: false }), timeZone: 'Europe/London', alert: async () => {} });
  team.s.fixAttempts['1139:' + H(1)] = 4;
  team.s.verdicts['1139:' + H(1)] = { verdict: 'CHANGES', reviewer: 'claude' };
  return { team, dir };
}
const planned = plan => plan.filter(a => a.pr === 1139);

test('valid: the real plan() and budgets() give a parked PR no action and no reserve', async t => {
  const { team } = world(t, [pr1139(['needs-homeowner', 'parked'])]);
  const plan = await team.plan();
  assert.deepEqual(planned(plan), []);
  assert.equal(team.budgets().codex.capacity.openPrs, 0);
  assert.match(team.budgets().codex.capacity.text, /for 0 open pull requests/);
});

test('boundary: the same PR without the parked label is counted and a rebase is planned', async t => {
  const { team } = world(t, [pr1139(['needs-homeowner'])]);
  const plan = await team.plan();
  assert.ok(planned(plan).some(a => a.type === 'rebase'), JSON.stringify(plan));
  assert.equal(team.budgets().codex.capacity.openPrs, 1);
});

test('boundary: a parked PR with green checks and a PASS is not merged', async t => {
  const { team } = world(t, [pr1139(['parked'], { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })]);
  team.s.verdicts['1139:' + H(1)] = { verdict: 'PASS', reviewer: 'claude' };
  assert.deepEqual(planned(await team.plan()), []);
});

test('invalid: a pull request row with no labels field is unparked and nothing throws', async t => {
  const row = pr1139(undefined); delete row.labels;
  const { team } = world(t, [row]);
  assert.ok(planned(await team.plan()).length > 0);
  assert.equal(team.budgets().codex.capacity.openPrs, 1);
  assert.deepEqual(unparkedPulls([row]), [row]);
  assert.deepEqual(parkedPullList([row]), []);
});

test('the dashboard cache keeps the parked label and the plan view shows no action, no next job and no idle text for it', async t => {
  const { dir } = world(t, []);
  const cache = { tick: { at: NOW, status: 'ok', lastOkAt: NOW }, pulls: compactPulls([pr1139(['needs-homeowner', 'parked', 'other'])]), issues: [] };
  assert.deepEqual(cache.pulls[0].labels, ['needs-homeowner', 'parked']);
  const state = { jobs: {}, fixAttempts: { ['1139:' + H(1)]: 4 }, verdicts: { ['1139:' + H(1)]: { verdict: 'CHANGES', reviewer: 'claude' } } };
  const view = await buildView({ config: config(), root: dir, jobs: [], events: [], state, cache, snapshots: [], now: NOW });
  assert.deepEqual(planned(view.plan), []);
  assert.deepEqual(view.parked.map(p => p.pr), [1139]);
  assert.match(view.parked[0].reason, /^parked/);
  assert.equal(view.panels.next.length, 0);
  for (const a of view.agents) assert.doesNotMatch(a.idleReason?.text || '', /1139/);
  const entries = Object.values(view.queues).flat().filter(e => e.ref === 1139);
  assert.ok(entries.every(e => e.type === 'pr' && e.next !== true && /^parked/.test(e.reason)), JSON.stringify(entries));
});

test('unparking makes the PR plannable again on the next tick', async t => {
  const pulls = [pr1139(['parked'])];
  const { team } = world(t, pulls);
  assert.deepEqual(planned(await team.plan()), []);
  pulls[0] = pr1139([]);
  assert.ok(planned(await team.plan()).some(a => a.type === 'rebase'));
  assert.equal(team.budgets().codex.capacity.openPrs, 1);
});
