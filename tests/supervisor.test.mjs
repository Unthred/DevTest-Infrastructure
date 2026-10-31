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
function writeRegistry(dir, id, adapter, command, capabilities = {}) {
  const manifest = {
    schema_version: 1, id, display_name: id, adapter_version: '0.1.0',
    launch: { command: command[0], args: command.slice(1), env_allowlist: ['HOME', 'PATH', 'LANG'] },
    capabilities: { launch: 'supported', resume: 'supported', session_status: 'supported', usage_limit_detection: 'supported',
      reset_time_parsing: 'supported', checkpoint: 'supported', non_interactive: 'supported', ...capabilities },
    billing: { model: 'subscription', fallback_to_other_billing: false }
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(manifest));
  const registry = path.join(dir, `${id}-registry.json`);
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { [id]: { adapter, manifest: `${id}.json` } } }));
  return registry;
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), worktree = path.join(dir, 'worktree'), state = path.join(dir, 'state');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'fixture\n'); git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'worktree', 'add', '-qb', 'issue-15', worktree);
  const registry = writeRegistry(dir, 'codex', 'codex', ['codex']);
  return { repo, worktree, root: stateRoot(state), registry, spec: { role: 'devtest', provider: 'codex', repository: repo, worktree, issue: 15, scope: 'fixture', allowed_actions: ['read'], prompt: 'Check fixture', handover: 'HANDOVER.md', autoResume: true } };
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
    assert.equal(adapter.observe(JSON.stringify({ type: 'error', message: 'Approval required' })).event, 'approval_required');
    assert.equal(adapter.observe('Network error').event, 'network_error');
  }
  assert.equal(base.observe('Usage limit reached').event, undefined);
  assert.equal(codex.observe('API key billing usage limit').event, undefined);
  assert.equal(claude.observe('Budget limit reached').event, 'approval_required');
  assert.equal(codex.observe(JSON.stringify({ type: 'error', message: 'Reset your current usage limits' })).event, 'approval_required');
  assert.equal(claude.observe('Usage limit reached. Resets at 2026-10-30T05:00:00Z').resetAt, Date.parse('2026-10-30T05:00:00Z'));
  assert.equal(claude.observe(JSON.stringify({ type: 'result', is_error: true, result: 'Usage limit reached', error: null, message: null, api_error_status: 429, terminal_reason: 'api_error' })).event, 'usage_limit');
  assert.equal(claude.observe(JSON.stringify({ type: 'result', is_error: true, result: 'Temporary failure', error: null, message: null, api_error_status: 429, terminal_reason: 'api_error' })).event, 'transient_rate_limit');
  assert.equal(claude.observe(JSON.stringify({ type: 'result', is_error: true, result: 'Temporary failure', error: null, message: null, api_error_status: 401, terminal_reason: 'api_error' })).event, 'auth_error');
});

test('usage-limit reset sleeps without model calls and resumes same issue/worktree', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, f.registry, clock);
  let calls = 0, sleepingCalls = null;
  const originalSleep = clock.sleep;
  clock.sleep = async ms => { sleepingCalls = calls; await originalSleep(ms); assert.equal(calls, sleepingCalls); };
  fs.writeFileSync(path.join(f.worktree, 'HANDOVER.md'), 'checkpoint');
  const result = await drive(f.root, job, f.registry, clock, async () => {
    calls++;
    return calls === 1 ? { code: 1, event: 'usage_limit', resetAt: clock.now() + 900000, resetSource: 'provider_reported', verified: true } : { code: 0 };
  });
  assert.equal(result.status, 'completed'); assert.equal(result.issue, 15); assert.equal(result.worktree, f.worktree);
  assert.equal(calls, 2); assert.equal(sleepingCalls, 1); assert.equal(clock.sleeps[0], 1020000);
  assert.equal(readJob(f.root, job.id).checkpoint.handoverSha256.length, 64);
  releaseLeases(f.root, result);
});

test('bounded fallback for missing reset, then blocked without hot loop', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, f.registry, clock);
  let calls = 0;
  const result = await drive(f.root, job, f.registry, clock, async () => { calls++; return { code: 1, event: 'usage_limit' }; });
  assert.equal(result.status, 'blocked'); assert.equal(calls, 4);
  assert.deepEqual(clock.sleeps, [3600000, 7200000, 14400000]);
});

test('context, auth and approval stop without retry; transient rate limit retries', async t => {
  for (const kind of ['context_limit', 'auth_error', 'approval_required', 'network_error', 'crash']) {
    const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, { ...f.spec, autoResume: false }, f.registry, clock);
    let calls = 0;
    const result = await drive(f.root, job, f.registry, clock, async () => { calls++; return { code: 1, event: kind }; });
    assert.equal(calls, 1); assert.equal(result.status, ['network_error', 'crash'].includes(kind) ? 'failed' : 'blocked');
  }
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, f.registry, clock);
  let calls = 0;
  const result = await drive(f.root, job, f.registry, clock, async () => ++calls === 1 ? { code: 1, event: 'transient_rate_limit' } : { code: 0 });
  assert.equal(result.status, 'completed'); assert.deepEqual(clock.sleeps, [60000]);
});

test('duplicate lease refused; parallel separate issues/worktrees accepted; stale worker requires recovery', async t => {
  const f = fixture(t), clock = fakeClock(), first = await createJob(f.root, f.spec, f.registry, clock);
  await assert.rejects(createJob(f.root, f.spec, f.registry, clock), /already leased/);
  const other = path.join(path.dirname(f.worktree), 'other'); git(f.repo, 'worktree', 'add', '-qb', 'issue-16', other);
  const second = await createJob(f.root, { ...f.spec, issue: 16, worktree: other }, f.registry, clock);
  assert.notEqual(first.id, second.id);
  first.status = 'running'; fs.writeFileSync(path.join(f.root, 'jobs', `${first.id}.json`), JSON.stringify(first));
  assert.throws(() => recover(f.root, first.id), /orphaned worker/);
  assert.equal(readJob(f.root, first.id).status, 'blocked');
  assert.equal(recover(f.root, first.id, true).status, 'queued');
});

test('safe job records and event logs do not contain provider output or API credentials', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, f.registry, clock);
  const output = 'secret-provider-output';
  await drive(f.root, job, f.registry, clock, async () => ({ code: 1, event: 'auth_error', output }));
  const combined = fs.readFileSync(path.join(f.root, 'jobs', `${job.id}.json`), 'utf8') + fs.readFileSync(path.join(f.root, 'events', `${job.id}.jsonl`), 'utf8');
  assert.ok(!combined.includes(output));
});

test('run exception records a redacted class without provider output', async t => {
  const f = fixture(t), job = await createJob(f.root, { ...f.spec, autoResume: false }, f.registry);
  await drive(f.root, job, f.registry, { now: () => Date.now() }, async () => { throw new TypeError('secret-provider-output'); });
  const events = fs.readFileSync(path.join(f.root, 'events', `${job.id}.jsonl`), 'utf8');
  assert.match(events, /run_exception:TypeError:message_redacted/);
  assert.ok(!events.includes('secret-provider-output'));
});

test('real subprocess fixture classifies failure without raw log, then completes', async t => {
  const { runProcess } = await import('../supervisor/process.mjs');
  const f = fixture(t), job = await createJob(f.root, f.spec, f.registry);
  const marker = path.join(path.dirname(f.repo), 'calls');
  const adapter = { command: () => [process.execPath, new URL('./fake-agent.mjs', import.meta.url).pathname, 'limit', marker], observe: codex.observe, preflight: () => true };
  job.attempts = 1;
  const result = await runProcess(f.root, job, { manifest: { launch: { env_allowlist: ['HOME', 'PATH', 'LANG'] } } }, adapter, { now: () => Date.now() });
  assert.equal(result.event, 'usage_limit'); assert.equal(result.code, 1);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'called');
  const files = fs.readdirSync(path.join(f.root, 'jobs'));
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(f.root, 'jobs', files[0]), 'utf8').includes('Usage limit reached'));
});

test('successful subprocess with a recovered transient rate limit completes once', async t => {
  const { runProcess } = await import('../supervisor/process.mjs');
  const f = fixture(t), job = await createJob(f.root, f.spec, f.registry);
  const marker = path.join(path.dirname(f.repo), 'calls');
  const adapter = { command: () => [process.execPath, new URL('./fake-agent.mjs', import.meta.url).pathname, 'recoverable-rate', marker], observe: codex.observe, preflight: () => true };
  const result = await drive(f.root, job, f.registry, { now: () => Date.now(), sleep: async () => { throw new Error('unexpected retry'); } },
    (_config, _adapter, active, clock) => runProcess(f.root, active, { manifest: { launch: { env_allowlist: ['HOME', 'PATH', 'LANG'] } } }, adapter, clock));
  assert.equal(result.status, 'completed'); assert.equal(result.attempts, 1);
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'called');
});

test('reconcile restarts a dead worker after queued crash backoff', async t => {
  const f = fixture(t), job = await createJob(f.root, { ...f.spec, provider: 'fake' },
    writeRegistry(path.dirname(f.repo), 'fake', 'base', [process.execPath, new URL('./fake-agent.mjs', import.meta.url).pathname, 'done', path.join(path.dirname(f.repo), 'calls')]));
  const registry = path.join(path.dirname(f.repo), 'fake-registry.json');
  job.status = 'queued'; job.nextAttemptAt = Date.now() - 1; job.workerPid = 99999999; job.workerStart = 'dead';
  fs.writeFileSync(path.join(f.root, 'jobs', `${job.id}.json`), JSON.stringify(job));
  const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
  const output = execFileSync(process.execPath, [cli, 'reconcile', '--state-root', f.root, '--registry', registry], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).resumed, 1);
  const marker = path.join(path.dirname(f.repo), 'calls');
  for (let i = 0; i < 100 && readJob(f.root, job.id).status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(readJob(f.root, job.id).status, 'completed');
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'called');
});

test('new provider registers without core changes and reports unsupported auto-resume capability', async t => {
  const { provider } = await import('../supervisor/core.mjs');
  const f = fixture(t), registry = writeRegistry(path.dirname(f.repo), 'future', 'base', ['future-agent'],
    { resume: 'unsupported', usage_limit_detection: 'unsupported', reset_time_parsing: 'unsupported' });
  const { adapter } = await provider(registry, 'future');
  assert.equal(adapter.capabilities.usageReset, false);
  await assert.rejects(createJob(f.root, { ...f.spec, provider: 'future' }, registry), /auto-resume requires verified/);
  const job = await createJob(f.root, { ...f.spec, provider: 'future', autoResume: false }, registry);
  const result = await drive(f.root, job, registry, fakeClock(), async () => ({ code: 1, event: 'usage_limit' }));
  assert.equal(result.status, 'blocked'); assert.equal(result.attempts, 1);
});

test('CLI pause and stop signal only their supervised child and preserve requested state', async t => {
  const { spawn } = await import('node:child_process');
  for (const action of ['pause', 'stop']) {
    const f = fixture(t), baseDir = path.dirname(f.repo);
    const specFile = path.join(baseDir, 'spec.json'), marker = path.join(baseDir, 'marker');
    const registry = writeRegistry(baseDir, 'fake', 'base', [process.execPath, new URL('./fake-agent.mjs', import.meta.url).pathname, 'sleep', marker]);
    fs.writeFileSync(specFile, JSON.stringify({ ...f.spec, provider: 'fake', autoResume: false }));
    const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
    const worker = spawn(process.execPath, [cli, 'start', '--foreground', '--spec', specFile, '--state-root', f.root, '--registry', registry], { stdio: 'ignore' });
    let id;
    for (let i = 0; i < 100; i++) {
      const names = fs.existsSync(path.join(f.root, 'jobs')) ? fs.readdirSync(path.join(f.root, 'jobs')).filter(name => /^[a-f0-9]{32}\.json$/.test(name)) : [];
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
    assert.equal(readJob(f.root, id).workerPid, null);
  }
});

test('late worker writes cannot reverse manual pause or terminal completion', async t => {
  const { saveJob, transition } = await import('../supervisor/core.mjs');
  const f = fixture(t), job = await createJob(f.root, f.spec, f.registry);
  transition(f.root, job, 'running', 'started');
  const stale = structuredClone(job);
  transition(f.root, job, 'paused_manual', 'manual_pause');
  stale.childPid = 99999; saveJob(f.root, stale);
  assert.equal(readJob(f.root, job.id).status, 'paused_manual');
  transition(f.root, stale, 'failed', 'crash');
  assert.equal(readJob(f.root, job.id).status, 'paused_manual');
  const recovered = recover(f.root, job.id, true);
  transition(f.root, recovered, 'completed', 'completed');
  transition(f.root, job, 'paused_manual', 'manual_pause');
  assert.equal(readJob(f.root, job.id).status, 'completed');
});

test('explicit recovery audits a stale state lock and refuses an active owner', async t => {
  const f = fixture(t), job = await createJob(f.root, f.spec, f.registry);
  const lock = path.join(f.root, 'job-locks', job.id);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, start: 'not-the-current-process-start' }));
  const recovered = recover(f.root, job.id, true);
  assert.equal(recovered.status, 'queued'); assert.ok(!fs.existsSync(lock));
  const events = fs.readFileSync(path.join(f.root, 'events', `${job.id}.jsonl`), 'utf8');
  assert.ok(events.includes('stale_state_lock_recovered'));
});

test('manifest rejects unknown field, billing fallback and missing capability; production auto-resume is unverified', async t => {
  const { provider } = await import('../supervisor/core.mjs');
  const f = fixture(t), dir = path.dirname(f.repo), file = path.join(dir, 'codex.json');
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const mutation of [
    m => { m.unexpected = true; },
    m => { m.billing.fallback_to_other_billing = true; },
    m => { delete m.capabilities.checkpoint; }
  ]) {
    const bad = structuredClone(original); mutation(bad); fs.writeFileSync(file, JSON.stringify(bad));
    await assert.rejects(provider(f.registry, 'codex'), SupervisorError);
  }
  fs.writeFileSync(file, JSON.stringify(original));
  await assert.rejects(createJob(f.root, { ...f.spec, allowed_actions: ['deploy'] }, f.registry), /allowed_actions/);
  const production = fixture(t);
  await assert.rejects(createJob(production.root, production.spec, defaultRegistry), /auto-resume requires verified/);
});

test('context creates fresh session; network and crash retry with bounded fake time', async t => {
  for (const kind of ['context_limit', 'network_error', 'crash']) {
    const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, f.registry, clock);
    job.sessionId = 'prior-session';
    let calls = 0, sessionOnRetry = null;
    const result = await drive(f.root, job, f.registry, clock, async (_config, _adapter, active) => {
      calls++;
      if (calls === 2) sessionOnRetry = active.sessionId;
      return calls === 1 ? { code: 1, event: kind } : { code: 0 };
    });
    assert.equal(result.status, 'completed'); assert.equal(calls, 2);
    if (kind === 'context_limit') { assert.equal(sessionOnRetry, null); assert.deepEqual(clock.sleeps, []); }
    else assert.equal(clock.sleeps.length, 1);
  }
});

test('attempt ID is persisted before each provider invocation and changes on resume', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, f.registry, clock);
  const ids = [];
  await drive(f.root, job, f.registry, clock, async (_config, _adapter, active) => {
    ids.push(readJob(f.root, active.id).currentAttemptId);
    return ids.length === 1 ? { code: 1, event: 'usage_limit' } : { code: 0 };
  });
  assert.equal(ids.length, 2); assert.ok(ids[0] && ids[1]); assert.notEqual(ids[0], ids[1]);
});

test('Git change with unchanged handover blocks a resumed attempt', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, f.registry, clock);
  fs.writeFileSync(path.join(f.worktree, 'HANDOVER.md'), '# Current handover\n');
  const { checkpoint } = await import('../supervisor/core.mjs');
  checkpoint(f.root, job, clock);
  fs.writeFileSync(path.join(f.worktree, 'README.md'), 'changed\n');
  git(f.worktree, 'add', 'README.md'); git(f.worktree, 'commit', '-qm', 'changed');
  job.attempts = 1;
  let calls = 0;
  const result = await drive(f.root, job, f.registry, clock, async () => { calls++; return { code: 0 }; });
  assert.equal(result.status, 'blocked'); assert.equal(result.lastEvent, 'stale_handover'); assert.equal(calls, 0);
});

test('unverified reset uses conservative backoff; long verified reset never wakes early', async t => {
  const f = fixture(t), clock = fakeClock(), job = await createJob(f.root, f.spec, f.registry, clock);
  let calls = 0;
  await drive(f.root, job, f.registry, clock, async () => ++calls === 1
    ? { code: 1, event: 'usage_limit', resetAt: clock.now() + 300000, resetSource: 'provider_reported', verified: false }
    : { code: 0 });
  assert.deepEqual(clock.sleeps, [3600000]);
  const second = fixture(t), clock2 = fakeClock(), job2 = await createJob(second.root, second.spec, second.registry, clock2);
  let calls2 = 0; const target = clock2.now() + 30 * 86400000;
  await drive(second.root, job2, second.registry, clock2, async () => ++calls2 === 1
    ? { code: 1, event: 'usage_limit', resetAt: target, resetSource: 'provider_reported', verified: true }
    : { code: 0 });
  assert.equal(calls2, 2); assert.ok(clock2.sleeps.length >= 30);
  assert.ok(clock2.now() >= target + 120000);
});

test('uncommitted tracked changes also mark an unchanged handover stale', async t => {
  const { checkpoint } = await import('../supervisor/core.mjs');
  const f = fixture(t), job = await createJob(f.root, f.spec, f.registry);
  fs.writeFileSync(path.join(f.worktree, 'HANDOVER.md'), '# Current handover\n');
  checkpoint(f.root, job);
  fs.writeFileSync(path.join(f.worktree, 'README.md'), 'working change\n');
  checkpoint(f.root, job);
  assert.equal(readJob(f.root, job.id).checkpoint.handoverStale, true);
});
