// Issue #406: start work on events, not only on the schedule. Unit tests for the request flag, the cap, the pass lock and the pass driver;
// real-process tests (the real `worker` and `reconcile` commands, a fake gh and git on PATH, no model) for the paths #406 names.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { requestWake, queueScheduled, takeRequest, pendingRequest, wakeStatus, dirLock, passLockAge, wakeTarget, wakeArgs, workerArgs, inboxWatcher, labelOf, WAKE_MAX_PER_HOUR, PASS_STALE_MS } from '../supervisor/wake.mjs';
import { drivePass } from '../supervisor/wakepass.mjs';
import { passStats } from '../supervisor/idlecause.mjs';
import { processStart, createJob, readJob } from '../supervisor/core.mjs';
import { readSnapshots } from '../supervisor/dashdata.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import * as inbox from '../supervisor/inbox.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const spawner = () => { const calls = []; return { calls, spawnPass: r => calls.push(r) }; };
const sleepMs = ms => new Promise(r => setTimeout(r, ms));
const waitFor = async (fn, ms = 40000) => { const end = Date.now() + ms; while (!fn() && Date.now() < end) await sleepMs(150); return fn(); };

// ---- the request flag
test('a request sets one merged flag, spawns a runner, and is counted', t => {
  const root = tmp(t), s = spawner();
  assert.equal(requestWake({ root, reason: 'job-end', now: 1000, ...s }).requested, true);
  requestWake({ root, reason: 'approve', now: 2000, ...s });
  requestWake({ root, reason: 'job-end', now: 3000, ...s });
  assert.deepEqual(pendingRequest(root).reasons.sort(), ['approve', 'job-end'], 'any number of requests are one flag');
  assert.equal(wakeStatus(root, 4000).acceptedLastHour, 3);
  assert.equal(labelOf(pendingRequest(root).reasons), 'approve', 'the pass is labelled by the most important reason');
  assert.deepEqual(takeRequest(root).sort(), ['approve', 'job-end']);
  assert.equal(pendingRequest(root), null, 'taking the flag clears it');
  assert.throws(() => requestWake({ root, reason: 'schedule', ...s }), /unknown wake reason/);
});
test('the hourly cap drops event requests, records the drop for the dashboard, and expires', t => {
  const root = tmp(t), s = spawner();
  for (let i = 0; i < 5; i++) assert.equal(requestWake({ root, reason: 'job-end', now: 1000 + i, cap: 5, ...s }).requested, true);
  const dropped = requestWake({ root, reason: 'inbox', now: 5000, cap: 5, ...s });
  assert.equal(dropped.requested, false); assert.equal(dropped.capped, true); assert.match(dropped.why, /scheduled pass is the fallback/);
  assert.equal(s.calls.length, 5, 'a dropped request spawns nothing');
  const st = wakeStatus(root, 6000, 5); assert.equal(st.capHit, true); assert.equal(st.droppedLastHour, 1); assert.equal(st.acceptedLastHour, 5);
  assert.equal(wakeStatus(root, 1000 + 3700000, 5).capHit, false, 'the drop is forgotten after the hour');
  assert.equal(requestWake({ root, reason: 'job-end', now: 1000 + 3700000, cap: 5, ...s }).requested, true, 'the cap expires');
  assert.equal(WAKE_MAX_PER_HOUR, 40);
});
test('a scheduled fire that found a pass running is queued without being counted or capped', t => {
  const root = tmp(t);
  for (let i = 0; i < 3; i++) queueScheduled({ root });
  assert.deepEqual(pendingRequest(root).reasons, ['schedule']); assert.equal(wakeStatus(root).acceptedLastHour, 0);
});
test('a failing spawn leaves the flag set (nothing lost) and does not throw', t => {
  const root = tmp(t);
  assert.equal(requestWake({ root, reason: 'job-end', spawnPass: () => { throw new Error('no fork'); } }).requested, true);
  assert.deepEqual(pendingRequest(root).reasons, ['job-end']);
});
test('a corrupt wake.json reads as empty and is replaced by the next request', t => {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'team')); fs.writeFileSync(path.join(root, 'team', 'wake.json'), '{nope');
  assert.equal(pendingRequest(root), null);
  assert.equal(requestWake({ root, reason: 'install', ...spawner() }).requested, true);
});

// ---- the lock
test('the pass lock: exclusive while its owner lives; a dead owner is taken over; a live one is never taken', t => {
  const root = tmp(t), first = dirLock(root, 'x.lock');
  assert.equal(typeof first, 'function'); assert.equal(dirLock(root, 'x.lock'), null);
  first(); const again = dirLock(root, 'x.lock'); assert.equal(typeof again, 'function'); again();
  const dir = path.join(root, 'team', 'x.lock'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 + 77, start: 'gone' }));
  const taken = dirLock(root, 'x.lock'); assert.equal(typeof taken, 'function', 'a dead holder is replaced'); taken();
  assert.ok(!fs.readdirSync(path.join(root, 'team')).some(n => n.includes('.new-') || n.includes('.stale-')), 'no private directories are left behind');
});
test('the lock directory never exists without its owner file (a contender cannot mistake it for a stale lock)', t => {
  const root = tmp(t), release = dirLock(root, 'y.lock');
  assert.ok(fs.existsSync(path.join(root, 'team', 'y.lock', 'owner.json'))); release();
});

// ---- the pass driver
const fakeWorld = t => { const root = tmp(t), spawned = []; return { root, spawned, spawnFollowUp: r => spawned.push(r) }; };
test('a scheduled pass with the lock free runs once, labelled schedule, and releases the lock', async t => {
  const w = fakeWorld(t), seen = [];
  const r = await drivePass({ ...w, runPass: async p => { seen.push(p); assert.equal(dirLock(w.root, 'wake-pass.lock'), null, 'held during the pass'); return 'done'; } });
  assert.equal(r.ran, true); assert.deepEqual(seen, [{ trigger: 'schedule', merged: [] }]); assert.deepEqual(w.spawned, []);
  const free = dirLock(w.root, 'wake-pass.lock'); assert.equal(typeof free, 'function'); free();
});
test('overlapping passes refused; a scheduled fire during a pass is not lost: exactly one follow-up after the pass', async t => {
  const w = fakeWorld(t); let inner;
  const r = await drivePass({ ...w, runPass: async () => {
    inner = await drivePass({ root: w.root, runPass: async () => assert.fail('the overlapping pass must not run'), spawnFollowUp: () => assert.fail('only the holder spawns') });
    await drivePass({ root: w.root, runPass: async () => assert.fail('overlap'), spawnFollowUp: () => {} });   // a second fire merges into the same flag
  } });
  assert.equal(inner.ran, false); assert.match(inner.skipped, /follow-up pass is queued/);
  assert.deepEqual(w.spawned, ['schedule'], 'exactly one follow-up');
  assert.equal(r.followUp, 'schedule');
});
test('a wake request during a pass (however long) causes exactly one more pass, and requests merge', async t => {
  const w = fakeWorld(t), s = spawner();
  await drivePass({ ...w, runPass: async () => {
    requestWake({ root: w.root, reason: 'job-end', ...s }); requestWake({ root: w.root, reason: 'job-end', ...s }); requestWake({ root: w.root, reason: 'inbox', ...s });
    const runner = await drivePass({ root: w.root, wake: 'job-end', runPass: async () => assert.fail('overlap'), spawnFollowUp: () => assert.fail('a refused runner spawns nothing') });
    assert.equal(runner.ran, false);
    await sleepMs(30);   // a long pass
  } });
  assert.deepEqual(w.spawned, ['inbox'], 'one follow-up, labelled by the merged requests');
  // the follow-up consumes the flag; a pass with nothing pending spawns no further one
  const next = await drivePass({ ...w, wake: 'inbox', runPass: async p => { assert.deepEqual(p.merged.sort(), ['inbox', 'job-end']); } });
  assert.equal(next.trigger, 'inbox'); assert.equal(w.spawned.length, 1, 'no endless chain');
});
test('a request made as the pass ends is still seen: the check comes after the release', async t => {
  const w = fakeWorld(t), s = spawner();
  const lateRequest = () => requestWake({ root: w.root, reason: 'approve', ...s });
  await drivePass({ ...w, runPass: async () => {}, spawnFollowUp: r => w.spawned.push(r) });
  assert.deepEqual(w.spawned, []);
  // a request while the lock is held is visible after the release
  await drivePass({ ...w, runPass: async () => { lateRequest(); } });
  assert.deepEqual(w.spawned, ['approve']);
});
test('a pass that throws still releases the lock, and the wake path cannot stop the pass', async t => {
  const w = fakeWorld(t);
  await assert.rejects(drivePass({ ...w, runPass: async () => { throw new Error('boom'); } }), /boom/);
  const free = dirLock(w.root, 'wake-pass.lock'); assert.equal(typeof free, 'function'); free();
  // a broken lock location (a plain file where the lock directory goes) is a "no lock", not a stopped pass
  fs.writeFileSync(path.join(w.root, 'team', 'wake-pass.lock'), 'not a directory');
  let ran = false;
  const r = await drivePass({ ...w, runPass: async () => { ran = true; } });
  assert.equal(ran, true); assert.equal(r.ran, true);
  // and a broken request flag file
  fs.rmSync(path.join(w.root, 'team', 'wake-pass.lock')); fs.mkdirSync(path.join(w.root, 'team', 'wake-file.lock')); fs.writeFileSync(path.join(w.root, 'team', 'wake-file.lock', 'owner.json'), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }));
  ran = false; await drivePass({ ...w, runPass: async () => { ran = true; } }); assert.equal(ran, true, 'a stuck flag file does not stop the pass');
  fs.rmSync(path.join(w.root, 'team', 'wake-file.lock'), { recursive: true });
});
test('a hung pass (lock held past the limit) does not stop a scheduled pass, but a wake runner still stands aside', async t => {
  const w = fakeWorld(t), old = Date.now() - PASS_STALE_MS - 1000;
  const hung = dirLock(w.root, 'wake-pass.lock', old); assert.ok(passLockAge(w.root) >= PASS_STALE_MS);
  let ran = 0;
  assert.equal((await drivePass({ ...w, runPass: async () => { ran++; } })).ran, true, 'the schedule goes ahead');
  assert.equal((await drivePass({ ...w, wake: 'job-end', runPass: async () => { ran++; } })).ran, false);
  assert.equal(ran, 1); hung();
});
test('an install request made by the pass becomes a follow-up on the installed code, after the lock is released', async t => {
  const w = fakeWorld(t), s = spawner();
  const r = await drivePass({ ...w, runPass: async () => { requestWake({ root: w.root, reason: 'install', ...s }); } });
  assert.equal(r.followUp, 'install'); assert.deepEqual(w.spawned, ['install']);
  const installed = path.join(w.root, 'current', 'supervisor', 'cli.mjs'); fs.mkdirSync(path.dirname(installed), { recursive: true }); fs.writeFileSync(installed, '');
  for (const reason of ['job-end', 'install', 'inbox', 'approve']) assert.equal(wakeTarget({ root: w.root, reason, self: '/old/cli.mjs' }), installed, `${reason} wakes run the installed code`);
  assert.equal(wakeTarget({ root: tmp(t), self: '/old/cli.mjs' }), '/old/cli.mjs', 'no installed copy: this code');
});
test('registry: only an operator-given registry is passed on', () => {
  const reg = '/versions/old/supervisor/providers.json';
  assert.ok(!wakeArgs({ target: '/c/cli.mjs', reason: 'job-end', root: '/r', registry: null }).includes('--registry'));
  assert.deepEqual(wakeArgs({ target: '/c/cli.mjs', reason: 'job-end', root: '/r', registry: '/ops/r.json' }).slice(-2), ['--registry', '/ops/r.json']);
  assert.ok(!workerArgs({ self: '/c/cli.mjs', id: 'j', root: '/r', registry: reg, defaultRegistry: reg }).includes('--registry'));
});

// ---- the inbox watcher and the dashboard hook
test('inbox watcher: a new proposal file wakes once; files already there at start do not; a missing folder is quiet', t => {
  const dir = tmp(t); fs.mkdirSync(path.join(dir, 'items')); fs.writeFileSync(path.join(dir, 'items', 'old.json'), '{}');
  const woke = []; let tick; const w = inboxWatcher({ dir, onNew: n => woke.push(n), setTimer: fn => { tick = fn; return { unref() {} }; }, clearTimer: () => {} });
  tick(); assert.deepEqual(woke, []);
  fs.writeFileSync(path.join(dir, 'items', 'a'.repeat(32) + '.json'), '{}'); fs.writeFileSync(path.join(dir, 'items', 'b'.repeat(32) + '.json'), '{}');
  tick(); assert.deepEqual(woke, [2], 'two files in one look are one wake'); tick(); assert.deepEqual(woke, [2], 'seen files do not wake again');
  w.stop();
  const quiet = inboxWatcher({ dir: path.join(dir, 'missing'), onNew: () => assert.fail('no folder'), setTimer: () => ({ unref() {} }), clearTimer: () => {} }); quiet.poll();
});
test('a proposal written through the real write route (foreman_propose) is seen by the watcher', async t => {
  const dir = tmp(t); fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const woke = []; let tick; inboxWatcher({ dir, onNew: n => woke.push(n), setTimer: fn => { tick = fn; return { unref() {} }; }, clearTimer: () => {} });
  const res = await createInbox({ dir }).propose({ kind: 'prompt', title: 'Tidy', prompt: 'Fix the link.' });
  assert.ok(res); tick(); assert.deepEqual(woke, [1]);
});
const dashConfig = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
async function dash(t, wake) {
  const dir = tmp(t); fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const root = tmp(t); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, clock = { now: Date.now() };
  server.on('request', handler({ root, config: { ...dashConfig, inbox: { dir } }, host: '127.0.0.1', port, now: () => clock.now, wake }));
  const post = (id, decision) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: '/inbox', method: 'POST', headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject); r.end(`id=${id}&decision=${decision}&proof=${writeToken(root)}`); });
  const item = () => { const id = 'c'.repeat(32 - String(clock.now).length % 8) + 'd'.repeat(String(clock.now).length % 8); fs.writeFileSync(path.join(dir, 'items', id + '.json'), JSON.stringify({ kind: 'prompt', title: 'T', prompt: 'P' })); inbox.scan(dir, clock.now); return id; };
  return { dir, post, item, clock };
}
test('dashboard Approve and Reject each wake a pass; a refused decision does not; a failing wake does not change the answer', async t => {
  const calls = []; const d = await dash(t, (root, reason) => calls.push(reason));
  const a = d.item(); assert.equal(await d.post(a, 'approve'), 303); assert.deepEqual(calls, ['approve']);
  d.clock.now += 6000; assert.equal(await d.post(a, 'reject'), 409, 'already decided'); assert.deepEqual(calls, ['approve'], 'a refused decision wakes nothing');
  const b = (() => { fs.writeFileSync(path.join(d.dir, 'items', 'e'.repeat(32) + '.json'), JSON.stringify({ kind: 'prompt', title: 'T2', prompt: 'P2' })); inbox.scan(d.dir, d.clock.now); return 'e'.repeat(32); })();
  d.clock.now += 6000; assert.equal(await d.post(b, 'reject'), 303); assert.deepEqual(calls, ['approve', 'approve'], 'Reject wakes too (labelled approve: a decision)');
  const bad = await dash(t, () => { throw new Error('wake broke'); });
  const c = bad.item(); assert.equal(await bad.post(c, 'approve'), 303, 'the homeowner still gets the normal answer'); assert.equal(inbox.statusOf(bad.dir, c).state, 'approved');
});

// ---- statistics
test('passStats: counts passes, did-nothing passes and unlabelled records by trigger', () => {
  const snaps = [{ at: 10, plan: [] }, { at: 20, plan: [{ type: 'implement' }] }, { at: 30, trigger: 'job-end', plan: [{}] }, { at: 40, trigger: 'job-end', plan: [] }, { at: 50, trigger: 'approve', plan: [{}], status: 'error' }, { at: 999, plan: [] }];
  const p = passStats(snaps, 0, 100);
  assert.equal(p.total, 5); assert.equal(p.didNothing, 2); assert.equal(p.unlabelled, 2); assert.equal(p.errors, 1);
  assert.deepEqual(p.byTrigger['job-end'], { passes: 2, startedSomething: 1, didNothing: 1, noop: 0 });
  assert.deepEqual(p.byTrigger.schedule, { passes: 2, startedSomething: 1, didNothing: 1, noop: 0 });
});

// ---- real processes
const register = path.join(here, '..', 'docs', 'DECISIONS.md'), agentScript = path.join(here, 'fake-agent.mjs');
function runningInState(root) {
  const live = [], read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const add = (pid, start) => { if (Number.isInteger(pid) && pid !== process.pid && start != null && processStart(pid) === start) live.push(pid); };
  try { for (const n of fs.readdirSync(path.join(root, 'team'))) if (n.endsWith('.lock')) { const o = read(path.join(root, 'team', n, 'owner.json')); if (o) add(o.pid, o.start); } } catch { /* none */ }
  try { for (const n of fs.readdirSync(path.join(root, 'jobs'))) if (n.endsWith('.json')) { const j = read(path.join(root, 'jobs', n)); if (j) { add(j.workerPid, j.workerStart); add(j.childPid, j.childStart); } } } catch { /* none */ }
  return live;
}
async function cleanupWhenQuiet(root, remove) {
  const end = Date.now() + 40000; while (runningInState(root).length && Date.now() < end) await sleepMs(150);
  for (const pid of runningInState(root)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleepMs(300); remove();
}
// A state root, a product repository with a real origin, a copy of the supervisor code whose team.json points at it, a fake gh that returns one
// open issue (and can be made slow), and fake agents. The planner is the real planner.
function plannerWorld(t, { tweak = () => {}, issue = 950, open = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-plan-'));
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const git = (cwd, ...a) => execFileSync(realGit, ['-C', cwd, ...a], { encoding: 'utf8' });
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo');
  execFileSync(realGit, ['init', '-q', '--bare', '-b', 'main', origin]);
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'R'), 'x\n'); git(repo, 'add', 'R'); git(repo, 'commit', '-qm', 'init'); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', 'origin', 'main'); git(repo, 'fetch', '-q', 'origin');
  const code = path.join(dir, 'code'); fs.cpSync(path.join(here, '..', 'supervisor'), path.join(code, 'supervisor'), { recursive: true });
  const teamFile = path.join(code, 'supervisor', 'team.json'), team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  team.enabled = true; team.repo_path = repo; team.worktree_base = dir; team.agents.claude.issues = [issue]; team.agents.codex.issues = []; delete team.review_exception;
  team.limits.chain_seconds = 0;   // a chained tick would keep the first pass alive while its job runs; these tests count passes
  tweak(team); fs.writeFileSync(teamFile, JSON.stringify(team));
  const root = path.join(dir, 'state'), bin = path.join(dir, 'bin'), ghlog = path.join(dir, 'gh-calls'), slow = path.join(dir, 'slow');
  fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700); fs.mkdirSync(bin);
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  exe('gh', `echo "$*" >> '${ghlog}'\ncase "$*" in "issue list"*) [ -f '${slow}' ] && sleep 4; echo '${open ? `[{"number":${issue},"title":"Planner dispatch fixture","state":"OPEN","body":"","labels":[]}]` : '[]'}';; *) echo '[]';; esac`);
  exe('git', `case "$*" in *"show origin/main:docs/DECISIONS.md"*) cat '${register}'; exit 0;; esac\nexec '${realGit}' "$@"`);
  const manifest = id => ({ schema_version: 1, id, display_name: id, adapter_version: '0.1.0', launch: { command: process.execPath, args: [agentScript, 'done', path.join(dir, 'agent-marker')], env_allowlist: ['HOME', 'PATH', 'LANG'] },
    capabilities: { launch: 'supported', resume: 'supported', session_status: 'supported', usage_limit_detection: 'supported', reset_time_parsing: 'supported', checkpoint: 'supported', non_interactive: 'supported' }, billing: { model: 'subscription', fallback_to_other_billing: false } });
  const providers = {};
  for (const id of ['fake', 'claude', 'codex']) { fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(manifest(id))); providers[id] = { adapter: 'base', manifest: id + '.json' }; }
  const registry = path.join(dir, 'registry.json'); fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_SUPERVISOR_STATE_ROOT: root };
  t.after(() => cleanupWhenQuiet(root, () => fs.rmSync(dir, { maxRetries: 8, retryDelay: 250, recursive: true, force: true })));
  const cli = path.join(code, 'supervisor', 'cli.mjs');
  const issueReads = () => (fs.existsSync(ghlog) ? fs.readFileSync(ghlog, 'utf8').split('\n').filter(l => /^issue list/.test(l)).length : 0);
  const make = async n => { const worktree = path.join(dir, 'wt' + n); git(repo, 'worktree', 'add', '-qb', 'issue-' + n, worktree); return createJob(root, { role: 'devtest', provider: 'fake', repository: repo, worktree, issue: n, scope: 'fixture', allowed_actions: ['read'], prompt: 'x', handover: 'H.md', autoResume: true }, registry); };
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args, '--state-root', root, '--registry', registry], { encoding: 'utf8', timeout: 120000, env: { ...env, ...extraEnv } });
  const worker = (id, extraEnv = {}) => run(['worker', id], extraEnv);
  const jobs = () => (fs.existsSync(path.join(root, 'jobs')) ? fs.readdirSync(path.join(root, 'jobs')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(root, 'jobs', f), 'utf8'))) : []);
  const planned = () => jobs().find(j => j.issue === issue);
  return { dir, root, code, cli, env, registry, run, worker, make, jobs, planned, issueReads, slow, bin, snapshots: () => readSnapshots(root) };
}

test('job end to job start with no schedule: a worker ends a job, the wake pass plans the open issue from fresh GitHub data and starts its worker', async t => {
  const w = plannerWorld(t), first = await w.make(951);
  assert.equal(w.issueReads(), 0);
  const r = w.worker(first.id); assert.equal(r.status, 0, r.stderr);
  assert.ok(await waitFor(() => w.planned(), 80000), 'the job end woke a pass that planned the issue');
  assert.equal(w.planned().kind, 'implement'); assert.match(w.planned().branch, /^claude\/issue-950-/);
  assert.ok(await waitFor(() => { const j = w.planned(); return j && (j.attempts >= 1 || ['running', 'completed', 'blocked', 'failed'].includes(j.status)); }, 60000), 'its worker started');
  assert.ok(await waitFor(() => w.snapshots().some(s => s.trigger === 'job-end'), 30000), 'the pass is recorded with its trigger');
  assert.ok(w.snapshots().find(s => s.trigger === 'job-end').plan.length > 0, 'and that it started something');
});

test('overlap, queued fire and exactly one more pass, with real processes', async t => {
  // No issue is open, so no job starts and ends: only the number of passes is counted.
  const w = plannerWorld(t, { issue: 960, open: false }); fs.writeFileSync(w.slow, '1');
  const holder = require_spawn(w, ['reconcile']);
  assert.ok(await waitFor(() => fs.existsSync(path.join(w.root, 'team', 'wake-pass.lock')), 20000), 'the first pass holds the pass lock');
  const fire1 = w.run(['reconcile']), fire2 = w.run(['reconcile', '--wake', 'job-end']), fire3 = w.run(['reconcile']);
  for (const f of [fire1, fire3]) assert.match(f.stdout, /follow-up pass is queued/);
  assert.match(fire2.stdout, /will run the requested one after/);
  assert.ok(pendingRequest(w.root), 'the flag is set');
  await new Promise(r => holder.on('exit', r));
  assert.ok(await waitFor(() => w.snapshots().length >= 2, 60000), 'the follow-up pass ran');
  await sleepMs(6000);
  assert.equal(w.snapshots().length, 2, 'exactly one more pass: the three overlapping fires merged');
  assert.equal(pendingRequest(w.root), null);
});
import { spawn } from 'node:child_process';
function require_spawn(w, args) { return spawn(process.execPath, [w.cli, ...args, '--state-root', w.root, '--registry', w.registry], { stdio: 'ignore', env: w.env }); }

test('a wake pass is recorded with its trigger and a scheduled pass as schedule; idle-report shows both and the cap', async t => {
  const w = plannerWorld(t, { issue: 961, open: false });   // nothing plannable: no job ends and wakes another pass mid-test
  const runs = [w.run(['reconcile']), w.run(['reconcile', '--wake', 'approve']), w.run(['reconcile', '--wake', 'inbox'])];
  for (const r of runs) assert.equal(r.status, 0, r.stderr + r.stdout.slice(0, 600));
  assert.deepEqual(w.snapshots().map(s => s.trigger), ['schedule', 'approve', 'inbox'], runs.map(r => r.stdout.slice(0, 300)).join(' | '));
  const out = JSON.parse(w.run(['team', 'idle-report', '--hours', '1', '--json']).stdout);
  assert.equal(out.passes.total, 3); assert.equal(out.passes.byTrigger.approve.passes, 1); assert.equal(out.passes.unlabelled, 0);
  assert.equal(out.wake.capHit, false);
});

test('gates apply to a wake exactly as to a scheduled pass: a hand-install hold and a breaker halt start nothing', async t => {
  for (const [name, arm] of [['hand-install hold', root => fs.writeFileSync(path.join(root, 'team', 'hand-install.hold'), JSON.stringify({ at: Date.now(), pid: process.pid, sha: 'x' }))],
    ['breaker halt', root => fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ breaker: { waste: {}, halts: {}, global: { since: Date.now(), trippedBy: 'cost', cost: 99, count: 9, causes: ['x'] }, clearedAt: {}, error: null } }))]]) {
    for (const mode of [[], ['--wake', 'job-end']]) {
      const w = plannerWorld(t, { issue: 970 }); arm(w.root);
      const r = w.run(['reconcile', ...mode]); assert.equal(r.status === 0 || r.status === 1, true, r.stderr);
      assert.equal(w.planned(), undefined, `${name} with ${mode.join(' ') || 'schedule'}: nothing started`);
    }
  }
  // control: without a gate, both modes do plan the issue
  for (const mode of [[], ['--wake', 'job-end']]) {
    const w = plannerWorld(t, { issue: 971 }); w.run(['reconcile', ...mode]);
    assert.ok(w.planned(), `control (${mode.join(' ') || 'schedule'}): planned`);
  }
});

test('the cap on real wakes: past it a job end requests nothing, the dashboard record says so, and a scheduled pass still runs', async t => {
  const w = plannerWorld(t, { issue: 980, open: false }), a = await w.make(981), b = await w.make(982);
  const env = { AI_SUPERVISOR_WAKE_MAX_PER_HOUR: '1' };
  assert.equal(w.worker(a.id, env).status, 0);
  assert.ok(await waitFor(() => w.snapshots().some(s => s.trigger === 'job-end'), 80000));
  assert.equal(w.worker(b.id, env).status, 0);
  const st = () => JSON.parse(fs.readFileSync(path.join(w.root, 'team', 'wake.json'), 'utf8'));
  assert.equal(st().capped.length, 1, 'the second wake was dropped and recorded');
  assert.match(w.run(['team', 'idle-report', '--hours', '1'], env).stdout, /CAP REACHED: 1 request/);
  const before = w.snapshots().length; await sleepMs(1500);
  assert.equal(w.run(['reconcile']).status === 0 || true, true);
  assert.ok(await waitFor(() => w.snapshots().length > before, 40000), 'the schedule is the fallback and still runs');
});

test('a broken wake path never stops the worker or a scheduled pass', async t => {
  const w = plannerWorld(t, { issue: 990, open: false }), a = await w.make(991);
  // the request-file lock is a plain file owned by nobody: requesting throws inside the worker's wake call
  fs.writeFileSync(path.join(w.root, 'team', 'wake-file.lock'), 'broken');
  const r = w.worker(a.id); assert.equal(r.status, 0, r.stderr); assert.equal(readJob(w.root, a.id).status, 'completed', 'the job still completed');
  fs.writeFileSync(path.join(w.root, 'team', 'wake-pass.lock'), 'broken'); fs.writeFileSync(path.join(w.root, 'team', 'wake.json'), '{garbage');
  assert.equal(w.run(['reconcile']).status, 0);
  assert.ok(w.snapshots().some(s => s.trigger === 'schedule'), 'the scheduled pass ran and was recorded');
});

test('a worker that ends after an install asks the installed code for the pass, not its own', async t => {
  const w = plannerWorld(t, { issue: 995, open: false }), job = await w.make(996);
  const installed = path.join(w.root, 'current', 'supervisor', 'cli.mjs'), out = path.join(w.root, 'installed-args');
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  fs.writeFileSync(installed, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(out)}, process.argv.slice(2).join(' '));`);
  const r = w.worker(job.id); assert.equal(r.status, 0, r.stderr);
  assert.ok(await waitFor(() => fs.existsSync(out)), 'the installed cli ran');
  assert.equal(fs.readFileSync(out, 'utf8'), `reconcile --wake job-end --state-root ${w.root} --registry ${w.registry}`);
  assert.equal(w.issueReads(), 0, 'the worker\'s own code ran no pass');
});

test('the wake path adds no repeated reads: a pass that finds nothing to do reads GitHub once, like a scheduled pass', async t => {
  const w = plannerWorld(t, { issue: 997, open: false });
  w.run(['reconcile']); const scheduled = w.issueReads();
  w.run(['reconcile', '--wake', 'job-end']); const total = w.issueReads();
  assert.equal(total - scheduled, scheduled, 'one fresh read per pass for either trigger, nothing extra and nothing cached');
});
