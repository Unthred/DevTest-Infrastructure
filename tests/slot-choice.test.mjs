// Issue #1346: the dispatcher chooses the agent for implement and repair slots with the choice core. Every test goes through the real Team plan()
// (or tick()) with synthetic agent names over the real providers, so a name and provider mix up is caught.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { HOUR, validateBudgetConfig } from '../supervisor/budget.mjs';
import { validateChoiceConfig } from '../supervisor/choiceconfig.mjs';
import { chosenFields } from '../supervisor/slotchoice.mjs';

const RESET = Date.parse('2026-11-04T07:18:00Z');
const NOW = RESET - 72 * HOUR;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const failing = [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'ci' }];
const H = n => String(n).repeat(40).slice(0, 40);
const PROVIDER = { big: 'claude', small: 'codex' };
const weekly = (agent, used, resetsAt = RESET) => ({ provider: PROVIDER[agent], status: 'allowed', observedAt: NOW, billing: {},
  windows: [{ type: PROVIDER[agent] === 'claude' ? 'seven_day' : 'secondary', windowMinutes: 10080, utilization: used, resetsAt, status: 'allowed' }] });
const config = (budget, roles) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 }, budget,
  agents: { big: { provider: 'claude', branch_prefix: 'big/', issues: [23, 5] }, small: { provider: 'codex', branch_prefix: 'small/', issues: [2, 3] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, branch, head, rollup = green) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: rollup });
const issue = (n, state = 'OPEN') => ({ number: n, title: `Issue ${n} title here`, state, body: '', labels: [] });
const finished = (agent, kind, tokens, i) => ({ id: String(i).repeat(32), provider: PROVIDER[agent], kind, status: 'completed', createdAt: NOW - (i + 1) * HOUR, usage: { inputTokens: tokens, outputTokens: 0 } });
// The allowance record is keyed by provider, as the tick's planning inputs key it; the dashboard snapshots are keyed by agent name.
const allowanceOf = byAgent => Object.fromEntries(Object.entries(byAgent).map(([agent, record]) => [PROVIDER[agent], record]));

function world(t, { pulls = [], issues = [], budget = {}, roles = { implementer: 1, reviewer: 1 }, allowance, jobRecords = [], snapshots = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-choice-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => issues,
    comment: async () => {}, addLabel: async () => {}, board: async () => {}, listMergedPulls: async () => [], hasComment: async () => false };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'f'.repeat(32) }) };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: config(budget, roles), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: '## D-020 — x\n- Status: homeowner-approved\n',
    clock: { now: () => NOW }, usage: { allowance: allowanceOf(allowance), jobs: jobRecords, snapshots }, limitedOf: () => ({ out: false }), timeZone: 'Europe/London', alert: async () => {} });
  return { team };
}

const five = (agent, used) => ({ type: PROVIDER[agent] === 'claude' ? 'five_hour' : 'primary', windowMinutes: 300, utilization: used, resetsAt: NOW + HOUR, status: 'allowed' });
const withShort = (agent, used, short) => { const a = weekly(agent, used); a.windows.push(five(agent, short)); return a; };
const history = (agent, tokens, from) => [1, 2, 3].map(i => finished(agent, 'implement', tokens, from + i));
const OPEN = [issue(23), issue(5, 'CLOSED'), issue(2), issue(3, 'CLOSED')];
const ONLY_23 = [issue(23), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED')];
const implementOf = plan => plan.filter(a => a.type === 'implement');
const CAPS = { starting_capacity: { big: 1e7, small: 1e7 } };
const both = (used = 0.1) => ({ big: weekly('big', used), small: weekly('small', used) });

test('an implement records why this agent was chosen, with every candidate and the rule that decided', async t => {
  const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('big', 1e6, 0), ...history('small', 1e5, 10)], allowance: both() });
  const [act] = implementOf(await w.team.plan());
  assert.equal(act.agent, 'small', 'the job costs small 1% of its week and big 10%');
  assert.equal(act.choice.rule, 'least plan cost');
  assert.deepEqual(act.choice.candidates.map(c => c.id), ['big', 'small']);
  assert.match(act.why, /^small chosen by least plan cost\. big: spare [\d.]+%; expected share 10%/);
});

test('the choice follows the data: swapping which plan is large moves the work with no config change', async t => {
  const run = async (bigTokens, smallTokens) => {
    const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('big', bigTokens, 0), ...history('small', smallTokens, 10)], allowance: both() });
    return implementOf(await w.team.plan())[0].agent;
  };
  assert.equal(await run(1e6, 1e5), 'small');
  assert.equal(await run(1e5, 1e6), 'big');
});

test('cost history too short: the configured default is used and the reason says so', async t => {
  const w = world(t, { budget: { ...CAPS, choice: { default_shares: { implement: 0.2 } } }, issues: OPEN, jobRecords: [finished('big', 'implement', 1e5, 1)], allowance: both() });
  const [act] = implementOf(await w.team.plan());
  assert.match(act.why, /expected share 20%; history too short \(1 of 3 implement jobs seen\); configured default share/);
  assert.equal(act.agent, 'big', 'equal cost and spare: config order');
});

test('a short window that cannot cover the job skips that agent even though the job costs it less', async t => {
  const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('big', 1e5, 0), ...history('small', 1e6, 10)],
    allowance: { big: withShort('big', 0.1, 0.95), small: withShort('small', 0.1, 0.1) } });
  const [act] = implementOf(await w.team.plan());
  assert.equal(act.agent, 'small');
  assert.match(act.choice.candidates[0].skipped, /short window cannot cover the job/);
});

test('an agent named unlike its provider gets the same recent rate', async t => {
  // The newest reading is the provider's record; the earlier readings are the agent's snapshots. A lookup by agent name finds no newest reading.
  const earlier = { allowance: { big: { ...weekly('big', 0.05), observedAt: NOW - 1.5 * HOUR } } };
  const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('big', 1e5, 0), ...history('small', 1e5, 10)], allowance: both(0.2), snapshots: [earlier] });
  const [act] = implementOf(await w.team.plan());
  const big = act.choice.candidates.find(c => c.id === 'big');
  assert.ok(Math.abs(big.recentRate - 0.1) < 1e-6, `15 points in 1.5 hours is 10% an hour, got ${big.recentRate}`);
});

test('work is conserved: an unfilled job holds only its own group', async t => {
  // Round 1 probe of PR #1278: big has a red CI pull request #40 with its short window at 97%; small has room and its own implement for issue #2.
  const red = pr(40, 'big/issue-7-x', H(1), failing);
  const w = world(t, { budget: CAPS, issues: OPEN, pulls: [red], jobRecords: [...history('big', 1e5, 0), ...history('small', 1e5, 10)],
    allowance: { big: withShort('big', 0.1, 0.97), small: withShort('small', 0.1, 0.1) } });
  const plan = await w.team.plan();
  const [started] = implementOf(plan);
  assert.equal(started?.agent, 'small');
  assert.equal(started.issue, 2);
  assert.equal(plan.some(a => a.type === 'cifix'), false, 'the repair that no short window covers waits');
  assert.match(w.team.held.big.cifix, /^job waits: no candidate qualifies/);
  assert.ok(!/job waits/.test(w.team.held.small?.implement || ''), 'no false hold reason on the job that runs');
});

test('jobs planned earlier in the tick are charged to the agent before the next slot is chosen', async t => {
  // big has 10% of its short window left and each job needs about 7% of it: the second job must not also go to big.
  const w = world(t, { budget: CAPS, issues: [issue(23), issue(5), issue(2), issue(3, 'CLOSED')], roles: { implementer: 3, reviewer: 1 },
    jobRecords: [...history('big', 1e5, 0), ...history('small', 2e5, 10)], allowance: { big: withShort('big', 0.1, 0.9), small: withShort('small', 0.1, 0.1) } });
  const starts = implementOf(await w.team.plan());
  assert.ok(starts.filter(a => a.agent === 'big').length <= 1, 'big short room covers one job of about 7%');
  assert.ok(starts.some(a => a.agent === 'small'), 'the rest of the work goes to the agent with room');
});

test('a preferred pin breaks a tie', async t => {
  const budget = { ...CAPS, choice: { pins: { 2: { agent: 'small', mode: 'preferred' } } } };
  const [pick] = implementOf(await world(t, { budget, issues: OPEN, allowance: both() }).team.plan());
  assert.equal(pick.agent, 'small');
  assert.equal(pick.choice.rule, 'preferred pin');
});

test('a required pin brings the issue to its agent', async t => {
  const budget = { ...CAPS, choice: { pins: { 23: { agent: 'small', mode: 'required' } } } };
  const [pinned] = implementOf(await world(t, { budget, issues: ONLY_23, allowance: both() }).team.plan());
  assert.equal(pinned?.issue, 23, 'small does not list issue 23 but is offered it by the pin');
  assert.equal(pinned.agent, 'small');
  assert.equal(pinned.choice.rule, 'required pin');
});

test('a required pin waits when its agent has no free slot, and no other agent takes the job', async t => {
  const budget = { ...CAPS, choice: { pins: { 23: { agent: 'small', mode: 'required' } } } };
  const w = world(t, { budget, issues: ONLY_23, allowance: both() });
  w.team.providerSlotFull = provider => provider === 'codex';
  assert.deepEqual(implementOf(await w.team.plan()), []);
  assert.match(w.team.held.big.implement, /small: .*skipped: no free slot/);
});

test('both agents below their reserve start no implement, but a review and a cifix still run', async t => {
  const reviewed = pr(40, 'big/issue-7-x', H(1));
  const red = pr(41, 'small/issue-8-x', H(2), failing);
  const w = world(t, { budget: { starting_capacity: { big: 1e6, small: 1e6 } }, issues: OPEN, pulls: [reviewed, red],
    jobRecords: [finished('big', 'review', 1e5, 1), finished('small', 'review', 1e5, 2)], allowance: both(0.85) });
  const plan = await w.team.plan();
  assert.deepEqual(implementOf(plan), []);
  assert.ok(plan.some(a => a.type === 'review' && a.pr === 40), 'the review runs');
  assert.ok(plan.some(a => a.type === 'cifix' && a.pr === 41), 'the repair of its own pull request runs');
});

test('an agent with no known allowance still takes work in the dispatcher order', async t => {
  const w = world(t, { issues: OPEN, allowance: {} });
  const [act] = implementOf(await w.team.plan());
  assert.ok(act, 'unknown data never holds work back');
  assert.equal(act.choice, undefined, 'no choice was made, so none is recorded');
});

test('a tick that starts the job keeps the reason with the job record', async t => {
  const w = world(t, { budget: CAPS, issues: OPEN, jobRecords: [...history('big', 1e6, 0), ...history('small', 1e5, 10)], allowance: both() });
  await w.team.tick();
  const started = Object.values(w.team.s.jobs).find(j => j.kind === 'implement');
  assert.ok(started, JSON.stringify(w.team.s.jobs));
  assert.equal(started.agent, 'small');
  assert.match(started.chosenWhy, /^small chosen by least plan cost/);
  assert.equal(started.choice.rule, 'least plan cost');
});

test('reviews keep their own reason and carry no choice record', async t => {
  const w = world(t, { budget: CAPS, issues: [], pulls: [pr(40, 'big/issue-7-x', H(1))], allowance: both() });
  const review = (await w.team.plan()).find(a => a.type === 'review');
  assert.equal(review.agent, 'small');
  assert.equal(review.choice, undefined);
  assert.match(review.why, /has the most spare allowance|only reviewer/);
  assert.deepEqual(chosenFields(review), {});
});

test('valid: an absent or well formed choice config loads', () => {
  const names = ['big', 'small'];
  assert.doesNotThrow(() => validateBudgetConfig({}, names));
  assert.doesNotThrow(() => validateBudgetConfig({ choice: { min_samples: 3, short_per_weekly: 5, default_shares: { fix: 0.02 }, pins: { 7: { agent: 'small', mode: 'required' } } } }, names));
});

test('invalid: a malformed choice config and a pin to an unknown agent are refused with a reason', () => {
  const names = ['big', 'small'];
  const refused = [
    [[], /must be an object/], [{ other: 1 }, /unknown key other/], [{ min_samples: 0 }, /min_samples/], [{ short_per_weekly: 0 }, /short_per_weekly/],
    [{ default_shares: { nothing: 0.1 } }, /default_shares\.nothing/], [{ default_shares: { fix: 2 } }, /default_shares\.fix/],
    [{ pins: { 7: { agent: 'nobody', mode: 'required' } } }, /pins\.7 names an unknown agent/], [{ pins: { 7: { agent: 'small', mode: 'maybe' } } }, /pins\.7 mode/],
    [{ pins: { seven: { agent: 'small', mode: 'required' } } }, /pins\.seven must be named by issue number/],
  ];
  for (const [bad, reason] of refused) {
    assert.throws(() => validateChoiceConfig(bad, names), reason, JSON.stringify(bad));
    assert.throws(() => validateBudgetConfig({ choice: bad }, names), /invalid budget config: choice/, JSON.stringify(bad));
  }
});
