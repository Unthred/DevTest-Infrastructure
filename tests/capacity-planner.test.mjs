// Issue #1116, review round: the capacity rules through the real dispatcher (tick and plan), not only the pure functions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { HOUR } from '../supervisor/budget.mjs';
import { resolveModel } from '../supervisor/models.mjs';

const RESET = Date.parse('2026-11-04T07:18:00Z');
const NOW = RESET - 72 * HOUR;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const H = n => String(n).repeat(40).slice(0, 40);
const weekly = (provider, used, resetsAt) => ({ provider, status: 'allowed', observedAt: NOW, billing: {},
  windows: [{ type: provider === 'claude' ? 'seven_day' : 'secondary', windowMinutes: 10080, utilization: used, resetsAt, status: 'allowed' }] });
const config = (budget = {}, roles = { implementer: 1, reviewer: 1 }) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 }, budget,
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, branch, head) => ({
  number: n,
  title: `t${n}`,
  headRefName: branch,
  headRefOid: head,
  baseRefName: 'main',
  isDraft: false,
  mergeable: 'MERGEABLE',
  statusCheckRollup: green
});
const issue = (n, state = 'OPEN') => ({ number: n, title: `Issue ${n} title here`, state, body: '', labels: [] });
const finished = (provider, kind, tokens, i) => ({
  id: String(i).repeat(32),
  provider,
  kind,
  status: 'completed',
  createdAt: NOW - (i + 1) * HOUR,
  usage: { inputTokens: tokens, outputTokens: 0 }
});

function world(t, { pulls = [], issues = [], budget, roles, allowance, jobRecords = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-planner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { alerts: [] };
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => issues,
    comment: async () => {}, addLabel: async () => {}, board: async () => {}, listMergedPulls: async () => [], hasComment: async () => false };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'f'.repeat(32) }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({
    config: config(budget, roles),
    root: stateRoot(path.join(dir, 'state')),
    gh,
    jobs,
    git,
    register: '## D-020 — x\n- Status: homeowner-approved\n',
    clock: { now: () => NOW },
    usage: { allowance, jobs: jobRecords, snapshots: [] },
    limitedOf: () => ({ out: false }),
    timeZone: 'Europe/London',
    alert: async text => { calls.alerts.push(text); }
  });
  return { team, calls };
}

test('the tick records, alerts and latches a reserve that counts the open pull requests', async t => {
  const records = [finished('claude', 'review', 100000, 1), finished('claude', 'fix', 100000, 2)];
  const w = world(t, { budget: { starting_capacity: { claude: 1e6, codex: 1e7 } }, jobRecords: records,
    pulls: [pr(40, 'claude/issue-7-x', H(1)), pr(41, 'claude/issue-8-x', H(2))],
    issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED')],
    allowance: { claude: weekly('claude', 0.6, RESET), codex: weekly('codex', 0.1, RESET) } });
  await w.team.tick();
  assert.equal(w.team.s.budget.claude.mode, 'reviews_only', 'two open PRs reserve 400k + 50k margin; 400k is left');
  assert.equal(w.team.s.budget.claude.rule, 'high-water');
  assert.ok(w.calls.alerts.some(a => /claude: reviews only/.test(a)), JSON.stringify(w.calls.alerts));
});

test('at or below the reserve in the last day: the agent starts no implement work and its ready issue goes to the agent with capacity', async t => {
  const closeReset = NOW + 10 * HOUR;
  const w = world(t, {
    budget: { starting_capacity: { claude: 1e6, codex: 1e7 } },
    issues: [issue(23), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED')],
    allowance: { claude: weekly('claude', 0.97, closeReset), codex: weekly('codex', 0.1, closeReset) } });
  assert.equal((await w.team.plan()).length > 0, true, 'codex takes the issue');
  const plan = await w.team.plan();
  const taken = plan.find(a => a.type === 'implement');
  assert.equal(taken.agent, 'codex');
  assert.equal(taken.reassignedFrom, 'claude');
  assert.equal(w.team.modes.claude.mode, 'normal', 'the mode is not reviews-only inside the last day');
  assert.match(w.team.ownerOut('claude').why, /no new implement work/);
});

test('a contested implementer slot goes to the agent with more remaining capacity, not to config order', async t => {
  const w = world(t, { budget: { starting_capacity: { claude: 1e6, codex: 1e7 } }, issues: [issue(23), issue(5, 'CLOSED'), issue(2), issue(3, 'CLOSED')],
    allowance: { claude: weekly('claude', 0.5, RESET), codex: weekly('codex', 0.5, RESET) } });
  const plan = await w.team.plan();
  const impl = plan.filter(a => a.type === 'implement');
  assert.equal(impl.length, 1, 'one implementer slot');
  assert.equal(impl[0].agent, 'codex');
});

test('model choice follows remaining capacity: the same percentage keeps the cheap model on the small plan only', async t => {
  const records = [
    finished('claude', 'review', 100000, 1),
    finished('claude', 'fix', 100000, 2),
    finished('codex', 'review', 100000, 3),
    finished('codex', 'fix', 100000, 4)
  ];
  const w = world(t, {
    budget: { starting_capacity: { claude: 1e6, codex: 1e8 } },
    jobRecords: records,
    pulls: [pr(40, 'claude/issue-7-x', H(1)), pr(41, 'claude/issue-8-x', H(2))],
    issues: [], allowance: { claude: weekly('claude', 0.5, RESET), codex: weekly('codex', 0.5, RESET) } });
  await w.team.plan();
  const { lowOnCapacity } = await import('../supervisor/capacity.mjs');
  assert.equal(lowOnCapacity(w.team.modes.claude.capacity), true, '500k left against a 450k reserve');
  assert.equal(lowOnCapacity(w.team.modes.codex.capacity), false, '50M left on a 100M plan is not low at the same 50%');
  assert.equal(lowOnCapacity(null), null, 'unknown capacity keeps the percentage threshold');
  const models = { allowance_threshold: 0.8, agents: { codex: { review: { model: 'big' }, implement: { model: 'big' } } } };
  const pick = capacityLow => resolveModel({
    modelsConfig: models,
    agent: 'codex',
    kind: 'review',
    manifestModels: undefined,
    escalation: null,
    utilization: 0.9,
    reReview: false,
    low: false,
    capacityLow
  });
  assert.match(pick(false).fields.modelReason, /configured|keeps/, 'capacity says not low: the 90% percentage no longer decides');
  assert.match(pick(true).fields.modelReason, /remaining capacity within twice the reserve/);
});
