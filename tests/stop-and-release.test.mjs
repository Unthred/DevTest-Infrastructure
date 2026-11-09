// Issue #1109: a supported stop is not a fault and uses no attempt; attempts used by infrastructure faults are released once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stopJob } from '../supervisor/stopjob.mjs';
import { FaultFlow } from '../supervisor/faultflow.mjs';
import * as faults from '../supervisor/faults.mjs';
import { endNote } from '../supervisor/faultview.mjs';
import { readJob, saveJob, transition } from '../supervisor/core.mjs';

const clock = { now: () => 5000 };
function jobOnDisk(t, over = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = { id: 'a'.repeat(32), status: 'running', autoRestart: true, autoResume: true, usage: {}, ...over };
  saveJob(root, job, clock, true);
  return { root, job };
}

test('stop: classified stopped, restart cleared, marker survives a worker that ended first', t => {
  const { root, job } = jobOnDisk(t);
  let signalled = false;
  stopJob(root, job, { clock, signal: () => { signalled = true; assert.equal(readJob(root, job.id).status, 'stopped', 'recorded before the signal'); } });
  assert.ok(signalled);
  const disk = readJob(root, job.id);
  assert.deepEqual([disk.status, disk.autoRestart, disk.autoResume, disk.stop.reason], ['stopped', false, false, 'manual_stop']);
  // A dying worker records a later crash with its in-memory (running) copy: the stop must stand.
  const worker = { ...job, status: 'running', stop: undefined, autoRestart: true };
  transition(root, worker, 'blocked', 'crash', clock);
  assert.equal(readJob(root, job.id).status, 'stopped');
  const cls = faults.classifyEnd({ ...disk, lastEvent: 'crash' });
  assert.deepEqual([cls.kind, faults.countsAsAttempt(cls)], ['none', false]);
});

test('stop: invalid reason falls back to manual_stop; another stop reason (idle_timeout) stays a work outcome', t => {
  const { root, job } = jobOnDisk(t);
  assert.equal(stopJob(root, job, { clock, reason: 'Bad Reason!' }).stop.reason, 'manual_stop');
  const idle = { status: 'stopped', lastEvent: 'idle_timeout', stop: { by: 'overseer', reason: 'idle_timeout' }, usage: { inputTokens: 5, outputTokens: 1 } };
  assert.equal(faults.classifyEnd(idle).kind, 'work');
});

function flow(state) {
  return new FaultFlow({ state: () => state, now: () => 9000, save: () => {} });
}
const mkState = () => ({
  reviewAttempts: { 'k1:codex': 2, 'k2:codex': 1 }, fixAttempts: {}, rebaseAttempts: {},
  jobs: {
    j1: { kind: 'review', key: 'k1:codex', pr: 7 },
    j2: { kind: 'review', key: 'k1:codex', pr: 7 },   // a real work attempt on the same counter
    j3: { kind: 'review', key: 'k2:codex', pr: 8 },   // a stopped job
  },
});
const ends = { j1: { status: 'blocked', lastEvent: 'auth_error', usage: {} }, j2: { status: 'blocked', lastEvent: 'incomplete', usage: { inputTokens: 90, outputTokens: 4 } },
  j3: { status: 'stopped', lastEvent: 'manual_stop', usage: {} } };

test('release: mixed counter keeps the work attempt; stops are released; a second run changes nothing', async () => {
  const s = mkState(), f = flow(s), lines = [];
  const out = await f.releaseInfraAttempts(async id => ends[id], l => lines.push(l));
  assert.deepEqual(s.reviewAttempts, { 'k1:codex': 1, 'k2:codex': 0 });
  assert.equal(out.length, 2);
  assert.equal(lines.length, 2);
  assert.ok(lines.every(l => /PR #[78]/.test(l)));
  assert.equal(s.jobs.j2.attemptRefunded, undefined);
  const again = await f.releaseInfraAttempts(async id => ends[id], l => lines.push(l));
  assert.deepEqual([again, s.reviewAttempts], [[], { 'k1:codex': 1, 'k2:codex': 0 }]);
});

test('release: unknown end with no tokens is infrastructure; unreadable record is infrastructure too; a running job is left alone', async () => {
  const s = mkState(), f = flow(s);
  const odd = { j1: { status: 'blocked', lastEvent: 'brand_new', usage: {} }, j2: null, j3: { status: 'running' } };
  await f.releaseInfraAttempts(async id => odd[id], () => {});
  assert.deepEqual(s.reviewAttempts, { 'k1:codex': 0, 'k2:codex': 1 });
});

test('stop uses no attempt: onEnd refunds the launch attempt, never parks, never goes below zero', () => {
  const s = mkState(), f = flow(s), report = {};
  f.onEnd('j3', s.jobs.j3, ends.j3, report);
  assert.equal(s.reviewAttempts['k2:codex'], 0);
  assert.deepEqual(s.infra?.parked ?? {}, {});
  f.onEnd('j3', s.jobs.j3, ends.j3, report);
  assert.equal(s.reviewAttempts['k2:codex'], 0, 'once per job');
});

test('endNote: stop and fault wording', () => {
  assert.match(endNote({ status: 'stopped', stop: { by: 'homeowner', reason: 'manual_stop' } }, {}), /stopped by homeowner; no attempt used/);
  assert.match(endNote({ status: 'blocked' }, { infraFault: 'auth_error', attemptRefunded: 'auth_error' }), /attempt released/);
  assert.match(endNote({ status: 'blocked' }, { attemptRefunded: 'auth_error' }), /infrastructure fault \(auth_error\).*attempt released/);
  assert.equal(endNote({ status: 'blocked' }, { attemptRefunded: 'manual_stop' }), 'stopped; attempt released');
  assert.doesNotMatch(endNote({ status: 'stopped', stop: { by: 'overseer', reason: 'idle_timeout' } }, {}), /no attempt used/);
  assert.equal(endNote({ status: 'completed' }, {}), null);
  assert.equal(endNote(null, undefined), null);
});
