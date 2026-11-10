// Issue #446: one supported route to install a refused installer update. Fakes for the effects, real files for the hold, the
// journal and team.local.json; the reconciler is the real one, run as a child process against a throw-away state root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handInstall, handInstallHold, HOLD_MAX_MS } from '../supervisor/handinstall.mjs';
import { SelfUpgrade } from '../supervisor/upgrade.mjs';
import { isolatedEnv, INERT_ALERTS } from './helpers/isolated-env.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const FROM = H('a'), TO = H('b');
const LOCAL = JSON.stringify({ enabled: true, limits: { x: 1 }, alerts: INERT_ALERTS }, null, 2) + '\n';

function world(t, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handinst-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root'); fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  const localFile = path.join(dir, 'team.local.json'); fs.writeFileSync(localFile, LOCAL);
  const s = { installed: FROM, running: 0, due: 0, now: 1_000_000, install: { ok: true }, dry: { ok: true }, dash: { ok: true }, answers: { local: true, public: true }, live: { actions: [] }, rb: { ok: true }, log: [], out: [], holdSeen: [], ...over };
  const deps = {
    installed: () => s.installed, now: () => s.now, sleep: async ms => { s.now += ms; s.log.push('sleep'); if (s.onSleep) s.onSleep(); },
    activeJobs: async () => s.running, dueHeld: async () => s.due,
    install: async sha => { s.log.push('install'); s.holdSeen.push(!!handInstallHold(root, { now: s.now, alive: () => true })); if (s.install.ok || s.install.swapped) s.installed = sha; return s.install; },
    dryRunTick: async () => { s.log.push('dry'); return s.dry; },
    restartDashboard: async sha => { s.log.push('dash:' + sha.slice(0, 1)); return s.dash; },
    dashboardAnswers: async () => s.answers,
    liveTick: async () => { s.log.push('live'); s.holdSeen.push(!!handInstallHold(root, { now: s.now, alive: () => true })); return typeof s.live === 'function' ? s.live() : s.live; },
    rollback: async (from, to) => { s.log.push('rollback'); if (s.rb.ok) s.installed = from; return s.rb; },
    record: e => s.log.push('record:' + e.result)
  };
  const run = (sha = TO, extra = {}) => handInstall({ root, sha, deps, say: l => s.out.push(l), pollMs: 10, drainMaxMs: 100, pid: process.pid, ...extra });
  return { dir, root, localFile, s, deps, run, hold: () => handInstallHold(root, { now: s.now, alive: () => true }) };
}

test('success: version moves, hold released, config byte-identical, a progress line per phase and one result', async t => {
  const w = world(t);
  const r = await w.run();
  assert.equal(r.result, 'installed'); assert.equal(r.ok, true);
  assert.equal(w.s.installed, TO);
  assert.deepEqual(w.s.log.filter(x => x !== 'sleep'), ['install', 'dry', 'dash:b', 'live', 'record:verified']);
  assert.equal(w.hold(), null, 'jobs can start again');
  assert.equal(fs.readFileSync(w.localFile, 'utf8'), LOCAL);
  assert.deepEqual(w.s.holdSeen, [true, false], 'held during the install, released for the live tick');
  assert.equal(w.s.out.filter(l => l.startsWith('RESULT:')).length, 1);
  assert.ok(w.s.out.at(-1).startsWith('RESULT: installed'));
  assert.ok(w.s.out.filter(l => /^\[\d\/8\]/.test(l)).length >= 7);
  assert.ok(!/https?:|[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/.test(w.s.out.join('\n')), 'no addresses in output');
});

test('a bad or missing SHA, and an already-installed one, change nothing', async t => {
  const w = world(t);
  for (const sha of ['abc', '', 'main', TO.toUpperCase()]) assert.equal((await w.run(sha)).result, 'refused');
  assert.equal((await w.run(FROM)).result, 'already-installed');
  assert.deepEqual(w.s.log, []); assert.equal(w.hold(), null);
});

test('failed tests: the named test is reported, nothing swapped, new starts resumed', async t => {
  const w = world(t, { install: { ok: false, tests: ['the broken one', 'second'], reason: 'tests failed: the broken one; second' } });
  const r = await w.run();
  assert.equal(r.result, 'not-installed'); assert.equal(r.ok, false);
  assert.match(r.text, /failing tests: the broken one; second/); assert.match(r.text, /nothing was swapped/);
  assert.equal(w.s.installed, FROM); assert.ok(!w.s.log.includes('rollback') && !w.s.log.includes('dry'));
  assert.equal(w.hold(), null); assert.equal(fs.readFileSync(w.localFile, 'utf8'), LOCAL);
});

for (const [name, over, text] of [
  ['dry-run tick', { dry: { ok: false, reason: 'plan broke' } }, /failed \(plan broke\)/],
  ['dashboard restart', { dash: { ok: false, reason: 'no port' } }, /dashboard restart failed: no port/],
  ['dashboard local answer', { answers: { local: false, public: true } }, /not answer locally/],
  ['dashboard public answer', { answers: { local: true, public: false } }, /not answer publicly/],
  ['live tick', { live: { error: 'boom' } }, /failed \(boom\)/]]) {
  test(`failed check (${name}): rollback runs, the old version is confirmed, new starts resumed`, async t => {
    const w = world(t, over);
    const r = await w.run();
    assert.equal(r.result, 'rolled-back'); assert.match(r.text, text); assert.match(r.text, new RegExp(`${FROM.slice(0, 7)} restored and confirmed`));
    assert.equal(w.s.installed, FROM); assert.ok(w.s.log.includes('rollback')); assert.ok(w.s.log.includes('record:rolled_back'));
    assert.equal(w.hold(), null); assert.equal(fs.readFileSync(w.localFile, 'utf8'), LOCAL);
  });
}

test('a rollback that cannot confirm the old version says so; the hold is still released', async t => {
  const w = world(t, { dry: { ok: false, reason: 'x' }, rb: { ok: false, reason: 'no backup' } });
  const r = await w.run();
  assert.equal(r.result, 'rollback-failed'); assert.match(r.text, /NOT confirmed|NOT be confirmed/); assert.equal(w.hold(), null);
});

test('a swap that fails after moving the link is rolled back', async t => {
  const w = world(t, { install: { ok: false, swapped: true, reason: 'swap: half done' } });
  const r = await w.run();
  assert.equal(r.result, 'rolled-back'); assert.equal(w.s.installed, FROM); assert.equal(w.hold(), null);
});

test('drain: waits for running jobs, then installs; a job still running at the bound means nothing changes', async t => {
  const w = world(t, { running: 2 });
  w.s.onSleep = () => { w.s.running = 0; };
  assert.equal((await w.run()).result, 'installed'); assert.ok(w.s.log.includes('sleep'));
  const b = world(t, { running: 1 });
  const r = await b.run();
  assert.equal(r.result, 'not-installed'); assert.match(r.text, /still running/); assert.equal(b.s.installed, FROM);
  assert.ok(!b.s.log.includes('install')); assert.equal(b.hold(), null);
});

test('a due restart during the hold waits and is reported, and is not lost (real reconciler)', async t => {
  const w = world(t, { due: 1 });
  // a real queued job that is due, in the real state root
  fs.chmodSync(w.root, 0o700); const jobs = path.join(w.root, 'jobs'); fs.mkdirSync(jobs, { recursive: true });
  const job = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'queued', autoRestart: true, autoResume: false, nextAttemptAt: 1, capabilities: {}, provider: 'x' };
  fs.writeFileSync(path.join(jobs, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'), JSON.stringify(job));
  fs.mkdirSync(path.join(w.root, 'team'), { recursive: true });
  fs.writeFileSync(path.join(w.root, 'team', 'hand-install.hold'), JSON.stringify({ at: Date.now(), pid: process.pid, to: TO }));
  const cli = path.resolve(import.meta.dirname, '../supervisor/cli.mjs');
  const env = isolatedEnv(w.root, { AI_SUPERVISOR_STATE_ROOT: w.root });
  const held = spawnSync(process.execPath, [cli, 'reconcile', '--state-root', w.root], { encoding: 'utf8', env, timeout: 60000 });
  assert.ok(held.stdout.trim(), held.stderr);
  const heldOut = JSON.parse(held.stdout.trim().split('\n').pop());
  assert.equal(heldOut.held, 1, 'reported'); assert.equal(heldOut.resumed, 0, 'not restarted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(jobs, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json'), 'utf8')).status, 'queued', 'record kept, not lost');
  // (the restart itself is the unchanged reconciler path once the hold file is gone)
  // the run reports the due job during its own drain
  assert.match((await w.run()).result, /installed/); assert.ok(w.s.out.some(l => /1 paused or queued job\(s\) are due/.test(l)));
});

test('hold is live only for a live owner and under the age bound', t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, 'team', 'hand-install.hold'), JSON.stringify({ at: 1000, pid: 4242, to: TO }));
  assert.ok(handInstallHold(w.root, { now: 2000, alive: () => true }));
  assert.equal(handInstallHold(w.root, { now: 2000, alive: () => false }), null, 'owner crashed');
  assert.equal(handInstallHold(w.root, { now: 1000 + HOLD_MAX_MS, alive: () => true }), null, 'too old');
});

test('resume after a crash: a hold left by a dead process is ignored, and the next run rolls back an unverified swap', async t => {
  const w = world(t);
  // an earlier run swapped TO in, then died in the dry-run phase
  w.s.installed = TO;
  fs.writeFileSync(path.join(w.root, 'team', 'hand-install.hold'), JSON.stringify({ at: w.s.now, pid: 2 ** 22 + 7, to: TO }));
  fs.writeFileSync(path.join(w.root, 'team', 'hand-install.json'), JSON.stringify({ from: FROM, to: TO, pid: 2 ** 22 + 7, phase: 'dry-run' }));
  assert.equal(handInstallHold(w.root, { now: w.s.now }), null, 'dead owner: the team is not held');
  const r = await w.run(TO);   // asking again for the same commit
  assert.ok(w.s.log.includes('rollback') && w.s.log.includes('record:rolled_back'), 'recovery undid the unverified swap');
  assert.equal(r.result, 'installed', 'and the fresh run then installed it properly');
  assert.equal(w.hold(), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.root, 'team', 'hand-install.json'), 'utf8')).phase, 'done');
});

test('a crash part-way (thrown error) resumes new starts and undoes the swap', async t => {
  const w = world(t, { live: () => { throw new Error('process died'); } });
  const r = await w.run();
  assert.equal(r.result, 'rolled-back'); assert.equal(w.s.installed, FROM); assert.equal(w.hold(), null);
});

test('the Needs you item and the alert for a refused update carry the exact commit and the one command', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handalert-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const alerts = [];
  const deps = { config: { agents: { claude: { branch_prefix: 'claude/' } } }, installed: () => FROM, fetchMain: () => TO, isAncestor: () => true, changedFiles: () => ['supervisor/team.mjs', 'tools/bootstrap-install.sh'],
    activeJobs: async () => 0, alert: async x => alerts.push(x) };
  const up = new SelfUpgrade({ root: dir, deps, clock: { now: () => 1e7 } });
  assert.equal(await up.step(), 'upgrader-changed');
  const cmd = `/root/bin/ai-supervisor self-upgrade hand-install ${TO}`;
  assert.equal(alerts.length, 1); assert.ok(alerts[0].includes(TO), 'full commit'); assert.ok(alerts[0].includes(cmd), 'the command');
  assert.equal(up.s.handDeploy.command, cmd);
});

test('the real CLI command refuses a malformed SHA with the exact-SHA message', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handinst-cli-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'root'); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const cli = path.resolve(import.meta.dirname, '../supervisor/cli.mjs');
  const r = spawnSync(process.execPath, [cli, 'self-upgrade', 'hand-install', 'not-a-sha', '--state-root', root], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root }, timeout: 60000 });
  const out = r.stdout + r.stderr;
  assert.equal(r.status, 1, out);
  assert.match(out, /RESULT: refused: give the exact full 40-character commit SHA/);
  assert.doesNotMatch(out, /is not defined/);
});

test('issue #708: a verified install tells the upgrader (noteInstalled); a failed one does not', async t => {
  const w = world(t); let n = 0; w.deps.noteInstalled = () => { n++; };
  assert.equal((await w.run()).result, 'installed'); assert.equal(n, 1);
  const f = world(t, { dry: { ok: false, reason: 'x' } }); let m = 0; f.deps.noteInstalled = () => { m++; };
  assert.equal((await f.run()).result, 'rolled-back'); assert.equal(m, 0);
});
