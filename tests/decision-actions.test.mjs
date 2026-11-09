import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ACTIONS, DECISION_ACTIONS, assertDecisionTable, controlsForDecision } from '../foreman-mcp/actions.mjs';
import { recordDecisionAction } from '../supervisor/decision-request.mjs';
import { statusOf } from '../supervisor/inbox.mjs';

const tempRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR, 'decision-actions-'));

test('each declared decision type has a valid action and unknown types are visible errors', () => {
  assert.equal(assertDecisionTable(), true);
  for (const row of DECISION_ACTIONS) assert.ok(row.actions.length && row.actions.every(name => ACTIONS[name]));
  const mapped = controlsForDecision({ id: 'retrycap-review-12', ref: { n: 12 } });
  assert.deepEqual(mapped.controls.map(c => c.action), ['clear_retry_cap', 'new_review_attempt']);
  assert.equal(mapped.error, null);
  assert.deepEqual(controlsForDecision({ id: 'fixlimit-12', ref: { n: 12 } }).controls.map(c => c.action), ['extra_fix_round']);
  assert.deepEqual(controlsForDecision({ id: 'reviewrefused-12', ref: { n: 12 } }).controls.map(c => c.action), ['new_review_attempt']);
  assert.deepEqual(controlsForDecision({ id: 'reviewlimit-12', ref: { n: 12 } }).controls.map(c => c.action), ['new_review_attempt']);
  const jobControls = controlsForDecision({ id: `job-${'a'.repeat(32)}` }).controls;
  assert.deepEqual(jobControls.map(c => [c.action, c.target]), [
    ['resume_job', 'aaaaaaaa'],
    ['close_job', 'aaaaaaaa'],
  ]);
  assert.deepEqual(controlsForDecision({ id: 'stale-mark-12', ref: { kind: 'issue', n: 12 } }).controls.map(c => c.action), ['reopen']);
  const unknown = controlsForDecision({ id: 'unmapped-new-type', ref: { n: 12 } });
  assert.match(unknown.error, /no action mapping/);
});

test('a decision records the homeowner, time and reason for the next tick', t => {
  const dir = tempRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = recordDecisionAction({ dir, action: 'clear_retry_cap', target: '12', reason: 'the underlying fault is fixed', now: 1000 });
  const status = statusOf(dir, result.id);
  assert.equal(status.state, 'approved');
  assert.equal(status.decidedBy, 'homeowner');
  assert.equal(status.decidedAt, 1000);
  assert.equal(status.decisionReason, 'the underlying fault is fixed');
});

test('unknown actions and malformed targets are refused before an item is written', t => {
  const dir = tempRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => recordDecisionAction({ dir, action: 'unknown', target: '12', reason: 'x' }), /unknown action/);
  assert.throws(() => recordDecisionAction({ dir, action: 'clear_retry_cap', target: 'job-id', reason: 'x' }), /unknown action/);
  assert.ok(ACTIONS.clear_retry_cap);
});
