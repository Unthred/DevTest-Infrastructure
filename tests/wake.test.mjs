import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestWake, clearPending, waitForTurn, wakePassLock, WAKE_MAX_PER_HOUR } from '../supervisor/wake.mjs';
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

test('lock released while waiting: the wake proceeds and hands back the lock it took', async () => {
  let clock = 0, polls = 0, released = 0;
  const sleep = async ms => { clock += ms; };
  const tryLock = () => (++polls < 3 ? null : () => { released++; });
  const r = await waitForTurn({ reason: 'job-end', now: () => clock, sleep, tryLock, lastTickAt: () => undefined });
  assert.equal(r.ready, true); assert.equal(released, 0); r.release(); assert.equal(released, 1);
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

// ---- review round 1: dashboard hold naming, idle causes view, read reuse, idle report
import { cachedReads, READ_TTL_MS } from '../supervisor/readcache.mjs';
import { idleReport } from '../supervisor/idlecause.mjs';
import { idleReason, idleCauseView } from '../supervisor/dashboard.mjs';

const fakeGh = () => { const calls = []; return { calls, listPulls: async () => { calls.push('listPulls'); return [{ number: 1 }]; }, listIssues: async () => { calls.push('listIssues'); return [{ number: 2 }]; }, comment: async () => { calls.push('comment'); }, getPull: async () => { calls.push('getPull'); return {}; } }; };

test('a wake pass reuses fresh list reads recorded by a tick, and makes no list call', async t => {
  const root = tmp(t), g = fakeGh(); let clock = 1000;
  const tick = cachedReads(g, { root, now: () => clock }); await tick.listPulls(); await tick.listIssues();
  clock += 60000;
  const wake = cachedReads(g, { root, reuse: true, now: () => clock });
  assert.deepEqual(await wake.listPulls(), [{ number: 1 }]); await wake.listIssues();
  assert.deepEqual(g.calls, ['listPulls', 'listIssues']); assert.equal(wake.readStats.reused, 2); assert.equal(wake.readStats.fetched, 0);
});

test('stale reads, a normal tick, and reads after a write are fetched again', async t => {
  const root = tmp(t), g = fakeGh(); let clock = 1000;
  await cachedReads(g, { root, now: () => clock }).listPulls();
  clock += READ_TTL_MS + 1;
  await cachedReads(g, { root, reuse: true, now: () => clock }).listPulls();
  assert.equal(g.calls.length, 2, 'stale record is not reused');
  await cachedReads(g, { root, now: () => clock }).listPulls();
  assert.equal(g.calls.length, 3, 'a normal tick always reads');
  const w = cachedReads(g, { root, now: () => clock }); await w.comment(1, 'x');
  await cachedReads(g, { root, reuse: true, now: () => clock }).listPulls();
  assert.equal(g.calls.filter(c => c === 'listPulls').length, 4, 'a write drops the recorded view');
  await w.getPull(1); assert.equal(g.calls.at(-1), 'getPull');
});

const cfg = { repository: 'o/r', enabled: true, agents: { claude: { issues: [], provider: 'claude' } }, limits: { max_fix_attempts: 3 } };
const planned = { agent: 'claude', type: 'implement', issue: 5 };
const names = { issue: n => ({ text: `#${n}` }), pr: n => ({ text: `PR #${n}` }) };
test('the dashboard names the hold for a planned job instead of "on the next tick"', () => {
  const base = { agent: 'claude', config: cfg, team: { c: cfg }, cache: { issues: [], pulls: [] }, plan: [planned], state: 'idle', names };
  const held = idleReason({ ...base, hold: 'upgrade to abc1234 pending' });
  assert.match(held.text, /about to start implement #5; held: upgrade to abc1234 pending/); assert.doesNotMatch(held.text, /on the next tick/);
  assert.match(idleReason(base).text, /no hold applies/);
});

test('idle causes by agent over the last day, and the idle report against the before figures', () => {
  const now = 10 * 3600000, min = 60000;
  const snaps = [{ at: now - 30 * min, idle: { claude: 'no-eligible-work', codex: 'upgrade' }, plan: [] }, { at: now - 20 * min, plan: [{ agent: 'claude' }] }, { at: now - 10 * min, idle: {}, plan: [] }];
  const v = idleCauseView(snaps, now, ['claude', 'codex']);
  assert.equal(v.agents.claude['waiting-for-tick'], 10); assert.equal(v.agents.codex.upgrade, 10);
  const r = idleReport(snaps, { now, hours: 1 });
  assert.equal(r.agents.claude.idleWithWorkPercent, 16.7); assert.equal(r.agents.claude.beforePercent, 35.5); assert.equal(r.agents.codex.beforePercent, 24.8);
});

test('wake pass lock: a second pass cannot take it while the first holds it; the lock is free after release', t => {
  const root = tmp(t);
  const first = wakePassLock(root);
  assert.equal(typeof first, 'function');
  assert.equal(wakePassLock(root), null);
  first();
  const again = wakePassLock(root); assert.equal(typeof again, 'function'); again();
});

test('waitForTurn keeps the lock it took for the whole pass', async () => {
  let held = false;
  const tryLock = () => (held ? null : (held = true, () => { held = false; }));
  const r = await waitForTurn({ reason: 'install', now: () => 0, sleep: async () => {}, tryLock, lastTickAt: () => undefined });
  assert.equal(r.ready, true); assert.equal(held, true); r.release(); assert.equal(held, false);
});
