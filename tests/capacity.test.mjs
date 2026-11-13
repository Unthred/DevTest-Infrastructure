// Issue #1116: allowance in real capacity. Pure functions over plain data, plus the budget rule and the planner invariant that call them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkUsage, learnCapacity, summarise, headroomScores, capacitySamples, projectedNeed, capacityFor, ALLOWANCE_DEFAULTS } from '../supervisor/capacity.mjs';
import { assessAgent, admits, validateBudgetConfig, DEFAULT_BUDGET, HOUR, REVIEWS_ONLY_TYPES } from '../supervisor/budget.mjs';

const WEEK = 7 * 24 * HOUR;
const T0 = Date.parse('2026-11-02T00:00:00Z');
// A finished job that spent `tokens` and recorded the weekly reading `used` of the window that resets at `resetsAt`.
const job = (kind, tokens, used, at, resetsAt) => ({ kind, provider: 'p', createdAt: at, usage: { inputTokens: tokens, outputTokens: 0 },
  allowance: { observedAt: at, windows: [{ type: 'seven_day', utilization: used, resetsAt, status: 'allowed' }] } });
// Two weekly windows in which every 10% of the week cost `perTenth` tokens: three jobs per window (the first one only sets the baseline).
const history = perTenth => [0, 1].flatMap(w => {
  const resetsAt = T0 + (w + 1) * WEEK, base = T0 + w * WEEK;
  return [job('implement', 1, 0.05, base + HOUR, resetsAt), job('implement', perTenth, 0.15, base + 2 * HOUR, resetsAt), job('implement', perTenth, 0.25, base + 3 * HOUR, resetsAt)];
});

test('checkUsage refuses missing, negative and non-numeric figures with a reason', () => {
  for (const bad of [null, undefined, -0.1, NaN, '0.5', Infinity]) assert.equal(checkUsage(bad).ok, false, String(bad));
  assert.match(checkUsage(-0.1).reason, /negative/);
  assert.match(checkUsage(undefined).reason, /missing/);
  assert.equal(checkUsage(0.4).used, 0.4);
  assert.equal(checkUsage(1.3).used, 1, 'above 1 is read as used up');
});

test('capacity is learned from tokens over the rise in weekly use, across windows', () => {
  const learned = learnCapacity({ jobs: history(100000) });
  assert.equal(learned.source, 'learned');
  assert.equal(Math.round(learned.capacity), 1000000, '100k tokens per 10% is a 1M week');
  assert.equal(learned.windows, 2);
  assert.equal(learned.confidence, 'medium', 'two windows is not yet high confidence');
});

test('boundary: a capacity from a single noisy window is not trusted alone', () => {
  const oneWindow = history(100000).slice(0, 3);
  const learned = learnCapacity({ jobs: oneWindow });
  assert.equal(learned.capacity, null);
  assert.equal(learned.source, 'none');
  assert.match(learned.note, /not trusted alone/);
  const withStart = learnCapacity({ jobs: oneWindow, configured: 5e6 });
  assert.equal(withStart.capacity, 5e6, 'the configured starting value is used instead of the single window');
  assert.equal(withStart.source, 'configured');
  assert.match(withStart.note, /configured starting value/);
});

test('boundary: no history uses the configured starting value, or says the fixed share applies', () => {
  assert.equal(learnCapacity({ jobs: [], configured: 2e6 }).capacity, 2e6);
  const s = summarise({ used: 0.9, jobs: [], openPrs: 0 });
  assert.equal(s.basis, 'percent');
  assert.match(s.reason, /no capacity known.*fixed share rule applies/);
  assert.equal(s.belowReserve, null);
});

test('invalid: a negative or missing usage figure gives no absolute decision and says why', () => {
  for (const used of [-0.2, null]) {
    const s = summarise({ used, jobs: history(100000), openPrs: 2 });
    assert.equal(s.basis, 'percent');
    assert.equal(s.remaining, null);
    assert.match(s.reason, /negative|missing/);
  }
});

test('samples ignore readings of different windows, jobs without tokens and falling use', () => {
  const jobs = [job('implement', 5, 0.5, T0, T0 + WEEK), job('implement', 100, 0.2, T0 + HOUR, T0 + WEEK), job('implement', 0, 0.6, T0 + 2 * HOUR, T0 + WEEK), job('implement', 50, 0.1, T0 + 3 * HOUR, T0 + 2 * WEEK)];
  assert.deepEqual(capacitySamples(jobs), []);
});

test('valid: two agents at the same percentage with different capacity are ranked by remaining capacity', () => {
  const small = summarise({ used: 0.5, jobs: [], openPrs: 0, configured: 1e6 });
  const large = summarise({ used: 0.5, jobs: [], openPrs: 0, configured: 10e6 });
  assert.equal(small.remaining, 500000);
  assert.equal(large.remaining, 5000000);
  const scores = headroomScores([{ agent: 'small', summary: small, legacy: 0 }, { agent: 'large', summary: large, legacy: 0 }]);
  assert.ok(scores.large > scores.small, JSON.stringify(scores));
});

test('ranking falls back to the old spare share when any agent has no capacity', () => {
  const known = summarise({ used: 0.5, jobs: [], openPrs: 0, configured: 1e6 });
  const unknown = summarise({ used: 0.5, jobs: [], openPrs: 0 });
  const scores = headroomScores([{ agent: 'a', summary: known, legacy: 0.2 }, { agent: 'b', summary: unknown, legacy: 0.7 }]);
  assert.deepEqual(scores, { a: 0.2, b: 0.7 });
});

test('valid: the reserve is the projected need of the open PRs plus a margin, and switches at the absolute amount', () => {
  const jobs = [job('review', 40000, 0.1, T0, T0 + WEEK), job('fix', 60000, 0.12, T0 + HOUR, T0 + WEEK)];
  assert.equal(projectedNeed({ jobs, openPrs: 3 }), 180000, 'three PRs x one 60k fix round, no review');
  const at = used => summarise({ used, jobs, openPrs: 3, configured: 1e6 });
  assert.equal(at(0.5).reserve, 230000, '180k need + 5% margin of 1M');
  assert.equal(at(0.76).belowReserve, false, '240k left is above the 230k reserve');
  assert.equal(at(0.78).belowReserve, true, '220k left is below the 230k reserve');
  assert.equal(at(0.7).belowReserve, false, '300k left');
});

test('boundary: zero open PRs leaves only the margin as the reserve', () => {
  const s = summarise({ used: 0.5, jobs: [job('review', 40000, 0.1, T0, T0 + WEEK)], openPrs: 0, configured: 1e6 });
  assert.equal(s.need, 0);
  assert.equal(s.reserve, 1e6 * ALLOWANCE_DEFAULTS.reserve_margin);
});

const weekly = (used, resetsAt) => ({ provider: 'p', status: 'allowed', observedAt: T0, windows: [{ type: 'seven_day', windowMinutes: 10080, utilization: used, resetsAt, status: 'allowed' }] });
const assess = (used, hoursLeft, capacity) => assessAgent({ allowance: weekly(used, T0 + hoursLeft * HOUR), now: T0, settings: DEFAULT_BUDGET, capacity });

test('the agent goes reviews-only when remaining capacity reaches the reserve, not at a fixed 85 percent', () => {
  const cap = used => summarise({ used, jobs: [], openPrs: 0, configured: 1e6, options: { ...ALLOWANCE_DEFAULTS, reserve_margin: 0.2 } });
  const below = assess(0.7, 72, cap(0.7));
  assert.equal(below.mode, 'normal', '30% left is above the 20% reserve although the fixed share would be 70%');
  const above = assess(0.8, 72, cap(0.8));
  assert.equal(above.mode, 'reviews_only');
  assert.equal(above.rule, 'high-water');
  assert.match(above.reason, /remaining capacity at or below the reserve/);
  const late = assess(0.9, 10, cap(0.9));
  assert.equal(late.mode, 'normal', 'reset within 24 hours: nothing is held');
});

test('without a capacity today\'s 85 percent rule applies and the reason says so', () => {
  const cap = summarise({ used: 0.9, jobs: [], openPrs: 1 });
  const held = assess(0.9, 72, cap);
  assert.equal(held.mode, 'reviews_only');
  assert.match(held.reason, /at or above 85%.*fixed share: .*no capacity known/);
  assert.equal(assess(0.84, 72, cap).mode, 'normal');
  assert.equal(assess(0.9, 72, null).mode, 'reviews_only', 'no summary at all behaves as before');
});

test('planner invariant: no implement or continue for an agent at or below its reserve; reviews and repairs still start', () => {
  const capacity = summarise({ used: 0.9, jobs: [], openPrs: 0, configured: 1e6 });
  const mode = { mode: 'normal', known: true, used: 0.9, costs: { cost: () => null }, capacity: { ...capacity, reserve: 200000 } };
  // 100k left against a 200k reserve
  for (const type of ['implement', 'continue']) {
    const r = admits(mode, type, 0);
    assert.equal(r.ok, false, type);
    assert.match(r.why, /at or below the reserve/);
  }
  for (const type of [...REVIEWS_ONLY_TYPES, 'review']) assert.equal(admits(mode, type, 0).ok, true, type);
  const rich = { ...mode, used: 0.5 };
  assert.equal(admits(rich, 'implement', 0).ok, true);
  // cost already planned this tick counts: `used` carries it
  assert.equal(admits({ ...rich, used: 0.81, planned: 0.31 }, 'implement', 0).ok, false);
});

test('configuration: starting_capacity and reserve_margin are validated', () => {
  const names = ['claude', 'codex'];
  assert.doesNotThrow(() => validateBudgetConfig({ starting_capacity: { claude: 5e6 }, reserve_margin: 0.1 }, names));
  for (const bad of [{ starting_capacity: { nobody: 1e6 } }, { starting_capacity: { claude: -1 } }, { starting_capacity: [1] }, { starting_capacity: { claude: '5' } }, { reserve_margin: 0.9 }, { reserve_margin: -0.1 }]) {
    assert.throws(() => validateBudgetConfig(bad, names), /invalid budget config/, JSON.stringify(bad));
  }
});

test('takeover goes to the agent with the most remaining capacity relative to need, only when every capacity is known', async () => {
  const { betterTaker } = await import('../supervisor/capacity.mjs');
  const row = (agent, used, configured, eligible = true) => ({ agent, summary: summarise({ used, jobs: [], openPrs: 0, configured }), legacy: 0, eligible });
  const rows = [row('claude', 0.5, 1e6), row('codex', 0.5, 10e6)];
  assert.equal(betterTaker('claude', rows), true, 'codex has ten times the capacity at the same percentage');
  assert.equal(betterTaker('codex', rows), false);
  assert.equal(betterTaker('claude', [rows[0], row('codex', 0.5, 10e6, false)]), false, 'an ineligible rival does not hold the work back');
  assert.equal(betterTaker('claude', [rows[0], { ...rows[1], summary: summarise({ used: 0.5, jobs: [], openPrs: 0 }) }]), false, 'a missing capacity falls back to the old behaviour');
});

// Issue #1331: the reserve counts only the summarised agent's own open, unparked, non-draft pull requests.
const ownerOf = pr => (/^(claude|codex)\//.exec(pr.headRefName || '') || [])[1] || null;
const reserveJobs = [job('review', 40000, 0.1, T0, T0 + WEEK), job('fix', 60000, 0.12, T0 + HOUR, T0 + WEEK)];
const forAgent = (name, prs) => capacityFor({ name, used: 0.5, jobs: reserveJobs, settings: { starting_capacity: { claude: 1e6, codex: 1e6 } }, prs, owns: ownerOf });
const p = (n, branch, extra = {}) => ({ number: n, headRefName: branch, isDraft: false, labels: [], ...extra });

test('valid: two own unparked pull requests and three of the other agent give a need of two fix rounds', () => {
  const prs = [p(1, 'claude/issue-1-a'), p(2, 'claude/issue-2-a'), p(3, 'codex/issue-3-a'), p(4, 'codex/issue-4-a'), p(5, 'codex/issue-5-a')];
  assert.equal(forAgent('claude', prs).need, 120000);
  assert.equal(forAgent('codex', prs).need, 180000);
  assert.match(forAgent('claude', prs).text, /reserve 170k tokens for 2 open pull requests of this agent/);
});

test('boundary: zero own pull requests leave only the margin; a parked and a draft own pull request count zero', () => {
  const others = [p(3, 'codex/issue-3-a')];
  assert.equal(forAgent('claude', others).need, 0);
  assert.equal(forAgent('claude', others).reserve, 50000);
  const held = [p(1, 'claude/issue-1-a', { labels: ['parked'] }), p(2, 'claude/issue-2-a', { isDraft: true })];
  assert.equal(forAgent('claude', held).need, 0);
  assert.match(forAgent('claude', held).text, /for 0 open pull requests/);
});

test('boundary: remaining exactly equal to the reserve still holds', () => {
  const s = capacityFor({ name: 'claude', used: 0.75, jobs: [], settings: { starting_capacity: { claude: 1e6 }, reserve_margin: 0.25 }, prs: [], owns: ownerOf });
  assert.equal(s.remaining, s.reserve);
  assert.equal(s.belowReserve, true);
});

test('invalid: a branch with no agent prefix counts for nobody; no labels field is unparked; a missing fix cost counts zero', () => {
  assert.equal(forAgent('claude', [p(1, 'feature/x'), p(2, 'main')]).need, 0);
  const noLabels = { number: 9, headRefName: 'claude/issue-9-a' };
  assert.equal(forAgent('claude', [noLabels]).need, 60000);
  const noFix = capacityFor({ name: 'claude', used: 0.5, jobs: [job('review', 40000, 0.1, T0, T0 + WEEK)], settings: { starting_capacity: { claude: 1e6 } }, prs: [noLabels], owns: ownerOf });
  assert.equal(noFix.need, 0);
});
