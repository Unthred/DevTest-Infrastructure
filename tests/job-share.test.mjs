// Issue #1345: pure expected job share tests use only synthetic history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedShare, shortPerWeekly } from '../supervisor/jobshare.mjs';

const job = (type, tokens, finishedAt) => ({ type, tokens, finishedAt });

test('expected share is the median of the last ten jobs over capacity', () => {
  const jobs = [1, 2, 3].map(index => job('implement', index * 100, index));
  const share = expectedShare({ jobs, type: 'implement', capacity: 10_000 });
  assert.equal(share.source, 'history');
  assert.equal(share.weekly, 0.02);
  assert.equal(share.short, 0.14);
  assert.match(share.note, /median of the last 3 implement jobs over capacity/);
});

test('too little history uses the configured default and the note says so', () => {
  const share = expectedShare({
    jobs: [job('implement', 100, 1)],
    type: 'implement',
    capacity: 1_000,
    settings: { shares: { implement: 0.05 } },
  });
  assert.equal(share.source, 'default');
  assert.equal(share.weekly, 0.05);
  assert.match(share.note, /history too short.*configured default share/);
});

test('a missing capacity keeps the configured default rather than inventing a share', () => {
  const share = expectedShare({ jobs: [job('review', 50, 1)], type: 'review', capacity: null });
  assert.equal(share.source, 'default');
  assert.match(share.note, /capacity is missing or invalid/);
});

test('a learned short-per-weekly ratio wins over the configured default when history is sufficient', () => {
  const readings = [
    allowance(1, 0.1, 0.2),
    allowance(2, 0.2, 0.6),
    allowance(3, 0.3, 1),
    allowance(4, 0.4, 1.4),
  ];
  assert.ok(Math.abs(shortPerWeekly(readings) - 4) < 1e-9);
  const share = expectedShare({
    jobs: [job('review', 100, 1), job('review', 200, 2), job('review', 300, 3)],
    readings,
    type: 'review',
    capacity: 10_000,
  });
  assert.equal(share.weekly, 0.02);
  assert.ok(Math.abs(share.short - 0.08) < 1e-9);
  assert.match(share.note, /learned short ratio/);
});

function allowance(at, weekly, short) {
  return {
    at,
    weekly: { used: weekly, resetsAt: 100 },
    short: { used: short, resetsAt: 20 },
  };
}
