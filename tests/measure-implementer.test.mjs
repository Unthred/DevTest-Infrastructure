import test from 'node:test';
import assert from 'node:assert/strict';
import { measure } from '../tools/measure-implementer.mjs';
const M = 60000;
const ev = (job, kind, m) => ({ job, kind, at: m * M });

test('rebases leave the implementer view in the after figures, and queued idle time is counted', () => {
  const jobs = [{ id: 'r', kind: 'rebase' }, { id: 'n', kind: 'implement' }, { id: 'v', kind: 'review' }];
  const events = [ev('r', 'created', 0), ev('r', 'started', 0), ev('r', 'completed', 30),
    ev('n', 'created', 10), ev('n', 'started', 30), ev('n', 'completed', 40), ev('v', 'created', 0), ev('v', 'started', 0), ev('v', 'completed', 60)];
  const m = measure(jobs, events, 0, 60 * M);
  assert.equal(m.before.busyMinutes, 40);
  assert.equal(m.before.idleWithWorkQueuedMinutes, 0);
  assert.equal(m.after.busyMinutes, 10);
  assert.equal(m.after.idleWithWorkQueuedMinutes, 20);   // replay of the same records: the new work waited 10..30 only because the old run used the slot
  assert.deepEqual(m.implementerMinutesByKind.rebase, 30);
  assert.deepEqual(m.sharePercentOfImplementerJobMinutes, { rebase: 75, fix: 0, newWork: 25 });
});

test('a job still running at the window end is counted to the end, and the window clips runs', () => {
  const m = measure([{ id: 'a', kind: 'fix' }], [ev('a', 'created', -10), ev('a', 'started', -5)], 0, 20 * M);
  assert.equal(m.before.busyMinutes, 20);
  assert.equal(m.implementerMinutesByKind.fix, 20);
});
