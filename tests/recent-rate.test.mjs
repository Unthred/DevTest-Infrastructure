// Issue #1345: pure recent-rate tests use plain allowance readings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { recentRate } from '../supervisor/recentrate.mjs';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-14T12:00:00Z');
const reading = (hoursAgo, weekly, short, reset = NOW + 10 * HOUR) => ({
  at: NOW - hoursAgo * HOUR,
  weekly: { used: weekly, resetsAt: reset },
  short: { used: short, resetsAt: NOW + HOUR },
});

test('recent rate is the rise over the readings of the last two hours per window kind', () => {
  const readings = [reading(1.5, 0.1, 0.1), reading(0.5, 0.16, 0.4)];
  assert.equal(recentRate({ readings, kind: 'weekly', now: NOW }), 0.06);
  assert.equal(recentRate({ readings, kind: 'short', now: NOW }), 0.30000000000000004);
});

test('one reading, an old reading, or a reset between readings has no rate', () => {
  assert.equal(recentRate({ readings: [reading(1, 0.1, 0.1)], kind: 'weekly', now: NOW }), null);
  assert.equal(recentRate({ readings: [reading(3, 0.1, 0.1), reading(1, 0.2, 0.2)], kind: 'weekly', now: NOW }), null);
  const reset = NOW + 20 * HOUR;
  assert.equal(recentRate({ readings: [reading(1, 0.1, 0.1, reset), reading(0, 0.2, 0.2)], kind: 'weekly', now: NOW }), null);
});
