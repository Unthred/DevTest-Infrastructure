import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestWake, clearPending, waitForTurn, wakePassLock, wakeTarget, WAKE_MAX_PER_HOUR } from '../supervisor/wake.mjs';

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

test('a queued follow-up is never dropped by the hourly cap, and waits longer for the lock than a job-end wake', async t => {
  const root = tmp(t), s = spawner();
  for (let i = 0; i < WAKE_MAX_PER_HOUR; i++) requestWake({ root, reason: 'job-end', now: 1000 + i, ...s, alive: () => false });
  assert.equal(requestWake({ root, reason: 'job-end', now: 5000, ...s, alive: () => false }).requested, false);
  assert.equal(requestWake({ root, reason: 'queued', now: 5001, ...s, alive: () => false }).requested, true, 'the scheduled fire is kept at the cap');
  let clock = 0; const sleep = async ms => { clock += ms; };
  const base = { now: () => clock, sleep, tryLock: () => null, lastTickAt: () => undefined };
  assert.equal((await waitForTurn({ ...base, reason: 'job-end' })).ready, false);
  clock = 0; let polls = 0;
  const late = await waitForTurn({ ...base, reason: 'queued', tryLock: () => (++polls < 100 ? null : () => {}) });   // a pass longer than 2 minutes
  assert.equal(late.ready, true);
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

// ---- the real path, through the real `reconcile` command with a fake gh and git on PATH; no model is called
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processStart } from '../supervisor/core.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'supervisor', 'cli.mjs'), register = path.join(here, '..', 'docs', 'DECISIONS.md');

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-cli-'));
  const root = path.join(dir, 'state'), bin = path.join(dir, 'bin'), ghlog = path.join(dir, 'gh-calls');
  t.after(() => { for (const f of ['wake.json']) { try { const p = JSON.parse(fs.readFileSync(path.join(root, 'team', f), 'utf8')).pending; if (p?.pid) process.kill(p.pid, 'SIGKILL'); } catch { /* none */ } } fs.rmSync(dir, { maxRetries: 8, retryDelay: 250, recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700); fs.mkdirSync(bin);
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  exe('gh', `echo "$*" >> '${ghlog}'\necho "[]"`);
  exe('git', `case "$*" in *"show origin/main:docs/DECISIONS.md"*) cat '${register}';; esac\nexit 0`);
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const run = args => spawnSync(process.execPath, [cli, 'reconcile', ...args, '--state-root', root], { encoding: 'utf8', timeout: 90000, env });
  const ghCalls = () => (fs.existsSync(ghlog) ? fs.readFileSync(ghlog, 'utf8').split('\n').filter(Boolean).length : 0);
  return { run, root, ghCalls, env };
}
const holdPassLock = root => {   // a live process (this one) owns the pass lock, as a running pass would
  const dir = path.join(root, 'team', 'wake-pass.lock'); fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
  return () => fs.rmSync(dir, { recursive: true, force: true });
};

test('a wake pass runs the real reconcile: it plans (reads GitHub), releases the pass lock and clears the pending marker', t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, 'team', 'wake.json'), JSON.stringify({ pending: { pid: 1, start: 'x', reason: 'job-end', at: 1 }, started: [1] }));
  const r = w.run(['--wake', 'install']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(w.ghCalls() > 0, 'the pass planned from a fresh GitHub read');
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.root, 'team', 'wake.json'), 'utf8')).pending, null);
  assert.equal(fs.existsSync(path.join(w.root, 'team', 'wake-pass.lock')), false, 'the pass lock is released at the end');
});

test('overlap refused and nothing lost: a scheduled run during a pass does not run, and queues exactly one follow-up pass', t => {
  const w = world(t), release = holdPassLock(w.root);
  const r = w.run([]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /follow-up pass is queued/); assert.equal(w.ghCalls(), 0, 'the overlapping run planned nothing');
  const s = JSON.parse(fs.readFileSync(path.join(w.root, 'team', 'wake.json'), 'utf8'));
  assert.equal(s.pending.reason, 'queued');
  const again = w.run([]);   // a second fire while the follow-up is still queued is merged into it
  release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.root, 'team', 'wake.json'), 'utf8')).started.length, 1, again.stderr);
});

test('a request during a pass causes exactly one more pass, which runs after the first releases the lock', async t => {
  const w = world(t), release = holdPassLock(w.root);
  const wake = () => requestWake({ root: w.root, reason: 'job-end', spawnWake: why => { const c = spawn(process.execPath, [cli, 'reconcile', '--wake', why, '--state-root', w.root], { detached: true, stdio: 'ignore', env: w.env }); c.unref(); return { pid: c.pid, start: processStart(c.pid) }; }, alive: p => processStart(p.pid) === p.start });
  assert.equal(wake().requested, true);
  assert.equal(wake().requested, false, 'a second request while the extra pass waits is merged');
  assert.equal(w.ghCalls(), 0, 'the extra pass waits while the first holds the lock');
  release();
  const end = Date.now() + 30000;
  while (w.ghCalls() === 0 && Date.now() < end) await new Promise(r => setTimeout(r, 200));
  assert.ok(w.ghCalls() > 0, 'the one extra pass ran after the lock was released');
});

test('a wake after an install runs the installed code, not the code of the process that asked', t => {
  const root = tmp(t), self = '/somewhere/old/supervisor/cli.mjs';
  assert.equal(wakeTarget({ root, reason: 'install', self }), self, 'no installed copy: falls back to this code');
  const installed = path.join(root, 'current', 'supervisor', 'cli.mjs');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(path.join(root, 'ran-installed'))}, process.argv.slice(2).join(' '));`);
  assert.equal(wakeTarget({ root, reason: 'install', self }), installed);
  for (const reason of ['job-end', 'queued', 'install']) assert.equal(wakeTarget({ root, reason, self }), installed, `a ${reason} wake runs the installed code, not the code of the asker`);
  const r = spawnSync(process.execPath, [wakeTarget({ root, reason: 'install', self }), 'reconcile', '--wake', 'install']);
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(root, 'ran-installed'), 'utf8'), 'reconcile --wake install');
});

// ---- the real path from a job ending: the real `worker` command ends a job, which requests a wake pass, which plans and starts work
import { execFileSync } from 'node:child_process';
import { createJob, readJob, stateRoot } from '../supervisor/core.mjs';
const agent = path.join(here, 'fake-agent.mjs');
function jobWorld(t) {
  const w = world(t), dir = path.dirname(w.root);
  const sh = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' });
  const repo = path.join(dir, 'repo'); fs.mkdirSync(repo); sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 't@example.invalid'); sh(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'R'), 'x\n'); sh(repo, 'add', 'R'); sh(repo, 'commit', '-qm', 'init');
  const marker = path.join(dir, 'agent-marker');
  fs.writeFileSync(path.join(dir, 'fake.json'), JSON.stringify({ schema_version: 1, id: 'fake', display_name: 'fake', adapter_version: '0.1.0',
    launch: { command: process.execPath, args: [agent, 'done', marker], env_allowlist: ['HOME', 'PATH', 'LANG'] },
    capabilities: { launch: 'supported', resume: 'supported', session_status: 'supported', usage_limit_detection: 'supported', reset_time_parsing: 'supported', checkpoint: 'supported', non_interactive: 'supported' },
    billing: { model: 'subscription', fallback_to_other_billing: false } }));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { fake: { adapter: 'base', manifest: 'fake.json' } } }));
  const make = async issue => {
    const worktree = path.join(dir, 'wt' + issue); sh(repo, 'worktree', 'add', '-qb', 'issue-' + issue, worktree);
    return createJob(w.root, { role: 'devtest', provider: 'fake', repository: repo, worktree, issue, scope: 'fixture', allowed_actions: ['read'], prompt: 'x', handover: 'H.md', autoResume: true }, registry);
  };
  return { ...w, registry, marker, make, stateRoot };
}
const waitFor = async (fn, ms = 40000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await new Promise(r => setTimeout(r, 200)); return fn(); };

test('job end to work started: a worker finishing its job requests a wake pass that resumes the next waiting job', async t => {
  const w = jobWorld(t);
  const first = await w.make(901), next = await w.make(902);
  const parked = readJob(w.root, next.id); parked.status = 'paused_limit'; parked.nextAttemptAt = 1;   // due, waiting only for a pass
  fs.writeFileSync(path.join(w.root, 'jobs', next.id + '.json'), JSON.stringify(parked));
  const r = spawnSync(process.execPath, [cli, 'worker', first.id, '--state-root', w.root, '--registry', w.registry], { encoding: 'utf8', timeout: 60000, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJob(w.root, first.id).status, 'completed');
  assert.ok(await waitFor(() => readJob(w.root, next.id).status === 'completed'), 'the job end woke a pass that started a worker for the waiting job without the 5-minute tick');
});

test('a job ending after an install wakes the installed code, not the code of the worker that ended', async t => {
  const w = jobWorld(t), job = await w.make(903);
  const installed = path.join(w.root, 'current', 'supervisor', 'cli.mjs'), out = path.join(w.root, 'installed-ran');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(out)}, process.argv.slice(2, 5).join(' '));`);
  const r = spawnSync(process.execPath, [cli, 'worker', job.id, '--state-root', w.root, '--registry', w.registry], { encoding: 'utf8', timeout: 60000, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await waitFor(() => fs.existsSync(out)), 'the wake ran the installed cli');
  assert.equal(fs.readFileSync(out, 'utf8'), 'reconcile --wake job-end');
  assert.equal(w.ghCalls(), 0, 'the worker\'s own (old) code ran no pass');
});

test('a queued follow-up outlasts a pass of any length (a scheduled fire is never dropped), a job-end wake gives up', async () => {
  let clock = 0, polls = 0;
  const sleep = async ms => { clock += ms; };
  const r = await waitForTurn({ reason: 'queued', now: () => clock, sleep, tryLock: () => (++polls < 5000 ? null : () => {}), lastTickAt: () => undefined });   // 5000 polls = over four hours
  assert.equal(r.ready, true); assert.ok(clock > 4 * 3600 * 1000);
});

// ---- review of PR #525: a scheduled fire during a pass must get a follow-up that runs after the pass however long it takes
import { wakeArgs, workerArgs } from '../supervisor/wake.mjs';
test('a queued request is not merged into a pending job-end waiter; the job-end waiter giving up leaves the queued marker', t => {
  const root = tmp(t), s = spawner();
  assert.equal(requestWake({ root, reason: 'job-end', now: 1000, ...s, alive: () => true }).requested, true);
  assert.equal(requestWake({ root, reason: 'queued', now: 1500, ...s, alive: () => true }).requested, true, 'a bounded job-end waiter would lose the scheduled fire');
  assert.equal(requestWake({ root, reason: 'queued', now: 1600, ...s, alive: () => true }).requested, false, 'a second queued request merges into the queued waiter');
  assert.deepEqual(s.calls, ['job-end', 'queued']);
  clearPending(root, 101, () => true);   // the job-end waiter (pid 101) gives up and clears only its own marker
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'team', 'wake.json'), 'utf8')).pending.reason, 'queued');
  clearPending(root, 102, () => true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'team', 'wake.json'), 'utf8')).pending, null);
});

test('real CLI, order of events: lock held, job-end waiter pending, scheduled fire; the waiter gives up, the follow-up still runs after the pass', async t => {
  const w = world(t), release = holdPassLock(w.root);
  const waiter = spawn(process.execPath, [cli, 'reconcile', '--wake', 'job-end', '--state-root', w.root], { stdio: 'ignore', env: { ...w.env, AI_SUPERVISOR_WAKE_LOCK_WAIT_MS: '1500' } });
  t.after(() => waiter.kill('SIGKILL'));
  const exited = new Promise(r => waiter.on('exit', r));
  fs.writeFileSync(path.join(w.root, 'team', 'wake.json'), JSON.stringify({ pending: { pid: waiter.pid, start: processStart(waiter.pid), reason: 'job-end', at: Date.now() }, started: [Date.now()] }));
  const fire = w.run([]);   // the scheduled run finds the pass running
  assert.equal(fire.status, 0, fire.stderr); assert.match(fire.stdout, /follow-up pass is queued/);
  const pending = () => JSON.parse(fs.readFileSync(path.join(w.root, 'team', 'wake.json'), 'utf8')).pending;
  assert.equal(pending().reason, 'queued', 'the claim is true: a queued waiter exists');
  assert.notEqual(pending().pid, waiter.pid);
  await Promise.race([exited, new Promise(r => setTimeout(r, 30000))]);   // the job-end waiter gives up after its bound
  assert.equal(pending()?.reason, 'queued', 'the giving-up waiter did not erase the queued marker');
  assert.equal(w.ghCalls(), 0, 'no pass runs while the first holds the lock');
  release();
  assert.ok(await waitFor(() => w.ghCalls() > 0, 40000), 'the follow-up ran after the pass');
});

test('registry: a wake or worker started without an operator registry passes none; an operator registry is passed on unchanged', () => {
  const reg = '/versions/old/supervisor/providers.json';
  assert.ok(!wakeArgs({ target: '/c/cli.mjs', reason: 'job-end', root: '/r', registry: null }).includes('--registry'));
  const w = wakeArgs({ target: '/c/cli.mjs', reason: 'job-end', root: '/r', registry: '/ops/registry.json' });
  assert.deepEqual(w.slice(-2), ['--registry', '/ops/registry.json']);
  assert.ok(!workerArgs({ self: '/c/cli.mjs', id: 'j', root: '/r', registry: reg, defaultRegistry: reg }).includes('--registry'), 'the default registry is not handed to a worker');
  assert.deepEqual(workerArgs({ self: '/c/cli.mjs', id: 'j', root: '/r', registry: '/ops/registry.json', defaultRegistry: reg }).slice(-2), ['--registry', '/ops/registry.json']);
});

test('registry through the real worker: an operator registry reaches the installed code unchanged', async t => {
  const w = jobWorld(t), job = await w.make(905);
  const installed = path.join(w.root, 'current', 'supervisor', 'cli.mjs'), out = path.join(w.root, 'installed-args');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(out)}, process.argv.slice(2).join(' '));`);
  const r = spawnSync(process.execPath, [cli, 'worker', job.id, '--state-root', w.root, '--registry', w.registry], { encoding: 'utf8', timeout: 60000, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await waitFor(() => fs.existsSync(out)));
  assert.equal(fs.readFileSync(out, 'utf8'), `reconcile --wake job-end --state-root ${w.root} --registry ${w.registry}`);
});

// ---- the whole path of issue #406, with the planner in it: a worker ends a job, the wake pass reads fresh GitHub data, the team tick PLANS an
// implement job for an open issue and starts its worker. The fixture runs a copy of the supervisor code whose shipped team.json points at a
// temporary repository with a real origin; gh is a fake that returns one open issue; git is the real git except the register read.
import { cpSync } from 'node:fs';
function plannerWorld(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-plan-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const git = (cwd, ...a) => execFileSync(realGit, ['-C', cwd, ...a], { encoding: 'utf8' });
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo');
  execFileSync(realGit, ['init', '-q', '--bare', '-b', 'main', origin]);
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'R'), 'x\n'); git(repo, 'add', 'R'); git(repo, 'commit', '-qm', 'init'); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', 'origin', 'main'); git(repo, 'fetch', '-q', 'origin');
  const code = path.join(dir, 'code'); cpSync(path.join(here, '..', 'supervisor'), path.join(code, 'supervisor'), { recursive: true });
  const teamFile = path.join(code, 'supervisor', 'team.json'), team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  team.enabled = true; team.repo_path = repo; team.worktree_base = dir; team.agents.claude.issues = [950]; team.agents.codex.issues = []; delete team.review_exception;
  fs.writeFileSync(teamFile, JSON.stringify(team));
  const root = path.join(dir, 'state'), bin = path.join(dir, 'bin'), ghlog = path.join(dir, 'gh-calls');
  fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700); fs.mkdirSync(bin);
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  exe('gh', `echo "$*" >> '${ghlog}'\ncase "$*" in "issue list"*) echo '[{"number":950,"title":"Planner dispatch fixture","state":"OPEN","body":"","labels":[]}]';; *) echo '[]';; esac`);
  exe('git', `case "$*" in *"show origin/main:docs/DECISIONS.md"*) cat '${register}'; exit 0;; esac\nexec '${realGit}' "$@"`);
  const manifest = id => ({ schema_version: 1, id, display_name: id, adapter_version: '0.1.0',
    launch: { command: process.execPath, args: [agent, 'done', path.join(dir, 'agent-marker')], env_allowlist: ['HOME', 'PATH', 'LANG'] },
    capabilities: { launch: 'supported', resume: 'supported', session_status: 'supported', usage_limit_detection: 'supported', reset_time_parsing: 'supported', checkpoint: 'supported', non_interactive: 'supported' },
    billing: { model: 'subscription', fallback_to_other_billing: false } });
  const providers = {};
  for (const id of ['fake', 'claude', 'codex']) { fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(manifest(id))); providers[id] = { adapter: 'base', manifest: id + '.json' }; }
  const registry = path.join(dir, 'registry.json'); fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  t.after(() => { try { const p = JSON.parse(fs.readFileSync(path.join(root, 'team', 'wake.json'), 'utf8')).pending; if (p?.pid) process.kill(p.pid, 'SIGKILL'); } catch { /* none */ } fs.rmSync(dir, { maxRetries: 8, retryDelay: 250, recursive: true, force: true }); });
  const ghCalls = pat => (fs.existsSync(ghlog) ? fs.readFileSync(ghlog, 'utf8').split('\n').filter(l => pat.test(l)).length : 0);
  const sh = (cwd, ...a) => git(cwd, ...a);
  const make = async issue => { const worktree = path.join(dir, 'wt' + issue); sh(repo, 'worktree', 'add', '-qb', 'issue-' + issue, worktree); return createJob(root, { role: 'devtest', provider: 'fake', repository: repo, worktree, issue, scope: 'fixture', allowed_actions: ['read'], prompt: 'x', handover: 'H.md', autoResume: true }, registry); };
  return { root, registry, env, code, ghCalls, make, cli: path.join(code, 'supervisor', 'cli.mjs') };
}
test('whole path: a job ends, the wake pass plans an implement job for an open issue from fresh GitHub data, and its worker starts', async t => {
  const w = plannerWorld(t), first = await w.make(951);
  assert.equal(w.ghCalls(/^issue list/), 0, 'nothing has read GitHub yet');
  const r = spawnSync(process.execPath, [w.cli, 'worker', first.id, '--state-root', w.root, '--registry', w.registry], { encoding: 'utf8', timeout: 90000, env: w.env });
  assert.equal(r.status, 0, r.stderr);
  const planned = () => fs.readdirSync(path.join(w.root, 'jobs')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(w.root, 'jobs', f), 'utf8'))).find(j => j.issue === 950);
  assert.ok(await waitFor(() => planned(), 80000), `the wake pass planned an implement job for issue 950 (gh issue list calls: ${w.ghCalls(/^issue list/)})`);
  const job = planned();
  assert.equal(job.kind, 'implement'); assert.match(job.branch, /^claude\/issue-950-/);
  assert.ok(await waitFor(() => { const j = planned(); return j && (j.attempts >= 1 || ['running', 'completed', 'blocked', 'failed'].includes(j.status)); }, 60000), 'the worker for the planned job was started');
});
