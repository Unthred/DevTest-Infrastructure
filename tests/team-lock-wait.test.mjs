// Issue #867: homeowner commands wait for the tick lock, then run; on timeout a breaker resume is queued for the next tick.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { tickLock, tickLockWait } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { takeBreakerResumeRequests } from '../supervisor/breakerresume.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lockwait-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;

test('issue #867: tickLockWait takes the lock once the holder releases it, and says it is waiting', async t => {
  const root = stateRoot(tmp(t)), held = tickLock(root); assert.ok(held);
  const said = [];
  setTimeout(() => held(), 150);
  const release = await tickLockWait(root, { timeoutMs: 5000, pollMs: 20, say: l => said.push(l) });
  assert.equal(typeof release, 'function'); assert.equal(said.length, 1); assert.match(said[0], /waiting/);
  assert.equal(tickLock(root), null, 'the waiter now holds the lock'); release();
});

test('issue #867: tickLockWait returns null after the timeout and does not take over a live lock', async t => {
  const root = stateRoot(tmp(t)), held = tickLock(root); t.after(() => held());
  assert.equal(await tickLockWait(root, { timeoutMs: 100, pollMs: 20 }), null);
  const free = tickLock(stateRoot(tmp(t))); assert.ok(free); free();   // negative control: a free lock is taken at once
});

test('issue #867: the CLI waits for a held lock and then runs (reopen gets past the lock)', async t => {
  const dir = tmp(t), root = stateRoot(dir), held = tickLock(root);
  const child = spawn(process.execPath, [cli, 'team', 'reopen', '23'], { env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: dir, AI_SUPERVISOR_LOCK_WAIT_MS: '20000' } });
  let err = ''; child.stderr.on('data', d => { err += d; });
  const out = new Promise(r => child.on('close', code => r(code)));
  await new Promise(r => setTimeout(r, 1500)); held();
  await out;
  assert.match(err, /waiting up to 20s/);
  assert.doesNotMatch(err, /was not applied now|retry in a minute/, 'the command ran after the lock was released');
});

test('issue #867: a CLI breaker resume that times out leaves a queued request for the next tick', t => {
  const dir = tmp(t), root = stateRoot(dir), held = tickLock(root); t.after(() => held());
  const r = spawnSync('script', ['-qec', `${process.execPath} ${cli} team breaker resume global`, '/dev/null'], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: dir, AI_SUPERVISOR_LOCK_WAIT_MS: '200' } });
  const text = r.stdout + r.stderr;
  if (r.error || /needs a person at a terminal/.test(text)) return t.skip('no person terminal (or run under a supervised job) in this environment');
  assert.notEqual(r.status, 0); assert.match(text, /resume is queued/);
  const q = takeBreakerResumeRequests(root); assert.equal(q.length, 1); assert.equal(q[0].scope, 'global');
});

import { Team } from '../supervisor/team.mjs';
import { takeHomeownerRequests, queueHomeownerRequest } from '../supervisor/homeownerqueue.mjs';

test('issue #867: reopen, accept-split and request-review that time out leave a queued request', t => {
  const dir = tmp(t), root = stateRoot(dir), held = tickLock(root); t.after(() => held());
  const run = (...args) => spawnSync(process.execPath, [cli, 'team', ...args], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: dir, AI_SUPERVISOR_LOCK_WAIT_MS: '200' } });
  for (const args of [['reopen', '23'], ['accept-split', '24'], ['request-review', '25', 'https://example.test/c']]) {
    const r = run(...args); assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /request is queued; the next tick applies it/);
  }
  const q = takeHomeownerRequests(root);
  assert.deepEqual(q.map(x => [x.command, ...x.args]), [['reopen', '23'], ['accept-split', '24'], ['request-review', '25', 'https://example.test/c']]);
});

test('issue #867: the tick applies a queued reopen, discards a refused one, and ignores malformed files', async t => {
  const dir = tmp(t), root = stateRoot(dir);
  const gh = { listIssues: async () => [{ number: 23, state: 'OPEN' }], listPulls: async () => [], getIssue: null };
  const team = new Team({ config: { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } },
  root, gh, jobs: { listActive: async () => [], get: async () => null }, git: {}, register: '', clock: { now: () => 5000 } });
  team.s.implemented[23] = 1; team.save();
  queueHomeownerRequest(root, 'reopen', ['23'], 1);
  queueHomeownerRequest(root, 'reopen', ['99'], 2);   // issue not found: refused, reported, discarded
  fs.writeFileSync(path.join(root, 'homeowner-requests', '3-bad.json'), '{not json');
  const report = {}; await team.applyHomeownerRequests(report);
  assert.equal(team.s.implemented[23], undefined, 'the queued reopen was applied');
  assert.equal(report.notified.length, 1); assert.match(report.skipped[0].reason, /not found/);
  assert.deepEqual(takeHomeownerRequests(root), [], 'applied, refused and malformed files are all gone');
});

test('issue #867: a malformed request-review is refused up front, not queued', t => {
  const dir = tmp(t), root = stateRoot(dir), held = tickLock(root); t.after(() => held());
  const r = spawnSync(process.execPath, [cli, 'team', 'request-review'], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: dir, AI_SUPERVISOR_LOCK_WAIT_MS: '200' } });
  assert.notEqual(r.status, 0); assert.match(r.stdout + r.stderr, /usage: team request-review/); assert.doesNotMatch(r.stdout + r.stderr, /queued/);
});
