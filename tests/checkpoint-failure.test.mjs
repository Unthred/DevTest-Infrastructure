// Issue #579: a checkpoint failure is its own event with the real error, a transient git timeout is retried, the job stays resumable,
// and an implement job that ends with no pull request is surfaced at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, checkpoint, GIT_TIMEOUTS, createJob, drive, stateRoot } from '../supervisor/core.mjs';
import { runProcess } from '../supervisor/process.mjs';
import { Team } from '../supervisor/team.mjs';

const J1 = '1'.repeat(32), J2 = '2'.repeat(32);
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-')); t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })); return d; };
const realGit = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const events = (root, id) => fs.readFileSync(path.join(root, 'events', `${id}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l).kind);

function repo(t) {
  const d = tmp(t), r = path.join(d, 'repo'); fs.mkdirSync(r);
  realGit(r, 'init', '-q', '-b', 'main'); realGit(r, 'config', 'user.email', 'a@example.invalid'); realGit(r, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(r, 'f'), 'x'); realGit(r, 'add', 'f'); realGit(r, 'commit', '-qm', 'i');
  return { d, r };
}

test('git: a first call that times out under load is retried and succeeds', t => {
  const { d, r } = repo(t);
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  const realPath = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ ! -e "${d}/seen" ]; then : > "${d}/seen"; sleep 5; fi\nexec ${realPath} "$@"\n`, { mode: 0o755 });
  const saved = [...GIT_TIMEOUTS], oldPath = process.env.PATH;
  GIT_TIMEOUTS.splice(0, GIT_TIMEOUTS.length, 300, 5000);
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; GIT_TIMEOUTS.splice(0, GIT_TIMEOUTS.length, ...saved); });
  assert.match(git(r, 'rev-parse', 'HEAD'), /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(path.join(d, 'seen')));
});

test('git: a call that always times out fails naming the timeout; a real failure keeps its reason', t => {
  const { d, r } = repo(t);
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  const saved = [...GIT_TIMEOUTS], oldPath = process.env.PATH;
  GIT_TIMEOUTS.splice(0, GIT_TIMEOUTS.length, 100, 100);
  process.env.PATH = `${bin}:${oldPath}`;
  assert.throws(() => git(r, 'rev-parse', 'HEAD'), /Git check failed: rev-parse: timed out after 2 attempts/);
  process.env.PATH = oldPath; GIT_TIMEOUTS.splice(0, GIT_TIMEOUTS.length, ...saved);
  assert.throws(() => git(d, 'rev-parse', 'HEAD'), /Git check failed: rev-parse: .*not a git repository/i);
});

async function broken(t, { autoResume = true } = {}) {
  const { d, r } = repo(t), wt = path.join(d, 'wt'); realGit(r, 'worktree', 'add', '-qb', 'issue-579', wt);
  const manifest = { schema_version: 1, id: 'codex', display_name: 'codex', adapter_version: '0.1.0', launch: { command: 'codex', args: [], env_allowlist: ['HOME', 'PATH', 'LANG'] },
    capabilities: { launch: 'supported', resume: 'supported', session_status: 'supported', usage_limit_detection: 'supported', reset_time_parsing: 'supported', checkpoint: 'supported', non_interactive: 'supported' },
    billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(path.join(d, 'codex.json'), JSON.stringify(manifest));
  const registry = path.join(d, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  const root = stateRoot(path.join(d, 'state'));
  return { d, r, wt, root, registry, spec: { role: 'devtest', provider: 'codex', repository: r, worktree: wt, issue: 579, scope: 's', allowed_actions: ['read'], prompt: 'p', autoResume } };
}
const sleeper = ms => ({ command: () => [process.execPath, '-e', `setTimeout(()=>{}, ${ms})`], observe: () => ({}), preflight: () => true });
const cfg = { manifest: { launch: { env_allowlist: ['PATH'] } } };
const clock = { now: () => Date.now(), sleep: async () => {} };

test('worker: repeated checkpoint failures stop the job as checkpoint_failed with the real error, not manual_stop', async t => {
  const f = await broken(t);
  const job = { id: J1, kind: 'implement', worktree: path.join(f.d, 'not-a-repo'), issue: 579, attempts: 1, status: 'running', provider: 'codex', role: 'devtest', scope: 's', allowedActions: ['read'], prompt: 'p' };
  fs.mkdirSync(job.worktree); fs.mkdirSync(path.join(f.root, 'jobs'), { recursive: true });
  const result = await runProcess(f.root, job, cfg, sleeper(20000), clock, { checkpointMs: 60, checkpointLimit: 3 });
  assert.equal(result.event, 'checkpoint_failed');
  const ev = events(f.root, J1).filter(k => k.startsWith('checkpoint_failed:'));
  assert.equal(ev.length, 3);
  assert.match(ev[0], /^checkpoint_failed:Error:1:Git check failed: rev-parse: .*not a git repository/i);
  assert.ok(!events(f.root, J1).some(k => k.startsWith('checkpoint_exception') || k === 'manual_stop'));
});

test('worker: failures below the limit are recorded but never stop the job', async t => {
  const f = await broken(t);
  const job = { id: J2, kind: 'implement', worktree: path.join(f.d, 'not-a-repo'), issue: 579, attempts: 1, status: 'running', provider: 'codex', role: 'devtest', scope: 's', allowedActions: ['read'], prompt: 'p' };
  fs.mkdirSync(job.worktree); fs.mkdirSync(path.join(f.root, 'jobs'), { recursive: true });
  const result = await runProcess(f.root, job, cfg, sleeper(500), clock, { checkpointMs: 100, checkpointLimit: 50 });
  assert.equal(result.code, 0); assert.notEqual(result.event, 'checkpoint_failed');
  assert.ok(events(f.root, J2).filter(k => k.startsWith('checkpoint_failed:')).length >= 1);
});

test('drive: a checkpoint_failed stop restarts when auto-resume is on, and is a resumable failed job (work kept) when off', async t => {
  const f = await broken(t);
  const job = await createJob(f.root, f.spec, f.registry);
  let runs = 0;
  const done = await drive(f.root, job, f.registry, clock, async () => (++runs === 1 ? { code: 1, event: 'checkpoint_failed' } : { code: 0 }));
  assert.equal(runs, 2); assert.equal(done.status, 'completed');
  const g = await broken(t, { autoResume: false });
  const j2 = await createJob(g.root, g.spec, g.registry);
  const out = await drive(g.root, j2, g.registry, clock, async () => ({ code: 1, event: 'checkpoint_failed' }));
  assert.equal(out.status, 'failed'); assert.equal(out.lastEvent, 'checkpoint_failed');
  assert.ok(fs.existsSync(g.wt));   // the worktree, with its uncommitted work, is untouched; `resume` accepts a failed job
});

const NOW = 10 * 3600000;
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
function world(t, jobStatus) {
  const dir = tmp(t);
  const gh = { issues: [{ number: 23, title: 'A', state: 'OPEN', body: '', labels: [] }], prs: [], listPulls: async () => [], getPull: async () => null, listIssues: async () => gh.issues, board: async () => {}, listMergedPulls: async () => [], listClosedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} };
  const jobs = { listActive: async () => [], get: async () => ({ id: 'a'.repeat(32), status: jobStatus, lastEvent: 'checkpoint_failed' }), create: async () => ({ id: 'b'.repeat(32) }) };
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] } }, board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const team = new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => NOW } });
  team.s.implemented[23] = NOW - 60000; team.s.jobs['a'.repeat(32)] = { kind: 'implement', agent: 'claude', issue: 23, branch: 'claude/issue-23-a', ingested: false, at: NOW - 120000 };
  team.save(); return team;
}

test('team: an implement job that ends with no PR is surfaced at once (not after the stale-mark age), with its cause', async t => {
  const team = world(t, 'failed');
  await team.ingest({ ingested: [], notified: [] });
  await team.plan();
  assert.deepEqual(Object.keys(team.stale), ['23']);
  assert.match(team.staleText(23), /implement job ended failed \(checkpoint_failed\) with no pull request; the work stays in its worktree/);
});

test('team: a job still running or completed does not raise the item before the stale-mark age', async t => {
  const team = world(t, 'completed');
  await team.ingest({ ingested: [], notified: [] });
  await team.plan();
  assert.deepEqual(Object.keys(team.stale || {}), []);
});

test('checkpoint: a total time budget stops the retries of every git call in one checkpoint (issue #597)', t => {
  const { d, r } = repo(t), wt = path.join(d, 'wt'); realGit(r, 'worktree', 'add', '-qb', 'issue-597', wt);
  const bin = path.join(d, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nsleep 5\n', { mode: 0o755 });
  const saved = [...GIT_TIMEOUTS], oldPath = process.env.PATH;
  GIT_TIMEOUTS.splice(0, GIT_TIMEOUTS.length, 4000, 4000, 4000);
  process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; GIT_TIMEOUTS.splice(0, GIT_TIMEOUTS.length, ...saved); });
  const started = Date.now();
  assert.throws(() => checkpoint(stateRoot(path.join(d, 'state')), { id: 'x', worktree: wt, issue: 597, kind: 'implement' }, undefined, 400), /Git check failed: rev-parse: timed out/);
  assert.ok(Date.now() - started < 2500, 'bounded by the budget, not 3 x 4000 ms');
  // the budget is released afterwards: a plain git call is no longer limited by it
  process.env.PATH = oldPath;
  assert.match(git(r, 'rev-parse', 'HEAD'), /^[0-9a-f]{40}$/);
});

test('worker: no further checkpoint is attempted after the limit, even when the child is slow to exit', async t => {
  const f = await broken(t);
  const job = { id: '3'.repeat(32), kind: 'implement', worktree: path.join(f.d, 'not-a-repo'), issue: 579, attempts: 1, status: 'running', provider: 'codex', role: 'devtest', scope: 's', allowedActions: ['read'], prompt: 'p' };
  fs.mkdirSync(job.worktree); fs.mkdirSync(path.join(f.root, 'jobs'), { recursive: true });
  const slow = { command: () => [process.execPath, '-e', "process.on('SIGINT',()=>setTimeout(()=>process.exit(0),300));setTimeout(()=>{},20000)"], observe: () => ({}), preflight: () => true };
  // Deterministic: the checkpoint timer is driven by hand, so no real-time race decides the outcome (issue #748).
  let tick = null, cleared = 0;
  const timers = { setInterval: fn => { tick = fn; return 1; }, clearInterval: () => { cleared++; } };
  const run = runProcess(f.root, job, cfg, slow, clock, { checkpointLimit: 3, timers });
  for (let i = 0; i < 3; i++) tick();
  assert.ok(cleared >= 1, 'the timer is cleared as soon as the limit is reached, while the child is still running');
  const result = await run;
  assert.equal(result.event, 'checkpoint_failed');
  assert.equal(events(f.root, job.id).filter(k => k.startsWith('checkpoint_failed:')).length, 3);
});

// Issue #741: checkpoint() refuses a nested call, and the budget is reset after a throw so the next checkpoint is not wrongly refused.
test('checkpoint: a nested call is refused as already active; the budget resets after a throw', t => {
  const { d, r } = repo(t);
  const root = path.join(d, 'state'); fs.mkdirSync(path.join(root, 'events'), { recursive: true });
  const job = { id: J1, worktree: r, kind: 'implement', issue: 1, status: 'running' };
  let inner = null;
  const nestingClock = { now: () => { try { checkpoint(root, job, { now: () => 0 }); } catch (e) { inner = e; } return 0; } };
  try { checkpoint(root, job, nestingClock); } catch { /* the outer call may fail for unrelated reasons */ }
  assert.match(String(inner?.message), /already active/);
  const broken = { ...job, worktree: path.join(d, 'missing') };
  assert.throws(() => checkpoint(root, broken, { now: () => 0 }));
  let again = null;
  try { checkpoint(root, job, { now: () => 0 }); } catch (e) { again = e; }
  assert.doesNotMatch(String(again?.message), /already active/, 'a throw does not leave the guard set');
});
