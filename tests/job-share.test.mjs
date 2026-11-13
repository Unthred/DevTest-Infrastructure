// Issue #1166: the expected cost of a job as a share of an agent's plan, learned from history or configured (synthetic data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedShare, shortPerWeekly, CHOICE_DEFAULTS } from '../supervisor/jobshare.mjs';

const job = (kind, tokens, i, allowance) => ({ kind, createdAt: 1000 - i, usage: { inputTokens: tokens, outputTokens: 0 }, ...(allowance ? { allowance } : {}) });
const reading = (at, weekly, short) => ({ observedAt: at, windows: [
  { type: 'seven_day', windowMinutes: 10080, utilization: weekly, resetsAt: 9e12 }, { type: 'five_hour', windowMinutes: 300, utilization: short, resetsAt: 8e12 }] });

test('with enough history the share is the median tokens per job over that agent capacity, so the same job is dearer on a small plan', () => {
  const jobs = [1, 2, 3].map(i => job('implement', 1000000 * i, i));
  const small = expectedShare({ jobs, kind: 'implement', capacity: 1e8 });
  const large = expectedShare({ jobs, kind: 'implement', capacity: 1e9 });
  assert.equal(small.source, 'history');
  assert.equal(small.weekly, 0.02);
  assert.equal(large.weekly, 0.002);
});

test('too little history uses the configured default and the note says so', () => {
  const jobs = [job('implement', 1e6, 1)];
  const r = expectedShare({ jobs, kind: 'implement', capacity: 1e8, settings: { default_shares: { implement: 0.05 } } });
  assert.equal(r.source, 'default');
  assert.equal(r.weekly, 0.05);
  assert.match(r.note, /history too short \(1 of 3 implement jobs seen\); configured default share/);
  assert.match(expectedShare({ jobs: [], kind: 'review', capacity: null }).note, /capacity unknown/);
  assert.equal(expectedShare({ jobs: [], kind: 'review', capacity: 1 }).weekly, CHOICE_DEFAULTS.default_shares.review);
});

test('only jobs of the same type count, and the short share follows the learned short-per-weekly ratio', () => {
  const jobs = [
    ...[1, 2, 3].map(i => job('fix', 1e5, i)), ...[4, 5].map(i => job('implement', 9e9, i)),
    job('review', 1, 6, reading(100, 0.10, 0.10)), job('review', 1, 7, reading(200, 0.11, 0.30)), job('review', 1, 8, reading(300, 0.12, 0.50)),
  ];
  assert.ok(Math.abs(shortPerWeekly(jobs, 2) - 20) < 1e-9);
  assert.equal(shortPerWeekly(jobs, 3), null, 'two usable pairs only');
  const r = expectedShare({ jobs, kind: 'fix', capacity: 1e7, settings: { min_samples: 3 } });
  assert.equal(r.weekly, 0.01);
  assert.equal(r.short, 0.01 * CHOICE_DEFAULTS.short_per_weekly, 'fewer than min_samples ratio pairs keeps the configured ratio');
});
