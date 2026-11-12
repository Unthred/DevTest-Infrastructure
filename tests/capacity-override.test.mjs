// Issue #1167: a hand-set capacity wins over the learned one, the two are compared, the current window is checked, and the short window is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarise, capacityView, capacityFor, UNITS_NOTE, ALLOWANCE_DEFAULTS } from '../supervisor/capacity.mjs';
import { budgetView } from '../supervisor/budgetview.mjs';
import { validateBudgetConfig, HOUR } from '../supervisor/budget.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const WEEK = 7 * 24 * HOUR;
const T0 = Date.parse('2026-11-02T00:00:00Z');
const job = (tokens, used, at, resetsAt) => ({ kind: 'implement', provider: 'p', createdAt: at, usage: { inputTokens: tokens, outputTokens: 0 },
  allowance: { observedAt: at, windows: [{ type: 'seven_day', utilization: used, resetsAt, status: 'allowed' }] } });
// Windows 0 and 1 are past; each 10% of use cost `perTenth` tokens, so the learned capacity is perTenth x 10.
const past = perTenth => [0, 1].flatMap(w => {
  const resetsAt = T0 + (w + 1) * WEEK, base = T0 + w * WEEK;
  return [job(1, 0.05, base + HOUR, resetsAt), job(perTenth, 0.15, base + 2 * HOUR, resetsAt), job(perTenth, 0.25, base + 3 * HOUR, resetsAt)];
});
// The current window (resets at T0 + 3 weeks): `perTenth` tokens per 10% of use.
const CURRENT = T0 + 3 * WEEK;
const today = perTenth => [job(1, 0.05, T0 + 2 * WEEK + HOUR, CURRENT), job(perTenth, 0.15, T0 + 2 * WEEK + 2 * HOUR, CURRENT), job(perTenth, 0.25, T0 + 2 * WEEK + 3 * HOUR, CURRENT)];
const run = o => summarise({ used: 0.25, openPrs: 0, resetsAt: CURRENT, ...o });

test('a configured capacity wins over a trusted learned one and is reported as configured', () => {
  const s = run({ jobs: past(100000), override: 3e6 });
  assert.equal(s.capacity, 3e6);
  assert.equal(s.capacitySource, 'configured');
  assert.equal(s.remaining, 3e6 * 0.75);
  assert.equal(capacityView(s).source, 'configured');
});

test('the learned capacity is used when nothing is configured', () => {
  const s = run({ jobs: past(100000) });
  assert.equal(Math.round(s.capacity), 1e6);
  assert.equal(s.capacitySource, 'learned');
  assert.deepEqual(s.warnings, []);
});

test('the warning appears above a factor of 2 and not at or below it, in both directions, with both figures', () => {
  const above = run({ jobs: past(100000), override: 2.5e6 });
  assert.equal(above.warnings.length, 1);
  assert.match(above.warnings[0], /configured 2\.5M tokens.*learned 1\.0M tokens.*more than a factor of 2/);
  assert.match(above.text, /WARNING: configured/);
  assert.equal(run({ jobs: past(100000), override: 2e6 }).warnings.length, 0, 'exactly 2 is not above 2');
  assert.equal(run({ jobs: past(100000), override: 1.5e6 }).warnings.length, 0);
  assert.equal(run({ jobs: past(100000), override: 0.4e6 }).warnings.length, 1, 'a configured value far below the learned one warns too');
  assert.equal(run({ jobs: past(100000), override: 0.5e6 }).warnings.length, 0, 'exactly half is not beyond 2');
});

test('no comparison when only one of the two exists', () => {
  assert.deepEqual(run({ jobs: [], override: 5e6 }).warnings, []);
  assert.equal(run({ jobs: [], override: 5e6 }).learnedCapacity, null);
});

test('the daily check names a current window that disagrees with the learned value, and is silent when it agrees or has no signal', () => {
  const off = run({ jobs: [...past(100000), ...today(1000000)] });
  assert.equal(off.warnings.length, 1);
  assert.match(off.warnings[0], /this window so far implies about 10\.0M tokens a week \(2\.0M tokens for 20% of use\), 10\.0 times higher than the learned 1\.0M tokens/);
  assert.match(off.text, /10\.0 times higher/);
  // The issue's own case: today implies 3.5x the earlier windows. The learned average would absorb today (to well under 2x), so it must be left out.
  const issueCase = run({ jobs: [...past(100000), ...today(350000)] });
  assert.equal(issueCase.warnings.length, 1);
  assert.match(issueCase.warnings[0], /3\.5 times higher than the learned 1\.0M tokens/);
  assert.deepEqual(run({ jobs: [...past(100000), ...today(150000)] }).warnings, [], 'within a factor of 2');
  assert.deepEqual(run({ jobs: [...past(100000), ...today(190000)] }).warnings, [], 'just under 2 times');
  assert.deepEqual(run({ jobs: past(100000) }).warnings, [], 'no job in the current window');
  const tiny = [job(1, 0.05, T0 + 2 * WEEK + HOUR, CURRENT), job(9e6, 0.06, T0 + 2 * WEEK + 2 * HOUR, CURRENT)];
  assert.deepEqual(run({ jobs: [...past(100000), ...tiny] }).warnings, [], 'a 1% rise is rounding noise, not a signal');
  assert.match(run({ jobs: [...past(100000), ...today(5000)] }).warnings[0], /times lower than the learned/);
});

test('the text states the token unit and the short window next to the weekly figure', () => {
  const s = run({ jobs: past(100000), shortWindow: { used: 0.42, resetsAt: Date.UTC(2026, 10, 12, 9, 30) } });
  assert.match(s.text, /short window 42% used, resets 2026-11-12 09:30 UTC/);
  assert.ok(s.text.includes(UNITS_NOTE));
  assert.match(UNITS_NOTE, /input plus output.*cached and model tokens/);
  assert.equal(run({ jobs: past(100000) }).text.includes('short window'), false, 'absent without a short window');
});

test('capacityFor reads the hand-set value from budget.capacity, and starting_capacity still only fills in until the history is trusted', () => {
  const base = { name: 'claude', used: 0.25, jobs: past(100000), prs: [], owns: () => false, resetsAt: CURRENT };
  assert.equal(capacityFor({ ...base, settings: { capacity: { claude: 4e6 } } }).capacity, 4e6);
  assert.equal(Math.round(capacityFor({ ...base, settings: { starting_capacity: { claude: 4e6 } } }).capacity), 1e6, 'a starting value does not beat a learned one');
  assert.equal(capacityFor({ ...base, settings: { capacity: { codex: 4e6 } } }).capacitySource, 'learned', 'another agent\'s value is ignored');
});

test('configuration: capacity is validated like starting_capacity', () => {
  const names = ['claude', 'codex'];
  assert.doesNotThrow(() => validateBudgetConfig({ capacity: { claude: 4e8 } }, names));
  for (const bad of [{ capacity: { nobody: 1e6 } }, { capacity: { claude: 0 } }, { capacity: [1] }, { capacity: { claude: '5' } }]) {
    assert.throws(() => validateBudgetConfig(bad, names), /capacity must map configured agents/);
  }
});

test('through the dashboard view and the MCP budget tool: source configured, warning, units and short window all arrive', async () => {
  const summary = run({ jobs: past(100000), override: 4e8, shortWindow: { used: 0.3, resetsAt: Date.UTC(2026, 10, 12, 9, 30) } });
  const team = { modes: { claude: { mode: 'normal', reason: '', known: true, used: 0.25, capacity: summary, shortWindow: { used: 0.3, resetsAt: Date.UTC(2026, 10, 12, 9, 30) } } }, held: {} };
  const view = { budget: budgetView(team) };
  assert.match(view.budget.claude.reason, /WARNING: configured .* differ by more than a factor of 2/, 'the dashboard reason carries the warning');
  assert.ok(view.budget.claude.reason.includes('cached and model tokens'));
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0 }) }, readHost: () => ({}) });
  const out = JSON.parse((await tools.call('foreman_budget')).text).agents.claude;
  assert.equal(out.capacity.source, 'configured');
  assert.equal(out.capacity.capacity, 4e8);
  assert.equal(out.capacity.learnedCapacity, 1000000);
  assert.equal(out.capacity.warnings.length, 1);
  assert.deepEqual(out.capacity.shortWindow, { used: 0.3, resetsAt: '2026-11-12T09:30:00.000Z' });
  assert.match(out.capacity.unitsNote, /input plus output/);
  assert.equal(ALLOWANCE_DEFAULTS.min_window_delta, 0.03);
});
