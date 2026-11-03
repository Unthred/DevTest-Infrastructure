import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestWake, clearPending, waitForTurn, WAKE_MAX_PER_HOUR } from '../supervisor/wake.mjs';
import { classifyIdle, summarizeIdle } from '../supervisor/idlecause.mjs';
import { installRequired, needsInstall } from '../supervisor/upgrade.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const spawner = () => { const calls = []; return { calls, spawnWake: r => { calls.push(r); return { pid: 100 + calls.length, start: 's' }; } }; };

test('job end requests one wake; a second while one is pending is merged', t => {
  const root = tmp(t), s = spawner();
  assert.equal(requestWake({ root, reason: 'job-end', now: 1000, ...s, alive: () => true }).requested, true);
  const again = requestWake({ root, reason: 'job-end', now: 2000, ...s, alive: () => true });
  assert.equal(again.requested, false); assert.match(again.why, /pending/);
  assert.deepEqual(s.calls, ['job-end']);
});

test('a dead pending wake does not block; clearing the marker allows the next', t => {
  const root = tmp(t), s = spawner();
  requestWake({ root, reason: 'job-end', now: 1000, ...s, alive: () => false });
  assert.equal(requestWake({ root, reason: 'job-end', now: 2000, ...s, alive: () => false }).requested, true);
  clearPending(root);
  assert.equal(requestWake({ root, reason: 'job-end', now: 3000, ...s, alive: () => true }).requested, true);
});

test('wakes are rate capped per hour, the install wake is not, and the cap expires', t => {
  const root = tmp(t), s = spawner();
  for (let i = 0; i < WAKE_MAX_PER_HOUR; i++) assert.equal(requestWake({ root, reason: 'job-end', now: 1000 + i, ...s, alive: () => false }).requested, true);
  const capped = requestWake({ root, reason: 'job-end', now: 5000, ...s, alive: () => false });
  assert.equal(capped.requested, false); assert.match(capped.why, /fallback/);
  assert.equal(requestWake({ root, reason: 'install', now: 5001, ...s, alive: () => true }).requested, true);
  assert.equal(requestWake({ root, reason: 'job-end', now: 1000 + 3700000, ...s, alive: () => false }).requested, true);
});

test('overlap refused: a held tick lock makes the wake wait, then give up; the scheduled tick is the fallback', async () => {
  let clock = 0; const sleeps = [];
  const sleep = async ms => { sleeps.push(ms); clock += ms; };
  const held = await waitForTurn({ reason: 'job-end', now: () => clock, sleep, tryLock: () => null, lastTickAt: () => undefined, lockWaitMs: 10000, pollMs: 3000 });
  assert.equal(held.ready, false); assert.ok(sleeps.length >= 3);
});

test('lock released while waiting: the wake proceeds and releases its probe lock', async () => {
  let clock = 0, polls = 0, released = 0;
  const sleep = async ms => { clock += ms; };
  const tryLock = () => (++polls < 3 ? null : () => { released++; });
  const r = await waitForTurn({ reason: 'job-end', now: () => clock, sleep, tryLock, lastTickAt: () => undefined });
  assert.equal(r.ready, true); assert.equal(released, 1);
});

test('minimum gap after the last tick applies to job-end wakes only', async () => {
  let clock = 100000; const sleeps = [];
  const sleep = async ms => { sleeps.push(ms); clock += ms; };
  const base = { now: () => clock, sleep, tryLock: () => () => {}, lastTickAt: () => 95000 };
  await waitForTurn({ ...base, reason: 'job-end' });
  assert.deepEqual(sleeps, [15000]);
  sleeps.length = 0;
  await waitForTurn({ ...base, reason: 'install' });
  assert.deepEqual(sleeps, []);
});

test('idle cause: upgrade hold, named hold, no eligible work, planned', () => {
  const states = { claude: 'idle', codex: 'running' };
  assert.deepEqual(classifyIdle({ states, held: { reason: 'upgrade to abc pending' } }), { claude: 'upgrade' });
  assert.deepEqual(classifyIdle({ states, idle: { reason: 'reviewer slot full' } }), { claude: 'named-hold' });
  assert.deepEqual(classifyIdle({ states, plan: [] }), { claude: 'no-eligible-work' });
  assert.deepEqual(classifyIdle({ states, plan: [{ agent: 'claude' }] }), { claude: 'waiting-for-tick' });
});

test('idle summary: minutes by cause; no-eligible-work before a planned start counts as waiting for the tick', () => {
  const M = 60000;
  const snaps = [
    { at: 0, idle: { claude: 'no-eligible-work' } },
    { at: 5 * M, idle: { claude: 'upgrade' }, plan: [] },
    { at: 10 * M, idle: { claude: 'no-eligible-work' }, plan: [{ agent: 'claude' }] },
    { at: 15 * M, idle: {}, plan: [] }
  ];
  const r = summarizeIdle(snaps).claude;
  assert.equal(r['no-eligible-work'], 10);   // 0..5 and 10..15: the next snapshot planned nothing for claude
  assert.equal(r.upgrade, 5);
  assert.equal(r['waiting-for-tick'], 0);
  const s2 = summarizeIdle([{ at: 0, idle: { claude: 'no-eligible-work' } }, { at: 5 * M, plan: [{ agent: 'claude' }] }]).claude;
  assert.equal(s2['waiting-for-tick'], 5);
});

test('install list: runtime files install, docs and tests do not, unknown paths install', () => {
  for (const f of ['supervisor/team.mjs', 'bin/ai-supervisor-cron', 'tools/rollback-supervisor.sh', 'package.json', 'something/new.sh', 'tools/bootstrap-install.sh']) assert.equal(needsInstall(f), true, f);
  for (const f of ['tests/a.test.mjs', 'docs/x.md', 'README.md', '.github/workflows/ci.yml', 'tools/ci/check.sh']) assert.equal(needsInstall(f), false, f);
  assert.equal(installRequired(['tests/a.test.mjs', 'docs/x.md']), false);
  assert.equal(installRequired(['tests/a.test.mjs', 'bin/x']), true);   // one runtime file in the range installs everything
  assert.equal(installRequired([]), false);
});
