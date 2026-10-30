// Regression tests from the independent review of the supervisor (issue #15).
// Every case uses throwaway repositories and state roots; nothing touches a real branch or worktree.
// Provider output shapes marked "captured" were recorded from real CLIs (Claude Code 2.1.314, Codex CLI 0.165.0)
// using an invalid-model call, which spends no tokens. Real usage-limit output has NOT been captured: limit
// wording here is simulated and the capability stays unverified.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createJob, drive, readJob, saveJob, stateRoot } from '../supervisor/core.mjs';
import { runProcess } from '../supervisor/process.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';
import * as codex from '../supervisor/adapters/codex.mjs';

const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const caps = ['launch', 'resume', 'session_status', 'usage_limit_detection', 'reset_time_parsing', 'checkpoint', 'non_interactive'];

function fixture(t, autoResume = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-regress-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), worktree = path.join(dir, 'wt');
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.invalid'); git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), 'x'); git(repo, 'add', 'README.md'); git(repo, 'commit', '-qm', 'init');
  git(repo, 'worktree', 'add', '-qb', 'issue-15', worktree);
  const manifest = { schema_version: 1, id: 'codex', display_name: 'c', adapter_version: '0.1.0', launch: { command: 'x', args: [] },
    capabilities: Object.fromEntries(caps.map(k => [k, 'supported'])), billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify(manifest));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  return { dir, root: stateRoot(path.join(dir, 'state')), registry, spec: { role: 'devtest', provider: 'codex', repository: repo, worktree,
    issue: 15, scope: 's', allowed_actions: ['read'], prompt: 'p', autoResume } };
}
const clock = () => { let now = Date.parse('2026-10-30T10:00:00Z'); const sleeps = []; return { now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, sleeps }; };
const realClock = { now: () => Date.now(), sleep: async () => {} };
function scripted(f, source, observe = codex.observe) {
  const script = path.join(f.dir, 'agent.mjs'); fs.writeFileSync(script, source);
  return async (c, ad, j, cl) => runProcess(f.root, j, { manifest: { launch: { env_allowlist: ['PATH'] } } },
    { command: () => [process.execPath, script], observe, preflight: () => true }, cl);
}

test('exit 0 with a recovered transient rate limit completes once, with auto-resume on or off', async t => {
  for (const auto of [false, true]) {
    const f = fixture(t, auto), job = await createJob(f.root, f.spec, f.registry);
    const r = await drive(f.root, job, f.registry, realClock, scripted(f, "console.error('429 rate limit, retrying in 2s'); console.log('done');"));
    assert.equal(r.status, 'completed'); assert.equal(r.attempts, 1);
  }
});

test('exit 0 does not hide a fatal event: a usage-limit line is never reported as completed', async t => {
  const f = fixture(t), job = await createJob(f.root, f.spec, f.registry);
  const r = await drive(f.root, job, f.registry, realClock, scripted(f, "console.log('Usage limit reached');"));
  assert.notEqual(r.status, 'completed'); assert.equal(r.lastEvent, 'usage_limit');
});

test('a real usage limit wins over a stray transient rate limit in either order', async t => {
  for (const lines of [['429 rate limit', 'Usage limit reached'], ['Usage limit reached', '429 rate limit']]) {
    const f = fixture(t), job = await createJob(f.root, f.spec, f.registry);
    const source = `${lines.map(l => `console.error(${JSON.stringify(l)});`).join('')} process.exit(1);`;
    const r = await drive(f.root, job, f.registry, realClock, scripted(f, source));
    assert.equal(r.lastEvent, 'usage_limit', lines.join(' | '));
  }
});

test('Claude error-result parsing uses the real "result" field and ignores non-errors', () => {
  const limit = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your usage limit. It resets at 2026-10-30T05:00:00Z", error: null, message: null });
  const parsed = claude.observe(limit);
  assert.equal(parsed.event, 'usage_limit'); assert.equal(parsed.resetAt, Date.parse('2026-10-30T05:00:00Z'));
  assert.equal(parsed.verified, false, 'simulated wording is never verified');
  // captured from Claude Code 2.1.314 with an invalid model name
  const captured = { type: 'result', subtype: 'success', is_error: true, api_error_status: 404, terminal_reason: 'api_error',
    result: "There's an issue with the selected model (no-such-model-xyz). It may not exist or you may not have access to it.", error: null, message: null };
  assert.equal(claude.observe(JSON.stringify(captured)).event, undefined);
  assert.equal(claude.observe(JSON.stringify({ ...captured, api_error_status: 401 })).event, 'auth_error');
  assert.equal(claude.observe(JSON.stringify({ ...captured, api_error_status: 429 })).event, 'transient_rate_limit');
  assert.equal(claude.observe(JSON.stringify({ type: 'result', is_error: false, result: 'Explained the usage limit documentation' })).event, undefined);
  assert.equal(claude.observe(JSON.stringify({ type: 'assistant', message: { content: 'the usage limit text' } })).event, undefined);
});

test('Codex captured error shapes are not misread as limits', () => {
  // captured from Codex CLI 0.165.0 with an unsupported model name
  const failed = { type: 'turn.failed', error: { message: "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account." } };
  assert.equal(codex.observe(JSON.stringify(failed)).event, undefined);
  assert.equal(codex.observe(JSON.stringify({ type: 'thread.started', thread_id: '01a18b8e-9627-75f2-a77f-9b9b98f44fe2' })).sessionId, '01a18b8e-9627-75f2-a77f-9b9b98f44fe2');
  assert.equal(codex.observe(JSON.stringify({ type: 'turn.failed', error: { message: 'Reset your current usage limits to continue' } })).event, 'approval_required');
});

test('reconcile revives a queued job with a dead worker only when it is due, enabled and eligible', async t => {
  for (const [auto, offset, expected] of [[true, -1000, 1], [true, 3600000, 0], [false, -1000, 0], [true, null, 0]]) {
    const f = fixture(t, auto), job = await createJob(f.root, f.spec, f.registry);
    Object.assign(job, { status: 'queued', nextAttemptAt: offset === null ? null : Date.now() + offset, workerPid: 999999, workerStart: '1' });
    saveJob(f.root, job, realClock, true);
    const out = execFileSync(process.execPath, [cli, 'reconcile', '--state-root', f.root, '--registry', f.registry], { encoding: 'utf8' });
    assert.equal(JSON.parse(out).resumed, expected, JSON.stringify({ auto, offset }));
  }
});

test('a context-limit requeue is immediately due, so a worker dying right after it does not strand the job', async t => {
  const f = fixture(t, true), job = await createJob(f.root, f.spec, f.registry);
  const events = path.join(f.root, 'events', `${job.id}.jsonl`);
  // Simulate the worker dying the instant after the requeue is persisted: the clock throws once the event exists.
  const dying = { now: () => { if (fs.existsSync(events) && fs.readFileSync(events, 'utf8').includes('context_fresh_session')) throw new Error('worker died'); return Date.now(); }, sleep: async () => {} };
  await assert.rejects(drive(f.root, job, f.registry, dying, async () => ({ code: 1, event: 'context_limit' })), /worker died/);
  const stranded = readJob(f.root, job.id);
  assert.equal(stranded.status, 'queued'); assert.equal(stranded.lastEvent, 'context_fresh_session');
  assert.ok(stranded.nextAttemptAt !== null && stranded.nextAttemptAt <= Date.now(), 'requeue must be due');
  Object.assign(stranded, { workerPid: 999999, workerStart: '1' }); saveJob(f.root, stranded, realClock, true);
  const out = execFileSync(process.execPath, [cli, 'reconcile', '--state-root', f.root, '--registry', f.registry], { encoding: 'utf8' });
  assert.equal(JSON.parse(out).resumed, 1);
});
