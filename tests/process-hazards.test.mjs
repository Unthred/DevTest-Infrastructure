// Incident 2026-11-04: a suite run under a fake clock left eight busy-looping workers alive for ten hours. These tests pin the cure:
// test workers use no wall-clock deadline, are capped, die with their parent, and `test-slot run` stops the whole process group.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { raceWorkers } from './helpers/workers.mjs';
import { runInGroup, stopGroup, formatRuntime } from '../supervisor/testslots.mjs';
import { runnerGone } from '../supervisor/watchdog.mjs';
import { processInfo } from '../supervisor/core.mjs';

const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hazard-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// a zombie (exited, not yet reaped by init) is not a running process
const alive = pid => { try { process.kill(pid, 0); } catch { return false; } try { return !/^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; } };
const until = async (fn, ms = 5000) => { for (let i = 0; i < ms / 50 && !fn(); i++) await new Promise(r => setTimeout(r, 50)); return fn(); };

test('a parent clock a day ahead cannot make workers spin: they finish quickly and none is left', async () => {
  const realNow = Date.now, pids = [];
  Date.now = () => realNow() + 86400000;   // the faked parent clock of the incident
  const started = performance.now();
  try {
    const res = await raceWorkers(4, 'return "ok";', { capMs: 10000, onSpawn: kids => kids.forEach(k => pids.push(k.pid)) });
    assert.deepEqual(res.map(r => [r.code, r.out]), Array(4).fill([0, 'ok']));
  } finally { Date.now = realNow; }
  assert.ok(performance.now() - started < 8000, 'no worker waited for a wall-clock deadline');
  assert.deepEqual(pids.filter(alive), [], 'no worker outlives the test');
});

test('a worker is capped even if its body never ends, and the harness kills it', async () => {
  const pids = [];
  const started = performance.now();
  const res = await raceWorkers(2, 'await new Promise(() => setInterval(() => {}, 1000));', { capMs: 1500, onSpawn: kids => kids.forEach(k => pids.push(k.pid)) });
  assert.deepEqual(res.map(r => r.code), [97, 97], 'the child cap fired');
  assert.ok(performance.now() - started < 6000);
  assert.deepEqual(pids.filter(alive), []);
});

test('a worker exits when its parent dies', async t => {
  const dir = tmp(t), pidFile = path.join(dir, 'pids');
  const parent = path.join(dir, 'parent.mjs');
  fs.writeFileSync(parent, `import { raceWorkers } from ${JSON.stringify(new URL('./helpers/workers.mjs', import.meta.url).href)}; import fs from 'node:fs';
    raceWorkers(2, 'await new Promise(() => setInterval(() => {}, 1000));', { capMs: 20000, onSpawn: k => fs.writeFileSync(${JSON.stringify(pidFile)}, k.map(x => x.pid).join(',')) }).catch(() => {});
    setInterval(() => {}, 1000);`);
  const p = spawn(process.execPath, [parent], { stdio: 'ignore' });
  assert.ok(await until(() => fs.existsSync(pidFile)));
  const pids = fs.readFileSync(pidFile, 'utf8').split(',').map(Number);
  await new Promise(r => setTimeout(r, 500));
  p.kill('SIGKILL');   // no finally block runs: only the children's own stdin watch can save the host
  assert.ok(await until(() => pids.every(x => !alive(x)), 5000), 'orphaned workers exited');
});

test('no test spawns a child that busy-waits on the wall clock', () => {
  const dir = path.dirname(new URL(import.meta.url).pathname), bad = [];
  for (const f of fs.readdirSync(dir, { recursive: true }).filter(f => /\.mjs$/.test(f) && !f.endsWith('process-hazards.test.mjs'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => { if (/while\s*\(\s*Date\.now\(\)\s*</.test(line)) bad.push(`${f}:${i + 1}`); });
  }
  assert.deepEqual(bad, []);
});

test('runInGroup: a timeout stops the whole group, including grandchildren that ignore TERM', async t => {
  const dir = tmp(t), pidFile = path.join(dir, 'gc');
  const gc = `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
  const script = path.join(dir, 'leader.mjs');
  fs.writeFileSync(script, `import { spawn } from 'node:child_process'; import fs from 'node:fs';
    const c = spawn(process.execPath, ['-e', ${JSON.stringify(gc)}], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
    setInterval(() => {}, 1000);`);
  const run = await runInGroup([process.execPath, script], { env: process.env, maxRuntimeMs: 800, graceMs: 400, stdio: 'ignore' });
  assert.equal(run.timedOut, true); assert.equal(run.code, 124); assert.equal(run.leftover, false);
  assert.ok(await until(() => fs.existsSync(pidFile)));
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false, 'the grandchild is gone');
});

test('runInGroup: a leader that exits normally does not leave orphaned members behind', async t => {
  const dir = tmp(t), pidFile = path.join(dir, 'gc'), script = path.join(dir, 'leader.mjs');
  fs.writeFileSync(script, `import { spawn } from 'node:child_process'; import fs from 'node:fs';
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); setTimeout(() => process.exit(0), 300);`);
  const run = await runInGroup([process.execPath, script], { env: process.env, maxRuntimeMs: 20000, graceMs: 300, stdio: 'ignore' });
  assert.equal(run.code, 0); assert.equal(run.timedOut, false); assert.equal(run.leftover, false);
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
});

test('stopGroup on a finished group is a no-op that reports clean', async () => {
  const c = spawn(process.execPath, ['-e', ''], { detached: true, stdio: 'ignore' });
  await new Promise(r => c.on('exit', r));
  assert.equal(await stopGroup(c.pid, { graceMs: 100 }), true);
});

test('test-slot run --max-minutes stops the run, its grandchildren and returns non-zero; SIGTERM to the runner stops the group too', async t => {
  const state = tmp(t), pidFile = path.join(state, 'gc'), fake = path.join(state, 'node');
  fs.writeFileSync(fake, `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nwait\n`, { mode: 0o755 });
  const env = { ...process.env, AI_SUPERVISOR_TEST_GRACE_MS: '300' };
  const r = spawnSync(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, '--max-minutes', '0.02', '--no-reuse', '--', fake, 'x'], { encoding: 'utf8', timeout: 30000, env, cwd: state });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /maximum runtime/);
  const gone = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(await until(() => !alive(gone), 8000), 'the job\'s child is gone after the timeout');
  fs.rmSync(pidFile);
  const runner = spawn(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, '--no-reuse', '--', fake, 'x'], { env, cwd: state, stdio: 'ignore' });
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim()));
  const sleeper = Number(fs.readFileSync(pidFile, 'utf8'));
  runner.kill('SIGTERM');
  await new Promise(r => runner.on('exit', r));
  assert.ok(await until(() => !alive(sleeper), 8000), 'SIGTERM on the runner reached the job group');
});

test('a SIGKILLed test-slot runner does not orphan the job group: the watchdog kills it', async t => {
  const state = tmp(t), pidFile = path.join(state, 'gc'), fake = path.join(state, 'node');
  fs.writeFileSync(fake, `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nwait\n`, { mode: 0o755 });
  const runner = spawn(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, '--no-reuse', '--', fake, 'x'], { stdio: 'ignore', cwd: state });
  t.after(() => { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } });
  assert.ok(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '', 15000));
  const gc = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(alive(gc), true);
  runner.kill('SIGKILL');
  assert.ok(await until(() => !alive(gc), 8000), 'the job\'s child died with its runner');
});

test('formatRuntime shows seconds for short limits and minutes for long ones', () => {
  assert.equal(formatRuntime(0.05 * 60000), '3 seconds');
  assert.equal(formatRuntime(2 * 3600000), '120 minutes');
});

test('runnerGone: a live runner with its own start time is not gone; a different start time (PID reuse) or a dead PID is', async () => {
  const self = processInfo(process.pid).start;
  assert.equal(runnerGone(process.pid, self), false);
  assert.equal(runnerGone(process.pid, String(Number(self) + 1)), true, 'same PID, different start time: reused');
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(r => c.on('exit', r));
  assert.equal(runnerGone(c.pid, '1'), true);
});

test('runnerGone without /proc (issue #695): with no recorded start time it falls back to kill(pid, 0); with one, unreadable means gone', async () => {
  const noProc = () => null;
  assert.equal(runnerGone(process.pid, null, noProc), false, 'a live PID is not gone when /proc is unreadable and no start was recorded');
  const c = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise(r => c.on('exit', r));
  assert.equal(runnerGone(c.pid, null, noProc), true, 'a dead PID is gone');
  assert.equal(runnerGone(process.pid, '123', noProc), true, 'a recorded start time but unreadable stat: gone');
});

test('the watchdog kills the job group when the runner PID has been reused, and leaves it alone while the runner start time matches', async t => {
  const wdPath = new URL('../supervisor/watchdog.mjs', import.meta.url).pathname;
  const mkGroup = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  const spawnDog = (g, start) => spawn(process.execPath, [wdPath, String(process.pid), start, String(g.pid), String(Date.now() + 30000), '100'], { detached: true, stdio: 'ignore' });
  const good = mkGroup(), reused = mkGroup(); const dogs = [];
  t.after(() => { for (const p of [good, reused, ...dogs]) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } });
  const self = processInfo(process.pid).start;
  dogs.push(spawnDog(good, self), spawnDog(reused, String(Number(self) + 1)));
  assert.ok(await until(() => !alive(reused.pid), 5000), 'the reused-PID case killed the group');
  assert.equal(alive(good.pid), true, 'a matching start time keeps the group');
});

test('gateJob (issue #659): the job runs only after the gate opens, and never when the runner is gone or the gate stays shut', async () => {
  const { gateJob } = await import('../supervisor/watchdog.mjs');
  const { spawnSync, spawn } = await import('node:child_process');
  const os = await import('node:os'); const fsm = await import('node:fs'); const pth = await import('node:path');
  const dir = fsm.mkdtempSync(pth.join(os.tmpdir(), 'gate-test-'));
  const marker = pth.join(dir, 'ran');
  const cmd = ['sh', '-c', `echo ok > ${marker}; exit 7`];
  // 1. positive: opened gate -> command runs, exit code and PID preserved through exec
  const g1 = gateJob(cmd); const c1 = spawn(g1.argv[0], g1.argv.slice(1), { stdio: 'ignore' });
  const done1 = new Promise(r => c1.on('exit', r)); g1.open();
  assert.equal(await done1, 7); assert.ok(fsm.existsSync(marker)); fsm.rmSync(marker); g1.cleanup();
  // 2. negative: runner already gone -> exits 125, command never runs even if the gate opens later
  const dead = spawnSync('true'); const g2 = gateJob(cmd, { runnerPid: dead.pid ?? 2 ** 22 - 1 });
  const c2 = spawnSync(g2.argv[0], g2.argv.slice(1)); g2.open();
  assert.equal(c2.status, 125); assert.equal(fsm.existsSync(marker), false); g2.cleanup();
  // 3. negative: gate never opens -> gives up after the bound
  const g3 = gateJob(cmd, { maxWaitS: 0.2 }); const c3 = spawnSync(g3.argv[0], g3.argv.slice(1));
  assert.equal(c3.status, 125); assert.equal(fsm.existsSync(marker), false); g3.cleanup();
  fsm.rmSync(dir, { recursive: true, force: true });
});
