// Issue #448: test runs must not overload Tower or hold up ticks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { acquireTestSlot, testSlotStatus, withTestSlot } from '../supervisor/testslots.mjs';
import { recordSkip, readSkips } from '../supervisor/skips.mjs';
import { testRunsCard } from '../supervisor/suphealth.mjs';
import { realDeps } from '../supervisor/upgrade.mjs';
import { validateTeamConfig, tickLock, upgradeLock } from '../supervisor/team.mjs';
import { restartDashboardServer } from '../supervisor/upgrade.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-448-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
const fast = { pollMs: 5, sleep: ms => new Promise(r => setTimeout(r, ms)) };

test('the slot limit holds: with a limit of 2 the third run waits, is shown as waiting, and starts when one ends (first in, first out)', async t => {
  const root = tmp(t);
  const a = await acquireTestSlot(root, { limit: 2, label: 'review of #1', ...fast });
  const b = await acquireTestSlot(root, { limit: 2, label: 'install check', ...fast });
  let cGot = false, dGot = false;
  const cP = acquireTestSlot(root, { limit: 2, label: 'review of #2', ...fast }).then(r => { cGot = true; return r; });
  await new Promise(r => setTimeout(r, 30));
  const dP = acquireTestSlot(root, { limit: 2, label: 'review of #3', ...fast }).then(r => { dGot = true; return r; });
  await new Promise(r => setTimeout(r, 50));
  const st = testSlotStatus(root, 2);
  assert.equal(st.running.length, 2); assert.deepEqual(st.waiting.map(w => w.label), ['review of #2', 'review of #3']);
  assert.equal(cGot || dGot, false, 'nothing beyond the limit runs');
  a();
  const c = await cP; assert.ok(c); assert.equal(dGot, false, 'the earlier waiter goes first');
  assert.deepEqual(testSlotStatus(root, 2).waiting.map(w => w.label), ['review of #3']);
  b(); const d = await dP; assert.ok(d);
  c(); d();
  const end = testSlotStatus(root, 2); assert.equal(end.running.length, 0); assert.equal(end.waiting.length, 0);
});

test('a slot held by a process that has died is free again, and a wait that times out never runs the work', async t => {
  const root = tmp(t);
  const dir = path.join(root, 'team', 'test-slots', 'slot-0'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 2147483000, start: 'gone', label: 'dead', since: 1 }));
  assert.equal(testSlotStatus(root, 1).running.length, 0);
  const rel = await acquireTestSlot(root, { limit: 1, label: 'live', ...fast }); assert.ok(rel);
  assert.equal(await acquireTestSlot(root, { limit: 1, label: 'late', timeoutMs: 40, ...fast }), null);
  assert.equal(testSlotStatus(root, 1).waiting.length, 0, 'a timed-out waiter leaves the queue');
  let ran = false;
  const res = await withTestSlot(root, { limit: 1, label: 'x', timeoutMs: 30, ...fast }, () => { ran = true; return { ok: true }; });
  assert.equal(ran, false); assert.equal(res.ok, false); assert.equal(res.environmental, true); assert.match(res.reason, /free test slot/);
  rel();
  assert.deepEqual(await withTestSlot(root, { limit: 1, label: 'y', ...fast }, () => ({ ok: true })), { ok: true });
});

test('install-time tests go through the slot: with the limit used up they wait and do not run; with a free slot they run', async t => {
  const root = tmp(t), repo = tmp(t), ran = [];
  const sha = 'c'.repeat(40); fs.mkdirSync(path.join(root, 'versions', sha), { recursive: true }); fs.symlinkSync(`versions/${sha}`, path.join(root, 'current'));
  const run = (cmd, args) => { ran.push(cmd === 'bash' ? 'bootstrap' : args[2]); return { status: 0, stdout: 'x\n', stderr: '' }; };
  const deps = realDeps({ root, config: { repo_path: repo, agents: {}, limits: { test_slots: 1 } }, gh: {}, listActive: async () => [], verdictFor: () => null, sendAlert: async () => {}, run, slotOptions: { timeoutMs: 40, ...fast } });
  const hold = await acquireTestSlot(root, { limit: 1, label: 'another suite', ...fast });
  const blocked = await deps.preChecks('a'.repeat(40));
  assert.equal(blocked.ok, false); assert.match(blocked.reason, /free test slot/); assert.deepEqual(ran, [], 'no test command started');
  hold();
  await deps.preChecks('a'.repeat(40));
  assert.ok(ran.includes('bootstrap'), 'with a free slot the install check runs');
  assert.equal(testSlotStatus(root, 1).running.length, 0, 'the slot is released afterwards');
});

test('limits.test_slots is validated (1 to 8)', () => {
  const base = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  for (const bad of [0, 9, 1.5, '2']) assert.throws(() => validateTeamConfig({ ...base, limits: { ...base.limits, test_slots: bad } }), /test_slots/);
  validateTeamConfig({ ...base, limits: { ...base.limits, test_slots: 3 } });
});

test('a skipped tick is recorded with its reason and shown on the dashboard card; nothing is recorded when nothing was skipped', t => {
  const root = tmp(t), now = Date.now();
  assert.deepEqual(readSkips(root), []); assert.equal(testRunsCard({ root, config: {}, now }).severity, 'ok');
  recordSkip(root, 'another tick is running and holds the tick lock', now - 1000);
  recordSkip(root, 'old one', now - 7200000);
  assert.equal(readSkips(root).length, 2);
  const card = testRunsCard({ root, config: {}, now });
  assert.equal(card.severity, 'warning'); assert.equal(card.skips.length, 1, 'only the last hour');
  assert.match(card.skips[0].reason, /holds the tick lock/); assert.match(card.notes[0], /did not run/);
});

test('a real tick that finds the tick lock held records the skip with its reason', t => {
  const root = tmp(t), unlock = tickLock(root); t.after(unlock);
  const r = spawnSync(process.execPath, [cli, 'team', 'tick', '--state-root', root], { encoding: 'utf8', timeout: 60000 });
  assert.match(r.stdout, /another tick is running/);
  const skips = readSkips(root); assert.equal(skips.length, 1); assert.match(skips[0].reason, /another tick is running/);
  const rs = spawnSync(process.execPath, [cli, 'record-skip', '--reason', 'reconcile log locked', '--state-root', root], { encoding: 'utf8' });
  assert.equal(rs.status, 0); assert.equal(readSkips(root).length, 2);
  assert.notEqual(spawnSync(process.execPath, [cli, 'record-skip', '--state-root', root], { encoding: 'utf8' }).status, 0, 'a reason is required');
});

test('the install step has its own lock: while another process installs, a tick is not skipped; it only starts no new job', t => {
  const root = tmp(t), tickLockFree = tickLock(root); tickLockFree();   // the tick lock is free
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: false }));
  const unlock = upgradeLock(root); t.after(unlock);
  assert.equal(upgradeLock(root), null, 'a second installer is refused');
  const free = tickLock(root); assert.ok(free, 'the tick lock is not held by the installer'); free();
  const r = spawnSync(process.execPath, [cli, 'reconcile', '--state-root', root], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: process.env.PATH } });
  assert.match(r.stdout, /"selfUpgrade"/, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /"skipped":"another tick/);
});

test('the cron script no longer holds its lock across the run, so an install-time test cannot make it skip', () => {
  const src = fs.readFileSync(new URL('../tools/install-reconcile-user-script.sh', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /flock -n 9 \|\| exit 0/);
  assert.match(src, /flock -w 30 9/); assert.match(src, /record-skip/);
});

test('a test never starts the real dashboard server or writes the live log (issue #448)', async t => {
  const live = process.env.DASHBOARD_LOG || '/mnt/cache/ai-supervisor/dashboard.log';
  const before = (() => { try { const s = fs.statSync(live); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } })();
  const proc = tmp(t), argv = ['node', '/mnt/cache/ai-supervisor/versions/' + 'a'.repeat(40) + '/supervisor/cli.mjs', 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'];
  fs.mkdirSync(path.join(proc, '100')); fs.writeFileSync(path.join(proc, '100', 'cmdline'), argv.join('\0') + '\0');
  const kill = (pid, sig) => { if (sig === 0) { if (!fs.existsSync(path.join(proc, String(pid)))) throw Object.assign(new Error(), { code: 'ESRCH' }); return; } fs.rmSync(path.join(proc, String(pid)), { recursive: true }); };
  // neither start nor startOld injected: the defaults would spawn the real server with a fake path. They must refuse.
  const r = await restartDashboardServer('b'.repeat(40), { procRoot: proc, kill, sleep: async () => {}, tries: 2, health: async () => false });
  assert.equal(r.ok, false);
  assert.match(r.reason, /could not start the dashboard server: refusing to start the real dashboard server from a test run/);
  assert.match(r.reason, /NOT/);
  const after = (() => { try { const s = fs.statSync(live); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } })();
  assert.equal(after, before, 'the live dashboard log did not change');
});
