import test from 'node:test';
import assert from 'node:assert/strict';
import { jobCheck, failedTests, SUITE_ARGS } from '../supervisor/jobcheck.mjs';
import { fixPrompt } from '../supervisor/team.mjs';

test('job-check stops at a failing validator and does not run the suite', async () => {
  const calls = [];
  const r = await jobCheck({ worktree: '/w', cli: '/cli.mjs', node: 'node', exec: async (c, a) => { calls.push(a[0]); return { code: 1, out: 'bad doc' }; } });
  assert.equal(r.ok, false); assert.equal(r.tests, null); assert.deepEqual(calls, ['tools/validate-project.mjs']);
  assert.match(r.validator.tail, /bad doc/);
});

test('job-check runs the suite through test-slot and lists only failing tests', async () => {
  const calls = [];
  const exec = async (c, a) => { calls.push(a); return a[0] === 'tools/validate-project.mjs' ? { code: 0, out: '' } : { code: 1, out: '✖ turn budget stops (3ms)\n✔ ok one\n✖ second failure (1ms)\n' }; };
  const r = await jobCheck({ worktree: '/w', cli: '/cli.mjs', node: 'node', exec });
  assert.deepEqual(calls[1], ['/cli.mjs', ...SUITE_ARGS]);
  assert.equal(r.ok, false); assert.equal(r.tests.exitCode, 1);
  assert.deepEqual(r.tests.failed, ['turn budget stops (3ms)', 'second failure (1ms)']);
});

test('job-check reports success with an empty tail', async () => {
  const r = await jobCheck({ worktree: '/w', cli: '/cli.mjs', node: 'node', exec: async () => ({ code: 0, out: 'lots of output' }) });
  assert.equal(r.ok, true); assert.equal(r.tests.tail, ''); assert.match(r.next, /commit and push/);
});

test('failedTests ignores passing lines', () => { assert.deepEqual(failedTests('✔ a\n✔ b'), []); });

test('the fix prompt points the agent at job-check', () => {
  assert.match(fixPrompt({ pr: 1, head: 'abc', branch: 'b' }), /ai-supervisor job-check --worktree \./);
});
