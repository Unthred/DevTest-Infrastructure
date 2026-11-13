// Issue #1331: a reviews-only latch set by the reserve rule is released once remaining capacity is above the reserve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAgent, DEFAULT_BUDGET, HOUR } from '../supervisor/budget.mjs';
import { summarise } from '../supervisor/capacity.mjs';

const T0 = Date.parse('2026-11-02T00:00:00Z');
const RESET = T0 + 72 * HOUR;
const allowance = used => ({ provider: 'p', status: 'allowed', observedAt: T0, windows: [{ type: 'seven_day', windowMinutes: 10080, utilization: used, resetsAt: RESET, status: 'allowed' }] });
const capacityAt = used => summarise({ used, jobs: [], openPrs: 0, configured: 1e6 });
const latch = reason => ({ mode: 'reviews_only', rule: 'high-water', since: T0 - HOUR, until: RESET, reason });
const assess = (used, latched, capacity) => assessAgent({ allowance: allowance(used), now: T0, settings: DEFAULT_BUDGET, latched, capacity });
const RESERVE_REASON = 'weekly 96%: remaining capacity at or below the reserve (42% used of about 1.0M tokens a week) with more than 24h to go';

test('a reserve latch is released once remaining is above the reserve', () => {
  const released = assess(0.5, latch(RESERVE_REASON), capacityAt(0.5));
  assert.equal(released.mode, 'normal');
  assert.equal(released.rule, undefined);
});

test('a reserve latch still holds while remaining is at or below the reserve', () => {
  const held = assess(0.96, latch(RESERVE_REASON), capacityAt(0.96));
  assert.equal(held.mode, 'reviews_only');
});

test('a percentage high water latch still holds to the reset', () => {
  const held = assess(0.5, latch('weekly 86%: at or above 85% with more than 24h to go'), capacityAt(0.5));
  assert.equal(held.mode, 'reviews_only');
  assert.match(held.reason, /held until the weekly reset/);
});

test('a reserve latch with no known capacity keeps holding to the reset', () => {
  const held = assess(0.5, latch(RESERVE_REASON), null);
  assert.equal(held.mode, 'reviews_only');
});
