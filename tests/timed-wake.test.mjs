// Issue #1408: a one-off wake for every time Foreman already knows work becomes startable. The tests drive the real pass end step
// (recordPassEnd), the real timer wiring (createTimedWake) and the real wake module (requestWake) with a fake clock and fake timers;
// the armed time is never set by hand. The real example: the second agent on 14 Nov 2026 with its short window fully used, resetting
// at 08:26:19 UTC, and two jobs paused for the limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTimedWake, recordPassEnd, readNextStartable, MARGIN_MS, MAX_AHEAD_MS } from '../supervisor/timedwake.mjs';
import { requestWake, pendingRequest, wakeStatus, TRIGGERS, labelOf } from '../supervisor/wake.mjs';
import { passStats } from '../supervisor/idlecause.mjs';

const RESET = Date.UTC(2026, 10, 14, 8, 26, 19);
const SIX_TWENTY = Date.UTC(2026, 10, 14, 6, 20, 0);
const config = { agents: { claude: { provider: 'claude' }, codex: { provider: 'codex' } } };
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supervisor', 'cli.mjs');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'timed-wake-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const writeJson = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
const codexReading = (used, resetsAt) => ({ provider: 'codex', status: 'unknown', observedAt: SIX_TWENTY, source: 'probe',
  windows: [{ type: 'primary', windowMinutes: 300, utilization: used, resetsAt, status: 'unknown' }] });
const pausedJob = (id, nextAttemptAt, extra = {}) => (
  { id, provider: 'codex', status: 'paused_limit', nextAttemptAt, ...extra });

const TWO_PAUSED = [pausedJob('a'.repeat(32), RESET + 120000), pausedJob('b'.repeat(32), RESET + 120000)];
function world(t, { reading = codexReading(1, RESET), jobs = TWO_PAUSED, upgrade = null } = {}) {
  const root = tmp(t);
  for (const j of jobs) writeJson(path.join(root, 'jobs', `${j.id}.json`), j);
  if (reading) writeJson(path.join(root, 'dashboard', 'cache.json'), { probes: { codex: reading } });
  if (upgrade) writeJson(path.join(root, 'team', 'self-upgrade.json'), upgrade);
  return root;
}

// A fake clock with fake timers: setTimeout and setInterval only record; advance() runs what became due, in time order.
function fakeTime(start) {
  let now = start, seq = 0;
  const pending = new Map(), sets = [];
  const timers = {
    setTimeout: (fn, ms) => { const h = ++seq; pending.set(h, { fn, at: now + ms }); sets.push(now + ms); return h; },
    clearTimeout: h => pending.delete(h),
    setInterval: (fn, ms) => { const h = ++seq; pending.set(h, { fn, at: now + ms, every: ms }); return h; },
    clearInterval: h => pending.delete(h),
  };
  const advance = to => {
    for (;;) {
      const due = [...pending.entries()].filter(([, x]) => x.at <= to).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [h, x] = due; now = x.at;
      if (x.every) x.at += x.every; else pending.delete(h);
      x.fn();
    }
    now = to;
  };
  const timeouts = () => [...pending.values()].filter(x => !x.every);
  return { now: () => now, timers, advance, sets, timeouts };
}
const harness = (root, clock) => {
  const woke = [];
  const logs = [];
  const wake = () => woke.push(clock.now());
  const timed = createTimedWake({ root, config: () => config, wake, now: clock.now, timers: clock.timers, log: l => logs.push(l) });
  return { timed, woke, logs };
};

test('the second agent on 14 Nov 2026: the pass end records 08:26:19 plus the margin, one timer is armed and the wake fires then', t => {
  const root = world(t), clock = fakeTime(SIX_TWENTY);
  const found = recordPassEnd({ root, config, now: SIX_TWENTY });
  assert.equal(found.at, RESET + MARGIN_MS);
  assert.deepEqual(readNextStartable(root).at, RESET + MARGIN_MS, 'recorded after the pass');
  const { timed, woke } = harness(root, clock);
  assert.equal(timed.armed(), RESET + MARGIN_MS);
  assert.equal(clock.timeouts().length, 1, 'one timer');
  clock.advance(RESET + MARGIN_MS - 1);
  assert.equal(woke.length, 0, 'not before the stated time plus the margin');
  clock.advance(RESET + MARGIN_MS);
  assert.equal(woke.length, 1, 'the wake fires then');
  timed.stop();
});

test('the fire asks for a wake with the known-time reason through the real wake module, and the next time is worked out', t => {
  const root = world(t), clock = fakeTime(SIX_TWENTY), spawned = [];
  recordPassEnd({ root, config, now: SIX_TWENTY });
  const timed = createTimedWake({ root, config: () => config, now: clock.now, timers: clock.timers, log: () => {},
    wake: () => requestWake({ root, reason: 'known-time', now: clock.now(), spawnPass: r => spawned.push(r) }) });
  clock.advance(RESET + MARGIN_MS);
  assert.deepEqual(spawned, ['known-time']);
  assert.deepEqual(pendingRequest(root).reasons, ['known-time']);
  assert.equal(wakeStatus(root, clock.now()).acceptedLastHour, 1);
  assert.equal(timed.armed(), RESET + 120000 + MARGIN_MS, 'the next known time, the two paused jobs attempt time, is armed after the fire');
  timed.stop();
});

test('a job attempt time sooner than the reset replaces the armed time; a time no longer needed is cleared', t => {
  const root = world(t), clock = fakeTime(SIX_TWENTY);
  recordPassEnd({ root, config, now: SIX_TWENTY });
  const { timed } = harness(root, clock);
  assert.equal(timed.armed(), RESET + MARGIN_MS);
  const soon = SIX_TWENTY + 600000;
  writeJson(path.join(root, 'jobs', `${'c'.repeat(32)}.json`), pausedJob('c'.repeat(32), soon, { status: 'queued' }));
  recordPassEnd({ root, config, now: SIX_TWENTY + 1000 });
  timed.sync();
  assert.equal(timed.armed(), soon + MARGIN_MS, 'replaced by the sooner time');
  assert.equal(clock.timeouts().length, 1, 'still one timer');
  for (const f of fs.readdirSync(path.join(root, 'jobs'))) fs.rmSync(path.join(root, 'jobs', f));
  fs.rmSync(path.join(root, 'dashboard', 'cache.json'));
  recordPassEnd({ root, config, now: SIX_TWENTY + 2000 });
  clock.advance(SIX_TWENTY + 7000);   // the poll sees the cleared record
  assert.equal(timed.armed(), null);
  assert.equal(clock.timeouts().length, 0, 'the timer is cleared');
  timed.stop();
});

test('two equal times arm one timer', t => {
  const root = world(t, { jobs: [pausedJob('a'.repeat(32), RESET), pausedJob('b'.repeat(32), RESET)] }), clock = fakeTime(SIX_TWENTY);
  recordPassEnd({ root, config, now: SIX_TWENTY });
  const { timed } = harness(root, clock);
  assert.equal(clock.sets.length, 1, 'one timer was set');
  assert.equal(clock.timeouts().length, 1);
  timed.stop();
});

test('a time 25 hours away is not armed, and the reason is logged', t => {
  const far = SIX_TWENTY + 25 * 3600000;
  const root = world(t, { reading: null, jobs: [pausedJob('a'.repeat(32), far)] }), clock = fakeTime(SIX_TWENTY);
  const logs = [];
  recordPassEnd({ root, config, now: SIX_TWENTY, log: l => logs.push(l) });
  assert.equal(readNextStartable(root), null);
  assert.match(logs.join('\n'), /more than 24 hours away/);
  const { timed } = harness(root, clock);
  assert.equal(timed.armed(), null);
  assert.equal(clock.timeouts().length, 0);
  assert.ok(far - SIX_TWENTY > MAX_AHEAD_MS);
  timed.stop();
});

test('a reading with no reset time arms nothing and logs why', t => {
  const root = world(t, { reading: codexReading(1, null), jobs: [] }), clock = fakeTime(SIX_TWENTY);
  const logs = [];
  const found = recordPassEnd({ root, config, now: SIX_TWENTY, log: l => logs.push(l) });
  assert.equal(found.at, null);
  assert.match(logs.join('\n'), /codex waits on an allowance window but the reading has no future reset time/);
  const { timed, logs: dashLogs } = harness(root, clock);
  assert.equal(timed.armed(), null);
  assert.equal(clock.timeouts().length, 0);
  assert.match(dashLogs.join('\n'), /no known-time wake armed/);
  timed.stop();
});

test('a window that is not used up arms nothing, and nothing waiting is not logged as a problem', t => {
  const root = world(t, { reading: codexReading(0.4, RESET), jobs: [] });
  const logs = [];
  assert.equal(recordPassEnd({ root, config, now: SIX_TWENTY, log: l => logs.push(l) }).at, null);
  assert.deepEqual(logs, []);
});

test('the upgrade retry time counts, and the soonest of all kinds wins', t => {
  const retry = SIX_TWENTY + 300000;
  const root = world(t, { upgrade: { fetchRetryAt: retry } });
  const found = recordPassEnd({ root, config, now: SIX_TWENTY });
  assert.equal(found.at, retry + MARGIN_MS);
  assert.equal(found.source, 'upgrade fetch retry');
});

test('after a restart the time is armed again from state, with no recorded file', t => {
  const root = world(t), clock = fakeTime(SIX_TWENTY);
  assert.equal(readNextStartable(root), null);
  const { timed } = harness(root, clock);
  assert.equal(timed.armed(), RESET + MARGIN_MS);
  timed.stop();
  const second = fakeTime(SIX_TWENTY + 60000), again = harness(root, second);
  assert.equal(again.timed.armed(), RESET + MARGIN_MS, 'a second start arms the same time');
  again.timed.stop();
});

test('the wake module accepts the known-time reason, and diagnostics count passes it started', () => {
  assert.ok(TRIGGERS.includes('known-time'));
  assert.equal(labelOf(['known-time']), 'known-time');
  assert.equal(labelOf(['known-time', 'job-end']), 'job-end', 'a job end still outranks it');
  const stats = passStats([{ at: 100, trigger: 'known-time', plan: [{}] }, { at: 200, trigger: 'known-time', plan: [] }], 0, 1000);
  assert.equal(stats.byTrigger['known-time'].passes, 2);
  assert.equal(stats.byTrigger['known-time'].startedSomething, 1);
  assert.equal(stats.unlabelled, 0);
});

test('the real reconcile command accepts --wake known-time and records the time at the pass end', t => {
  const root = world(t, { jobs: [pausedJob('a'.repeat(32), Date.now() + 3600000)], reading: null });
  fs.chmodSync(root, 0o700);
  const run = wake => spawnSync(process.execPath, [cli, 'reconcile', '--wake', wake, '--state-root', root],
    { encoding: 'utf8', timeout: 120000 });
  const bad = run('no-such-reason');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /unknown --wake value/);
  const ok = run('known-time');
  assert.equal(ok.status, 0, ok.stderr);
  const rec = readNextStartable(root);
  assert.ok(rec && rec.at > Date.now(), 'the pass end recorded the time');
  assert.equal(rec.at, JSON.parse(fs.readFileSync(path.join(root, 'jobs', `${'a'.repeat(32)}.json`), 'utf8')).nextAttemptAt + MARGIN_MS);
});

test('an unreadable local config cannot abort the pass: the result is still printed and nothing is recorded', t => {
  const root = world(t, { jobs: [pausedJob('a'.repeat(32), Date.now() + 3600000)], reading: null });
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'team.local.json'), '{bad');
  const run = spawnSync(process.execPath, [cli, 'reconcile', '--wake', 'known-time', '--state-root', root],
    { encoding: 'utf8', timeout: 120000 });
  assert.doesNotMatch(run.stderr, /ai-supervisor: unreadable team\.local\.json\n\s+at /, 'the pass-end step did not throw');
  assert.doesNotThrow(() => JSON.parse(run.stdout.trim().split('\n').pop()), `the pass printed its result: ${run.stdout}${run.stderr}`);
  assert.match(run.stderr, /known time not recorded/);
});

test('recordPassEnd with a loader that throws logs and returns null', t => {
  const logs = [];
  const out = recordPassEnd({ root: world(t), config: () => { throw new Error('unreadable'); }, log: l => logs.push(l) });
  assert.equal(out, null);
  assert.match(logs.join('\n'), /known time not recorded/);
});
