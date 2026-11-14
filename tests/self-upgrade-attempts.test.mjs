// Issue #1368: a commit refused by the install-time tests gets up to three further attempts, then one Needs you item. Every test goes through the
// real SelfUpgrade step with a fake installer and a fake clock. The real example is the refusal of 13 Nov 2026 19:50 UTC (PR #1309).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfUpgrade, PRECHECK_RETRY_MS } from '../supervisor/upgrade.mjs';
import { installs } from '../supervisor/installs.mjs';
import { ATTEMPT_GAP_MS, MAX_ATTEMPTS, attemptsAttention } from '../supervisor/upgrade-attempts.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const FROM = H('a'), TO = H('b'), NEXT = H('c');
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 10, 13, 19, 50);
const FAILING = 'valid: heartbeats keep to the 15 second limit (here 120 ms) even while other events are sent between them';
const refused = { ok: false, blocked: true, kind: 'tests', reason: `tests failed: ${FAILING}`, tests: [FAILING], excerpt: 'not ok 1' };
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];

function world(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'attempts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = { now: T0, active: 0, jobEndedAt: null, target: TO, installed: FROM, up: refused, ...over };
  const log = [];
  const deps = {
    config: { agents: { claude: { branch_prefix: 'claude/' }, codex: { branch_prefix: 'codex/' } } }, independenceApproved: () => true,
    installed: () => state.installed, fetchMain: () => state.target, isAncestor: () => true, changedFiles: () => ['supervisor/team.mjs'],
    mainCommits: () => [{ sha: H('9'), pr: 7, head: H('d') }],
    mergedPull: async () => ({ state: 'MERGED', headRefName: 'claude/issue-9-x', headRefOid: H('d'), statusCheckRollup: green }),
    verdict: () => ({ verdict: 'PASS', reviewer: 'codex' }),
    activeJobs: async () => state.active, jobEndedAt: () => state.jobEndedAt,
    preChecks: async () => ({ ok: true }), upgrade: async sha => { log.push(sha); return state.up; },
    dryRunTick: async () => ({ ok: true }), rollback: async () => ({ ok: true }), alert: async () => {},
  };
  const make = () => new SelfUpgrade({ root: path.join(dir, 'root'), deps, clock: { now: () => state.now } });
  const records = () => fs.readFileSync(path.join(dir, 'root/team/upgrades.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { dir, root: path.join(dir, 'root'), state, log, make, up: make(), records, item: () => attemptsAttention(path.join(dir, 'root'), { installed: state.installed }) };
}
const at = (w, minutes) => { w.state.now = T0 + minutes * MIN; return w.up.step(); };

test('valid: refused, then a job end with no job running 12 minutes later starts the second attempt, which installs; the item never appears', async t => {
  const w = world(t);
  assert.equal(await at(w, 0), 'precheck-failed');
  assert.deepEqual(w.item(), []);
  w.state.jobEndedAt = T0 + 12 * MIN;
  w.state.up = { ok: true };
  assert.equal(await at(w, 12), 'upgraded');
  assert.equal(w.log.length, 2);
  assert.deepEqual(w.item(), []);
});

test('boundary: a job end 9 minutes after the refusal starts nothing, and a job still running starts nothing', async t => {
  const w = world(t);
  await at(w, 0);
  w.state.jobEndedAt = T0 + 9 * MIN;
  assert.equal(await at(w, 9), 'precheck-failed');
  assert.equal(w.log.length, 1, 'the 10 minute gap has not passed');
  w.state.active = 1;
  assert.equal(await at(w, 12), 'precheck-failed');
  assert.equal(w.log.length, 1, 'a job is running');
  w.state.active = 0;
  assert.equal(await at(w, 12), 'precheck-failed');
  assert.equal(w.log.length, 2, 'the gap passed, the job ended and none runs');
});

test('with no job end the 30 minute fallback starts the attempt; the gap is never shorter than 10 minutes', async t => {
  const w = world(t);
  await at(w, 0);
  assert.equal(ATTEMPT_GAP_MS, 10 * MIN);
  await at(w, 29);
  assert.equal(w.log.length, 1);
  await at(w, PRECHECK_RETRY_MS / MIN);
  assert.equal(w.log.length, 2);
});

test('boundary: four refusals raise the item once; a fifth tick makes no attempt; the item names tests, count and times', async t => {
  const w = world(t);
  await at(w, 0);
  for (const minute of [12, 24, 36]) { w.state.jobEndedAt = T0 + minute * MIN; assert.deepEqual(w.item(), []); await at(w, minute); }
  assert.equal(w.log.length, MAX_ATTEMPTS);
  const [item, ...more] = w.item();
  assert.equal(more.length, 0);
  assert.equal(item.id, 'upgrade-blocked');
  assert.match(item.text, new RegExp(`4 attempts`));
  assert.ok(item.text.includes(FAILING));
  for (const stamp of ['2026-11-13 19:50', '2026-11-13 20:02', '2026-11-13 20:14', '2026-11-13 20:26']) assert.ok(item.text.includes(stamp), stamp);
  w.state.jobEndedAt = T0 + 60 * MIN;
  await at(w, 120);
  assert.equal(w.log.length, 4, 'no fifth attempt');
  assert.deepEqual(w.records().map(r => r.attempt), [1, 2, 3, 4], 'each refusal is one record with its attempt number');
  assert.equal(w.up.s.install.attempt, 4);
});

test('main moving clears the item and resets the count; an install of the commit clears it too', async t => {
  const w = world(t);
  await at(w, 0);
  for (const minute of [12, 24, 36]) { w.state.jobEndedAt = T0 + minute * MIN; await at(w, minute); }
  assert.equal(w.item().length, 1);
  w.state.target = NEXT;
  w.state.up = { ok: true };
  assert.equal(await at(w, 40), 'upgraded');
  assert.equal(w.up.s.refusedAttempts, undefined);
  w.state.installed = NEXT;
  assert.deepEqual(w.item(), []);
  await at(w, 50);
  assert.equal(w.up.s.refusedAttempts, undefined);
});

test('invalid: an environmental failure does not count as an attempt', async t => {
  const w = world(t, { up: { ok: false, environmental: true, reason: 'clean copy failed' } });
  await at(w, 0);
  assert.equal(w.up.s.refusedAttempts, undefined);
  assert.deepEqual(w.item(), []);
});

test('the install history and the install status carry the attempt number of each refused install', async t => {
  const w = world(t);
  await at(w, 0);
  w.state.jobEndedAt = T0 + 12 * MIN;
  await at(w, 12);
  const view = installs(w.root, { now: w.state.now, running: FROM });
  assert.deepEqual(view.recent.map(r => [r.result, r.attempt]), [['precheck_failed', 2], ['precheck_failed', 1]]);
  assert.equal(view.lastInstall.attempt, 2);
});
