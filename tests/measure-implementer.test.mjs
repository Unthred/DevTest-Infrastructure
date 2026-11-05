import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

test('recovered and obsolete_pr_merged end a run, so a crashed run is not continuous', () => {
  const jobs = [{ id: 'a', kind: 'fix' }, { id: 'b', kind: 'fix' }];
  const events = [ev('a', 'created', 0), ev('a', 'started', 0), ev('a', 'recovered', 10), ev('a', 'started', 30), ev('a', 'completed', 40),
    ev('b', 'created', 0), ev('b', 'started', 0), ev('b', 'obsolete_pr_merged', 5)];
  const m = measure(jobs, events, 0, 60 * M);
  assert.equal(m.before.busyMinutes, 20);   // a: 0-10 and 30-40, b: 0-5 (inside a's first run)
});

test('a job re-queued after an incomplete attempt counts as queued until its next start', () => {
  const jobs = [{ id: 'a', kind: 'fix' }];
  const events = [ev('a', 'created', 0), ev('a', 'started', 0), ev('a', 'incomplete', 10), ev('a', 'started', 25), ev('a', 'completed', 30)];
  assert.equal(measure(jobs, events, 0, 60 * M).before.idleWithWorkQueuedMinutes, 15);
  // negative: a completed job is not queued afterwards
  assert.equal(measure(jobs, events.slice(0, 2).concat(ev('a', 'completed', 10)), 0, 60 * M).before.idleWithWorkQueuedMinutes, 0);
});

test('the CLI reports a missing jobs or events directory without a stack trace', () => {
  const r = spawnSync(process.execPath, ['tools/measure-implementer.mjs', '--jobs', '/nonexistent-506', '--events', '/nonexistent-506', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-01T01:00:00Z'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /directory not found/);
  assert.doesNotMatch(r.stderr, /ENOENT|at /);
});

test('crash and network_error end a run and re-queue it; transient_rate_limit ends it without queue time', () => {
  const jobs = [{ id: 'a', kind: 'fix' }];
  const m = measure(jobs, [ev('a', 'created', 0), ev('a', 'started', 0), ev('a', 'crash', 10), ev('a', 'started', 25), ev('a', 'completed', 30)], 0, 60 * M);
  assert.equal(m.implementerMinutesByKind.fix, 15);   // the crashed run ends at 10, it is not open until a later end
  assert.equal(m.before.idleWithWorkQueuedMinutes, 15);   // waiting 10..25
  const t = measure(jobs, [ev('a', 'created', 0), ev('a', 'started', 0), ev('a', 'transient_rate_limit', 10)], 0, 60 * M);
  assert.equal(t.before.busyMinutes, 10);
});

test('a re-queued job not restarted by the window end is queued only when its current status is queued', () => {
  const events = [ev('a', 'created', 0), ev('a', 'started', 0), ev('a', 'incomplete', 10)];
  assert.equal(measure([{ id: 'a', kind: 'fix', status: 'queued' }], events, 0, 30 * M).before.idleWithWorkQueuedMinutes, 20);
  assert.equal(measure([{ id: 'a', kind: 'fix', status: 'failed' }], events, 0, 30 * M).before.idleWithWorkQueuedMinutes, 0);
});
