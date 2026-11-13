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
const pr = (n, branch, head) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green });
const issue = (n, state = 'OPEN') => ({ number: n, title: `Issue ${n} title here`, state, body: '', labels: [] });
const finished = (provider, kind, tokens, i) => ({ id: String(i).repeat(32), provider, kind, status: 'completed', createdAt: NOW - (i + 1) * HOUR, usage: { inputTokens: tokens, outputTokens: 0 } });

function world(t, { pulls = [], issues = [], budget, roles, allowance, jobRecords = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-planner-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { alerts: [] };
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => issues,
    comment: async () => {}, addLabel: async () => {}, board: async () => {}, listMergedPulls: async () => [], hasComment: async () => false };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'f'.repeat(32) }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: config(budget, roles), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: '## D-020 — x\n- Status: homeowner-approved\n',
    clock: { now: () => NOW }, usage: { allowance, jobs: jobRecords, snapshots: [] }, limitedOf: () => ({ out: false }), timeZone: 'Europe/London', alert: async text => { calls.alerts.push(text); } });
  return { team, calls };
}


const five = (provider, used) => ({ type: provider === 'claude' ? 'five_hour' : 'primary', windowMinutes: 300, utilization: used, resetsAt: NOW + HOUR, status: 'allowed' });
const withShort = (provider, used, short) => { const a = weekly(provider, used, RESET); a.windows.push(five(provider, short)); return a; };
const history = (provider, tokens, from) => [1, 2, 3].map(i => finished(provider, 'implement', tokens, from + i));
const OPEN = [issue(23), issue(5, 'CLOSED'), issue(2), issue(3, 'CLOSED')];
const implementOf = plan => plan.filter(a => a.type === 'implement');
const CAPS = { starting_capacity: { claude: 1e7, codex: 1e7 } };

test('an implement records why this agent was chosen, with every candidate and the rule that decided', async t => {
  const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('claude', 1e6, 0), ...history('codex', 1e5, 10)],
    allowance: { claude: weekly('claude', 0.1, RESET), codex: weekly('codex', 0.1, RESET) } });
  const [act] = implementOf(await w.team.plan());
  assert.equal(act.agent, 'codex', 'the job costs codex 1% of its week and claude 10%');
  assert.equal(act.choice.rule, 'least-plan-cost-for-spare');
  assert.deepEqual(act.choice.candidates.map(c => c.agent), ['claude', 'codex']);
  assert.match(act.why, /^codex runs implement #2: the job costs it least of its plan relative to its spare \(claude: spare [\d.]+%, job about 10% of its week \(history\)/);
  assert.equal(act.choice.candidates[0].freeSlot, true);
});

test('the choice follows the data: swapping which plan is large moves the work with no config change', async t => {
  const run = async (claudeTokens, codexTokens) => {
    const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('claude', claudeTokens, 0), ...history('codex', codexTokens, 10)],
      allowance: { claude: weekly('claude', 0.1, RESET), codex: weekly('codex', 0.1, RESET) } });
    return implementOf(await w.team.plan())[0].agent;
  };
  assert.equal(await run(1e6, 1e5), 'codex');
  assert.equal(await run(1e5, 1e6), 'claude');
});

test('cost history too short: the configured default is used and the reason says so', async t => {
  const w = world(t, { budget: { ...CAPS, choice: { default_shares: { implement: 0.2 } } }, issues: OPEN, jobRecords: [finished('claude', 'implement', 1e5, 1)],
    allowance: { claude: weekly('claude', 0.1, RESET), codex: weekly('codex', 0.1, RESET) } });
  const [act] = implementOf(await w.team.plan());
  assert.match(act.why, /job about 20% of its week \(default\)/);
  assert.match(act.choice.candidates[0].shareNote, /history too short \(1 of 3 implement jobs seen\); configured default share/);
  assert.equal(act.agent, 'claude', 'equal cost and spare: config order');
});

test('a short window that cannot cover the job skips that agent even though the job costs it less', async t => {
  const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('claude', 1e5, 0), ...history('codex', 1e6, 10)],
    allowance: { claude: withShort('claude', 0.1, 0.95), codex: withShort('codex', 0.1, 0.1) } });
  const [act] = implementOf(await w.team.plan());
  assert.equal(act.agent, 'codex');
  assert.match(act.choice.candidates[0].skipped, /short window cannot cover the job/);
});

test('a rising recent rate moves new work to the other agent before its reserve', async t => {
  const jobRecords = [...history('claude', 1e5, 0), ...history('codex', 1e5, 10)];
  const same = { claude: weekly('claude', 0.2, RESET), codex: weekly('codex', 0.2, RESET) };
  assert.equal(implementOf(await world(t, { budget: CAPS, issues: OPEN, jobRecords, allowance: same }).team.plan())[0].agent, 'claude');
  // The same 20% used, but claude got there in 18 hours of its week (about 1.1% an hour) and has 150 hours to go: its projected burn leaves nothing.
  const fast = { claude: weekly('claude', 0.2, NOW + 150 * HOUR), codex: weekly('codex', 0.2, RESET) };
  const [act] = implementOf(await world(t, { budget: CAPS, issues: OPEN, jobRecords, allowance: fast }).team.plan());
  assert.equal(act.agent, 'codex');
  assert.ok(act.choice.candidates[0].rate > 0.01, 'the recent rate is part of the record');
});

test('a preferred pin breaks a tie; a required pin leaves the job to its agent alone', async t => {
  const allowance = { claude: weekly('claude', 0.1, RESET), codex: weekly('codex', 0.1, RESET) };
  const preferred = world(t, { budget: { ...CAPS, choice: { pins: { 2: { agent: 'codex', mode: 'preferred' } } } }, issues: OPEN, allowance });
  const [pick] = implementOf(await preferred.team.plan());
  assert.equal(pick.agent, 'codex');
  assert.equal(pick.choice.rule, 'preferred-pin');
  const required = world(t, { budget: { ...CAPS, choice: { pins: { 23: { agent: 'codex', mode: 'required' } } } }, issues: [issue(23), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED')], allowance });
  assert.deepEqual(implementOf(await required.team.plan()), [], 'issue 23 is pinned to codex, which does not list it: it waits for codex');
});

test('both agents below their reserve start no implement, as before', async t => {
  const w = world(t, { budget: { starting_capacity: { claude: 1e6, codex: 1e6 } }, issues: OPEN,
    jobRecords: [finished('claude', 'review', 1e5, 1), finished('codex', 'review', 1e5, 2)],
    pulls: [pr(40, 'claude/issue-7-x', H(1)), pr(41, 'codex/issue-8-x', H(2))], allowance: { claude: weekly('claude', 0.85, RESET), codex: weekly('codex', 0.85, RESET) } });
  await w.team.tick();
  assert.deepEqual([w.team.s.budget.claude.mode, w.team.s.budget.codex.mode], ['reviews_only', 'reviews_only']);
  assert.deepEqual(implementOf(await w.team.plan()), []);
});

test('the dashboard Next entry and the job record carry the reason', async () => {
  const { nextWhyFields } = await import('../supervisor/holdreason.mjs');
  const { chosenFields } = await import('../supervisor/slotchoice.mjs');
  const act = { type: 'implement', why: 'x runs implement #1: sole', choice: { rule: 'sole-candidate' } };
  assert.deepEqual(nextWhyFields(act, s => s), { why: 'x runs implement #1: sole' });
  assert.deepEqual(chosenFields(act), { choice: act.choice, chosenWhy: act.why });
  assert.deepEqual(chosenFields({ type: 'review' }), {});
});

test('budget.choice is validated: unknown keys, bad shares and pins to unknown agents are refused', async () => {
  const { validateChoiceConfig } = await import('../supervisor/choiceconfig.mjs');
  const names = ['claude', 'codex'];
  assert.doesNotThrow(() => validateChoiceConfig({ min_samples: 3, default_shares: { fix: 0.02 }, pins: { 7: { agent: 'codex', mode: 'required' } } }, names));
  for (const bad of [{ other: 1 }, { min_samples: 0 }, { default_shares: { nothing: 0.1 } }, { default_shares: { fix: 2 } }, { pins: { 7: { agent: 'nobody', mode: 'required' } } }, { pins: { 7: { agent: 'codex', mode: 'maybe' } } }, []]) {
    assert.throws(() => validateChoiceConfig(bad, names), /invalid budget config: choice/, JSON.stringify(bad));
  }
});

test('a tick that starts the job keeps the reason with the job record', async t => {
  const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('claude', 1e6, 0), ...history('codex', 1e5, 10)],
    allowance: { claude: weekly('claude', 0.1, RESET), codex: weekly('codex', 0.1, RESET) } });
  await w.team.tick();
  const started = Object.values(w.team.s.jobs).find(j => j.kind === 'implement');
  assert.ok(started, JSON.stringify(w.team.s.jobs));
  assert.equal(started.agent, 'codex');
  assert.match(started.chosenWhy, /^codex runs implement #2/);
  assert.equal(started.choice.rule, 'least-plan-cost-for-spare');
});
