// Issue #1326: the record line on the 24 hour first review approval card and the merged per hour card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestLine, windowDates } from '../supervisor/dashbest.mjs';

const approval = { start: '2026-11-06T08:00:00.000Z', end: '2026-11-07T08:00:00.000Z', approved: 45, reviewed: 53, rate: 84.9 };
const merges = { start: '2026-11-06T22:00:00.000Z', end: '2026-11-07T22:00:00.000Z', merged: 106 };
const best = (distance = { approval: null, merges: null }, records = { approval, merges }) => ({ records, distance });

test('the approval card line gives rate, counts and dates', () => {
  assert.match(bestLine('first-pass', best(), 'UTC'), />Best 24 hours 84\.9% \(45 of 53\), 6 to 7 Nov</);
});

test('the merged card line gives count and dates', () => {
  assert.match(bestLine('merge-rate', best(), 'UTC'), />Most merged in 24 hours 106, 6 to 7 Nov</);
});

test('a record that is not beaten carries no beaten wording or mark', () => {
  const html = bestLine('first-pass', best({ approval: -3.2, merges: 0 }), 'UTC');
  assert.doesNotMatch(html, /beaten/);
});

test('a current figure above the record says so in words', () => {
  assert.match(bestLine('first-pass', best({ approval: 2.1, merges: 5 }), 'UTC'), /Record beaten: the last 24 hours are 2\.1 points above it/);
  assert.match(bestLine('merge-rate', best({ approval: 2.1, merges: 5 }), 'UTC'), /Record beaten: the last 24 hours are 5 above it/);
});

test('no stored record, no model or another card gives no line', () => {
  const none = best({ approval: null, merges: null }, { approval: null, merges: null });
  assert.equal(bestLine('first-pass', none, 'UTC'), '');
  assert.equal(bestLine('merge-rate', none, 'UTC'), '');
  assert.equal(bestLine('first-pass', null, 'UTC'), '');
  assert.equal(bestLine('rounds', best(), 'UTC'), '');
});

test('dates follow the time setting and span month ends', () => {
  assert.equal(windowDates(approval, 'UTC'), '6 to 7 Nov');
  assert.equal(windowDates({ start: '2026-10-31T20:00:00.000Z', end: '2026-11-01T20:00:00.000Z' }, 'UTC'), '31 Oct to 1 Nov');
  assert.equal(windowDates({ start: '2026-11-06T22:00:00.000Z', end: '2026-11-07T22:00:00.000Z' }, 'Pacific/Auckland'), '7 to 8 Nov');
  assert.equal(windowDates(approval, 'Not/AZone'), '6 to 7 Nov');
});
