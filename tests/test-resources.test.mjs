// Issue #574: size classes, admission with fake headroom, unit kill of an over-limit job, no change without a budget.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideGrant, checkClass, readBudget, admit, cgroupWrapper, runLimited, killRecord, validateResourceConfig, classCaps } from '../supervisor/resources.mjs';
import { applyLocalOverride } from '../supervisor/team.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-574-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
const head = (mem, cpus = 8, extra = {}) => ({ memory_available_mb: mem, cpus_available: cpus, pressure: false, ...extra });

test('grant is min(request, class cap, headroom)', () => {
  assert.deepEqual(decideGrant({ klass: 'suite', budget: head(100000) }).limits, { memory_mb: 4096, cpus: 4 }, 'class cap wins');
  assert.deepEqual(decideGrant({ klass: 'suite', budget: head(2000, 2) }).limits, { memory_mb: 2000, cpus: 2 }, 'headroom wins');
  assert.deepEqual(decideGrant({ klass: 'suite', request: { memory_mb: 1500, cpus: 1 }, budget: head(100000) }).limits, { memory_mb: 1500, cpus: 1 }, 'a smaller request wins');
  assert.equal(decideGrant({ klass: 'small', request: { memory_mb: 99999 }, budget: head(100000) }).limits.memory_mb, 1024, 'a request cannot exceed the class cap');
});

test('queue when headroom is under the class minimum, or the host is under pressure', () => {
  assert.equal(decideGrant({ klass: 'suite', budget: head(512) }).action, 'queue');
  assert.equal(decideGrant({ klass: 'small', budget: head(512) }).action, 'grant');
  assert.equal(decideGrant({ klass: 'small', budget: head(0.5 * 1000, 0) }).action, 'queue', 'no CPU');
  const p = decideGrant({ klass: 'small', budget: head(100000, 8, { pressure: true }) });
  assert.equal(p.action, 'queue'); assert.match(p.reason, /pressure/);
});

test('no budget source: granted with no limits (behaviour as before)', () => {
  assert.deepEqual(decideGrant({ klass: 'suite', budget: null }), { action: 'grant', limits: null, class: 'suite' });
  assert.equal(readBudget(undefined), null);
  assert.equal(readBudget('/nonexistent/budget.json'), null);
});

test('readBudget: parses a valid file, rejects garbage', t => {
  const d = tmp(t), f = path.join(d, 'b.json');
  fs.writeFileSync(f, JSON.stringify({ memory_available_mb: 5000, cpus_available: 3, pressure: true, slice: 'agents.slice' }));
  assert.deepEqual(readBudget(f), { memory_available_mb: 5000, cpus_available: 3, pressure: true, slice: 'agents.slice' });
  fs.writeFileSync(f, '{nope'); assert.equal(readBudget(f), null);
  fs.writeFileSync(f, JSON.stringify({ memory_available_mb: -1, cpus_available: 3 })); assert.equal(readBudget(f), null);
  fs.writeFileSync(f, JSON.stringify({ memory_available_mb: 10, cpus_available: 3, slice: 'x; rm -rf /' })); assert.equal(readBudget(f).slice, null);
});

test('agents cannot raise caps: a class above max_class is refused; only the config can raise it', () => {
  assert.equal(checkClass('suite', {}).ok, true);
  const r = checkClass('build', {}); assert.equal(r.ok, false); assert.equal(r.approval, true); assert.match(r.reason, /owner approval/);
  assert.equal(checkClass('build', { max_class: 'build' }).ok, true);
  assert.equal(checkClass('huge', {}).ok, false);
  assert.throws(() => validateResourceConfig({ max_class: 'enormous' }), /max_class/);
  assert.throws(() => validateResourceConfig({ classes: { small: { memory_mb: -5 } } }), /memory_mb/);
  assert.throws(() => validateResourceConfig({ budget_file: 'relative' }), /absolute/);
  assert.equal(classCaps({ classes: { small: { memory_mb: 512 } } }).small.memory_mb, 512);
  assert.equal(applyLocalOverride({}, { test_resources: { max_class: 'build' } }).test_resources.max_class, 'build');
});

test('admit queues under pressure, then grants once the host recovers; times out otherwise', async () => {
  const seq = [head(9000, 8, { pressure: true }), head(9000, 8, { pressure: true }), head(9000)];
  const told = []; let slept = 0;
  const d = await admit({ klass: 'suite', cfg: {}, readB: () => seq.shift(), sleep: async () => { slept++; }, onQueue: r => told.push(r) });
  assert.equal(d.action, 'grant'); assert.equal(slept, 2); assert.equal(told.length, 1);
  let clock = 0;
  const t = await admit({ klass: 'suite', cfg: {}, readB: () => head(9000, 8, { pressure: true }), sleep: async () => { clock += 1000; }, now: () => clock, timeoutMs: 3000 });
  assert.equal(t.action, 'timeout');
});

test('cgroup wrapper: leaf scope under the slice with limits; none when unavailable', () => {
  const g = decideGrant({ klass: 'suite', budget: head(2000, 2, { slice: 'agents.slice' }) });
  const w = cgroupWrapper(g, '12-3');
  assert.deepEqual(w.slice(0, 3), ['systemd-run', '--scope', '--quiet']);
  assert.ok(w.includes('--slice=agents.slice') && w.includes('--unit=devtest-job-12-3') && w.includes('MemoryMax=2000M') && w.includes('CPUQuota=200%'));
  assert.equal(w.at(-1), '--');
  assert.equal(cgroupWrapper(g, 'x', { available: false }), null);
  assert.equal(cgroupWrapper(decideGrant({ klass: 'suite', budget: head(2000) }), 'x'), null, 'no slice configured');
  assert.equal(cgroupWrapper({ limits: null }, 'x', { slice: 'a.slice' }), null);
});

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('an over-limit fake job is killed as a unit: children die with it and the result records why', async t => {
  const d = tmp(t), pidFile = path.join(d, 'child.pid');
  // The parent spawns a grandchild that records its pid, then both hold memory beyond the 64 MB grant.
  const script = `const {spawn}=require('child_process'),fs=require('fs');
    const hold=()=>{globalThis.b=Buffer.alloc(150*1024*1024,1);setInterval(()=>{},1000)};
    if(process.argv[2]==='child'){hold();}else{const c=spawn(process.execPath,[__filename,'child'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));hold();}`;
  const f = path.join(d, 'job.cjs'); fs.writeFileSync(f, script);
  const r = await runLimited([process.execPath, f], { env: process.env, limits: { memory_mb: 64, cpus: 1 }, klass: 'suite', id: 'j1', intervalMs: 50 });
  assert.equal(r.code, 137);
  assert.equal(r.kill.reason, 'memory-limit'); assert.equal(r.kill.class, 'suite'); assert.equal(r.kill.suggested_class, 'small'); assert.equal(r.kill.limit_mb, 64);
  assert.ok(r.kill.observed_mb > 64);
  const grand = Number(fs.readFileSync(pidFile, 'utf8'));
  await new Promise(res => setTimeout(res, 200));
  assert.equal(alive(grand), false, 'the grandchild is gone with its group');
});

test('a job inside its limit exits normally with its own code and no kill record', async () => {
  const r = await runLimited([process.execPath, '-e', 'process.exit(3)'], { env: process.env, limits: { memory_mb: 512, cpus: 1 }, klass: 'small', id: 'j2', intervalMs: 50 });
  assert.equal(r.code, 3); assert.equal(r.kill, null);
  assert.equal(killRecord({ klass: 'small', limitMb: 1, observedMb: 2, id: 'x' }).suggested_class, null, 'nothing smaller than small');
});

test('a leftover background process of a finished limited job is cleaned up with its group', async t => {
  const d = tmp(t), pidFile = path.join(d, 'bg.pid');
  const script = `const {spawn}=require('child_process'),fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setTimeout(()=>process.exit(0),200);`;
  const f = path.join(d, 'j.cjs'); fs.writeFileSync(f, script);
  const r = await runLimited([process.execPath, f], { env: process.env, limits: { memory_mb: 512, cpus: 1 }, klass: 'small', id: 'j3', intervalMs: 50 });
  assert.equal(r.code, 0);
  await new Promise(res => setTimeout(res, 200));
  assert.equal(alive(Number(fs.readFileSync(pidFile, 'utf8'))), false);
});

const runCli = (state, args, cmd) => spawnSync(process.execPath, [cli, 'test-slot', 'run', '--state-root', state, ...args, '--', ...cmd], { encoding: 'utf8', timeout: 60000 });

test('test-slot run end to end: no budget file = runs as before; class above max refused; pressure queues; over-limit recorded', t => {
  const state = tmp(t);
  // no test_resources configured
  let r = runCli(state, ['--no-reuse'], ['echo', 'hi']);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /hi/);
  // a budget file that does not exist: still as before
  fs.writeFileSync(path.join(state, 'team.local.json'), JSON.stringify({ test_resources: { budget_file: path.join(state, 'absent.json') } }));
  r = runCli(state, ['--no-reuse'], ['echo', 'still']); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /still/);
  // build class refused without owner approval
  r = runCli(state, ['--class', 'build'], ['echo', 'x']); assert.equal(r.status, 3); assert.match(r.stderr, /owner approval/);
  // over-limit job under a real budget: killed, recorded
  const budget = path.join(state, 'budget.json'); fs.writeFileSync(budget, JSON.stringify(head(300)));
  fs.writeFileSync(path.join(state, 'team.local.json'), JSON.stringify({ test_resources: { budget_file: budget, classes: { small: { memory_mb: 64, min_memory_mb: 16 } } } }));
  r = runCli(state, ['--class', 'small', '--no-reuse', '--label', 'hog'], [process.execPath, '-e', 'globalThis.b=Buffer.alloc(200*1024*1024,1);setInterval(()=>{},1000)']);
  assert.equal(r.status, 137, r.stderr); assert.match(r.stderr, /killed for exceeding/);
  const rec = JSON.parse(fs.readFileSync(path.join(state, 'team', 'test-job-results.jsonl'), 'utf8').trim());
  assert.equal(rec.reason, 'memory-limit'); assert.equal(rec.class, 'small'); assert.equal(rec.label, 'hog');
});
