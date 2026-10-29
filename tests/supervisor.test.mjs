import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createJob, drive, readJob, recover, releaseLeases, stateRoot, SupervisorError, defaultRegistry } from '../supervisor/core.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';
import * as codex from '../supervisor/adapters/codex.mjs';
import * as base from '../supervisor/adapters/base.mjs';

function git(cwd, ...args) { return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim(); }
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), worktree = path.join(dir, 'worktree'), state = path.join(dir, 'state');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'worktree', 'add', '-qb', 'issue-15', worktree);
  return { repo, worktree, root: stateRoot(state), spec: { role: 'devtest', provider: 'codex', repository: repo, worktree, issue: 15, scope: 'fixture', allowedActions: ['read'], prompt: 'Check fixture', handover: 'HANDOVER.md', autoResume: true } };
}
function fakeClock() {
  let now = Date.parse('2026-10-29T20:00:00Z');
  const sleeps = [];
  return { now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, sleeps };
}

test('adapter classification distinguishes limits, context, auth, transient, approval and network', () => {
  for (const adapter of [claude, codex]) {
    assert.equal(adapter.observe('Usage limit reached. Resets at 2026-10-30T05:00:00Z').event, 'usage_limit');
    assert.equal(adapter.observe('Context window exceeded').event, 'context_limit');
    assert.equal(adapter.observe('Authentication failed').event, 'auth_error');
    assert.equal(adapter.observe('Rate limit 429').event, 'transient_rate_limit');
    assert.equal(adapter.observe('Approval required').event, 'approval_required');
    assert.equal(adapter.observe('Network error').event, 'network_error');
  }
  assert.equal(base.observe('Usage limit reached').event, undefined);
  assert.equal(codex.observe('API key billing usage limit').event, undefined);
  assert.equal(claude.observe('Usage limit reached. Resets at 2026-10-30T05:00:00Z').resetAt, Date.parse('2026-10-30T05:00:00Z'));
});

test('usage-limit reset sleeps without model calls and resumes same issue/worktree', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, defaultRegistry, clock);
  let calls = 0, sleepingCalls = null;
  const originalSleep = clock.sleep;
  clock.sleep = async ms => { sleepingCalls = calls; await originalSleep(ms); assert.equal(calls, sleepingCalls); };
  fs.writeFileSync(path.join(f.worktree, 'HANDOVER.md'), 'checkpoint');
  const result = await drive(f.root, job, defaultRegistry, clock, async () => {
    calls++;
    return calls === 1 ? { code: 1, event: 'usage_limit', resetAt: clock.now() + 900000 } : { code: 0 };
  });
  assert.equal(result.status, 'completed'); assert.equal(result.issue, 15); assert.equal(result.worktree, f.worktree);
  assert.equal(calls, 2); assert.equal(sleepingCalls, 1); assert.equal(clock.sleeps[0], 1020000);
  assert.equal(readJob(f.root, job.id).checkpoint.handoverSha256.length, 64);
  releaseLeases(f.root, result);
});

test('bounded fallback for missing reset, then blocked without hot loop', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, defaultRegistry, clock);
  let calls = 0;
  const result = await drive(f.root, job, defaultRegistry, clock, async () => { calls++; return { code: 1, event: 'usage_limit' }; });
  assert.equal(result.status, 'blocked'); assert.equal(calls, 4);
  assert.deepEqual(clock.sleeps, [3600000, 7200000, 14400000]);
});

test('context, auth and approval stop without retry; transient rate limit retries', async t => {
  for (const kind of ['context_limit', 'auth_error', 'approval_required', 'network_error', 'crash']) {
    const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, defaultRegistry, clock);
    let calls = 0;
    const result = await drive(f.root, job, defaultRegistry, clock, async () => { calls++; return { code: 1, event: kind }; });
    assert.equal(calls, 1); assert.equal(result.status, ['network_error', 'crash'].includes(kind) ? 'failed' : 'blocked');
  }
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, defaultRegistry, clock);
  let calls = 0;
  const result = await drive(f.root, job, defaultRegistry, clock, async () => ++calls === 1 ? { code: 1, event: 'transient_rate_limit' } : { code: 0 });
  assert.equal(result.status, 'completed'); assert.deepEqual(clock.sleeps, [60000]);
});

test('duplicate lease refused; parallel separate issues/worktrees accepted; stale worker requires recovery', async t => {
  const f = fixture(t), clock = fakeClock(), first = await createJob(f.root, f.spec, defaultRegistry, clock);
  await assert.rejects(createJob(f.root, f.spec, defaultRegistry, clock), /already leased/);
  const other = path.join(path.dirname(f.worktree), 'other'); git(f.repo, 'worktree', 'add', '-qb', 'issue-16', other);
  const second = await createJob(f.root, { ...f.spec, issue: 16, worktree: other }, defaultRegistry, clock);
  assert.notEqual(first.id, second.id);
  first.status = 'running'; fs.writeFileSync(path.join(f.root, 'jobs', `${first.id}.json`), JSON.stringify(first));
  assert.throws(() => recover(f.root, first.id), /orphaned worker/);
  assert.equal(readJob(f.root, first.id).status, 'blocked');
  assert.equal(recover(f.root, first.id, true).status, 'queued');
});

test('safe job records and event logs do not contain provider output or API credentials', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, defaultRegistry, clock);
  const output = 'secret-provider-output';
  await drive(f.root, job, defaultRegistry, clock, async () => ({ code: 1, event: 'auth_error', output }));
  const combined = fs.readFileSync(path.join(f.root, 'jobs', `${job.id}.json`), 'utf8') + fs.readFileSync(path.join(f.root, 'events', `${job.id}.jsonl`), 'utf8');
  assert.ok(!combined.includes(output));
});

test('real subprocess fixture classifies failure without raw log, then completes', async t => {
  const { runProcess } = await import('../supervisor/process.mjs');
  const f = fixture(t), job = await createJob(f.root, f.spec, defaultRegistry);
  const marker = path.join(path.dirname(f.repo), 'calls');
  const adapter = { command: () => [process.execPath, new URL('./fake-agent.mjs', import.meta.url).pathname, 'limit', marker], observe: codex.observe, preflight: () => true };
  job.attempts = 1;
  const result = await runProcess(f.root, job, {}, adapter, { now: () => Date.now() });
  assert.equal(result.event, 'usage_limit'); assert.equal(result.code, 1);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'called');
  const files = fs.readdirSync(path.join(f.root, 'jobs'));
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(f.root, 'jobs', files[0]), 'utf8').includes('Usage limit reached'));
});

test('new provider registers without core changes and reports unsupported auto-resume capability', async t => {
  const { provider } = await import('../supervisor/core.mjs');
  const f = fixture(t), registry = path.join(path.dirname(f.repo), 'providers.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { future: { adapter: 'base', command: ['future-agent'], capabilities: [] } } }));
  const { adapter } = await provider(registry, 'future');
  assert.equal(adapter.capabilities.usageReset, false);
  const job = await createJob(f.root, { ...f.spec, provider: 'future' }, registry);
  const result = await drive(f.root, job, registry, fakeClock(), async () => ({ code: 1, event: 'usage_limit' }));
  assert.equal(result.status, 'blocked'); assert.equal(result.attempts, 1);
});

test('CLI pause and stop signal only their supervised child and preserve requested state', async t => {
  const { spawn } = await import('node:child_process');
  for (const action of ['pause', 'stop']) {
    const f = fixture(t), baseDir = path.dirname(f.repo);
    const registry = path.join(baseDir, 'registry.json'), specFile = path.join(baseDir, 'spec.json'), marker = path.join(baseDir, 'marker');
    fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { fake: { adapter: 'base', command: [process.execPath, new URL('./fake-agent.mjs', import.meta.url).pathname, 'sleep', marker] } } }));
    fs.writeFileSync(specFile, JSON.stringify({ ...f.spec, provider: 'fake', autoResume: false }));
    const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
    const worker = spawn(process.execPath, [cli, 'start', '--foreground', '--spec', specFile, '--state-root', f.root, '--registry', registry], { stdio: 'ignore' });
    let id;
    for (let i = 0; i < 100; i++) {
      const names = fs.existsSync(path.join(f.root, 'jobs')) ? fs.readdirSync(path.join(f.root, 'jobs')) : [];
      if (names.length) {
        id = names[0].slice(0, -5);
        if (readJob(f.root, id).childPid) break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(id && readJob(f.root, id).childPid, 'child started');
    execFileSync(process.execPath, [cli, action, id, '--state-root', f.root, '--registry', registry], { stdio: 'ignore' });
    await new Promise(resolve => worker.on('close', resolve));
    assert.equal(readJob(f.root, id).status, action === 'pause' ? 'paused_manual' : 'stopped');
  }
});
