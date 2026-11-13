// Issue #1166: the one to two hour rate behind the agent choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recentWindowRate } from '../supervisor/recentrate.mjs';

const HOUR = 3600000;
const NOW = Date.parse('2026-11-12T05:00:00Z');
const reading = (hoursAgo, weeklyUsed, shortUsed, weeklyReset = NOW + 100 * HOUR) => ({ allowance: { a: { observedAt: NOW - hoursAgo * HOUR, windows: [
  { type: 'seven_day', windowMinutes: 10080, utilization: weeklyUsed, resetsAt: weeklyReset },
  { type: 'five_hour', windowMinutes: 300, utilization: shortUsed, resetsAt: NOW + HOUR }] } } });
const rate = (snapshots, kind, extra = {}) => recentWindowRate({ snapshots, agent: 'a', kind, now: NOW, ...extra });

test('the rate is the rise over the readings of the last two hours, per window kind', () => {
  const snaps = [reading(1.5, 0.01, 0.1), reading(0.5, 0.08, 0.5)];
  assert.ok(Math.abs(rate(snaps, 'weekly') - 0.07) < 1e-9);
  assert.ok(Math.abs(rate(snaps, 'short') - 0.4) < 1e-9);
});

test('older readings, a single reading, a reset in between and a falling use give no burst', () => {
  assert.equal(rate([reading(5, 0.01, 0.1), reading(4, 0.5, 0.5)], 'weekly'), null, 'older than two hours');
  assert.equal(rate([reading(1, 0.01, 0.1)], 'weekly'), null);
  assert.equal(rate([reading(1.5, 0.9, 0.1, NOW - HOUR), reading(0.5, 0.02, 0.1)], 'weekly'), null, 'the earlier window has reset');
  assert.equal(rate([reading(1.5, 0.4, 0.1), reading(0.5, 0.3, 0.1)], 'weekly'), 0);
});

test('the newest reading outside the snapshots counts, and two reads of one tick are not a rate', () => {
  const current = reading(0, 0.2, 0.2).allowance.a;
  assert.ok(rate([reading(1, 0.1, 0.1)], 'weekly', { current }) > 0.09);
  assert.equal(rate([reading(0.05, 0.1, 0.1)], 'weekly', { current }), null);
});
