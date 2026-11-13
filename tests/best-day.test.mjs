// Issue #1325: the pure window arithmetic of the best 24 hours.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bestWindows, currentWindow, firstReviews, beatsApproval, HOUR_MS, DAY_MS } from '../supervisor/best-day.mjs';

const T0 = Date.UTC(2026, 10, 6, 8, 0, 0);
const MIN = 60000;
// n pull requests whose first review falls at the given time, the first `approved` of them approved.
const reviews = (n, approved, at, firstPr = 1) => Array.from({ length: n }, (_, i) => ({ pr: firstPr + i, at: at + i * MIN, verdict: i < approved ? 'PASS' : 'CHANGES' }));

test('a window with 19 first reviews at 100 percent does not qualify; one with 20 does', () => {
  assert.equal(bestWindows({ verdicts: reviews(19, 19, T0) }).approval, null);
  const best = bestWindows({ verdicts: reviews(20, 20, T0) }).approval;
  assert.equal(best.reviewed, 20);
  assert.equal(best.rate, 100);
});

test('two equal rates resolve to the window with more first reviews', () => {
  const small = reviews(20, 10, T0, 1);
  const large = reviews(40, 20, T0 + 3 * DAY_MS, 100);
  const best = bestWindows({ verdicts: [...small, ...large] }).approval;
  assert.equal(best.reviewed, 40);
  assert.equal(beatsApproval({ approved: 10, reviewed: 20 }, { approved: 20, reviewed: 40 }), false);
  assert.equal(beatsApproval({ approved: 20, reviewed: 40 }, { approved: 10, reviewed: 20 }), true);
});

test('no data returns no record', () => {
  assert.deepEqual(bestWindows({}), { approval: null, merges: null });
  assert.deepEqual(bestWindows({ verdicts: [], merges: [] }), { approval: null, merges: null });
});

test('a first review exactly on the window edge is counted once', () => {
  const edge = T0 + DAY_MS; // the end of the window that starts at T0, the start of the next
  const verdicts = [...reviews(20, 20, T0, 1), { pr: 500, at: edge, verdict: 'PASS' }];
  const best = bestWindows({ verdicts }).approval;
  // A window holding the edge review would hold 21 and win, so the best window ends at the edge at the latest.
  assert.equal(best.reviewed, 20);
  assert.ok(Date.parse(best.end) <= edge);
  const next = currentWindow({ verdicts }, edge + HOUR_MS);
  assert.equal(next.window.reviewed, 1, 'the edge review is in the later window only');
});

test('the pull request #1200 case: two CHANGES then an approval is not approved at first review, whatever the order given', () => {
  const at = (day, h, m) => Date.UTC(2026, 10, day, h, m);
  const p1200 = [{ pr: 1200, at: at(13, 1, 20), verdict: 'PASS' }, { pr: 1200, at: at(12, 22, 59), verdict: 'CHANGES' }, { pr: 1200, at: at(13, 0, 46), verdict: 'CHANGES' }];
  assert.deepEqual(firstReviews(p1200), [{ pr: 1200, at: at(12, 22, 59), verdict: 'CHANGES' }]);
  const others = reviews(19, 19, at(12, 12, 0), 2000);
  const now = at(13, 12, 0);
  const result = currentWindow({ verdicts: [...p1200, ...others] }, now);
  assert.equal(result.window.reviewed, 20);
  assert.equal(result.window.approved, 19);
  assert.equal(result.window.verdicts, 22);
});

test('merges: the window with most merges, verdicts per merged pull request, distance to each record', () => {
  const merges = Array.from({ length: 5 }, (_, i) => ({ pr: i + 1, at: T0 + i * HOUR_MS }));
  const verdicts = reviews(20, 15, T0);
  const { approval, merges: most } = bestWindows({ verdicts, merges });
  assert.equal(most.merged, 5);
  assert.equal(most.verdicts_per_merged, 4);
  const now = T0 + 2 * HOUR_MS;
  const current = currentWindow({ verdicts: reviews(20, 20, T0), merges: merges.slice(0, 2) }, now, { approval, merges: most });
  assert.equal(current.qualifies, true);
  assert.deepEqual(current.distance, { approval: 25, merges: -3 });
});

test('below 20 first reviews the current window has no approval distance', () => {
  const current = currentWindow({ verdicts: reviews(5, 5, T0) }, T0 + HOUR_MS, { approval: bestWindows({ verdicts: reviews(20, 10, T0) }).approval, merges: null });
  assert.equal(current.qualifies, false);
  assert.equal(current.distance.approval, null);
  assert.equal(current.distance.merges, null);
});
