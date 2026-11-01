// Fresh context per job (issue #74): real runProcess with a scripted child, fake clock for the pauses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createJob, drive, readJob, stateRoot } from '../supervisor/core.mjs';
import { runProcess } from '../supervisor/process.mjs';
import { decide, CACHE_WINDOW_MS } from '../supervisor/session.mjs';
import { sessionFromLine } from '../supervisor/usage.mjs';
import * as codex from '../supervisor/adapters/codex.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const caps = ['launch', 'resume', 'session_status', 'usage_limit_detection', 'reset_time_parsing', 'checkpoint', 'non_interactive'];
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-fresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), worktree = path.join(dir, 'wt');
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'user.name', 'T');
  fs.mkdirSync(path.join(repo, 'docs')); fs.writeFileSync(path.join(repo, 'docs', 'H.md'), '# Current handover\nMARKER-HANDOVER-TEXT\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); git(repo, 'worktree', 'add', '-qb', 'issue-74', worktree);
  const manifest = { schema_version: 1, id: 'codex', display_name: 'c', adapter_version: '0.1.0', launch: { command: 'x', args: [] },
    capabilities: Object.fromEntries(caps.map(k => [k, 'supported'])), billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify(manifest));
  const registry = path.join(dir, 'registry.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  return { dir, root: stateRoot(path.join(dir, 'state')), registry, spec: { role: 'devtest', provider: 'codex', repository: repo, worktree, issue: 74,
    scope: 's', allowed_actions: ['read'], prompt: 'JOB-PROMPT', autoResume: true, handover: 'docs/H.md', ...extra } };
}
function clock() { let now = Date.parse('2026-11-01T10:00:00Z'); return { now: () => now, sleep: async ms => { now += ms; }, advance: ms => { now += ms; } }; }
// First run reports a session id and then a retryable network error (30 s backoff); later runs record whether they were asked to resume and what prompt they got.
function runner(f, calls) {
  const script = path.join(f.dir, 'agent.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; let p=''; process.stdin.on('data',d=>p+=d); process.stdin.on('end',()=>{
    const n = JSON.parse(fs.readFileSync(process.argv[2],'utf8')); n.prompts.push(p); fs.writeFileSync(process.argv[2], JSON.stringify(n));
    console.log(JSON.stringify({type:'thread.started',thread_id:'sess-'+n.prompts.length}));
    console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1000,cached_input_tokens:400,output_tokens:10}}));
    if (n.prompts.length === 1) { console.error('network error'); process.exitCode=1; }});`);
  const state = path.join(f.dir, 'calls.json'); fs.writeFileSync(state, JSON.stringify({ prompts: [] }));
  return { state, run: async (c, ad, j, cl) => runProcess(f.root, j, { manifest: { launch: { env_allowlist: ['PATH'] } } },
    { command: (cfg, job, resume) => { calls.push({ resume, sessionId: job.sessionId }); return [process.execPath, script, state]; }, observe: codex.observe, preflight: () => true }, cl) };
}

test('a new job always starts fresh, even if the spec or a stale record carries a session id', async t => {
  const f = fixture(t, { sessionId: 'stolen-session' }), job = await createJob(f.root, f.spec, f.registry);
  assert.equal(job.sessionId, null);
  job.sessionId = 'leaked'; job.attempts = 1;
  assert.equal(decide(job, Date.now()).resume, false);
  assert.equal(decide(job, Date.now()).reason, 'new_job');
});

test('a short pause resumes the same session; metrics count the resume', async t => {
  const f = fixture(t), c = clock(), calls = [], r = runner(f, calls);
  const job = await createJob(f.root, f.spec, f.registry, c);
  const result = await drive(f.root, job, f.registry, c, r.run);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.map(x => x.resume), [false, true]);
  assert.equal(calls[1].sessionId, 'sess-1');
  const s = readJob(f.root, job.id).sessions;
  assert.equal(s.resumes, 1); assert.equal(s.freshRestarts, 0); assert.equal(s.started, 1);
  assert.equal(s.tokensRecached, 1200); // (1000-400) uncached input in each of the two runs
  const prompts = JSON.parse(fs.readFileSync(r.state, 'utf8')).prompts;
  assert.ok(!prompts[1].includes('FRESH provider session'));
});

test('a limit pause longer than the cache window restarts fresh from the handover', async t => {
  const f = fixture(t), c = clock(), calls = [], r = runner(f, calls);
  const job = await createJob(f.root, f.spec, f.registry, c);
  // Stretch the pause past the cache window, as a multi-hour usage-limit wait would.
  const run = async (...a) => { const out = await r.run(...a); if (calls.length === 1) c.advance(CACHE_WINDOW_MS + 60000); return out; };
  const result = await drive(f.root, job, f.registry, c, run);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls.map(x => x.resume), [false, false]);
  assert.equal(calls[1].sessionId, null);
  const s = readJob(f.root, job.id).sessions;
  assert.equal(s.resumes, 0); assert.equal(s.freshRestarts, 1); assert.equal(s.started, 2); assert.equal(s.lastDecision, 'cache_window_expired');
  const prompts = JSON.parse(fs.readFileSync(r.state, 'utf8')).prompts;
  assert.match(prompts[1], /FRESH provider session/); assert.match(prompts[1], /MARKER-HANDOVER-TEXT/); assert.match(prompts[1], /JOB-PROMPT/);
});

test('an oversized context restarts fresh even inside the window; the limit is configurable', async t => {
  for (const [extra, expectResume] of [[{ sessionMaxContextTokens: 500 }, false], [{ sessionMaxContextTokens: 5000 }, true]]) {
    const f = fixture(t, extra), c = clock(), calls = [], r = runner(f, calls);
    const job = await createJob(f.root, f.spec, f.registry, c);
    await drive(f.root, job, f.registry, c, r.run);
    assert.equal(calls[1].resume, expectResume);
    assert.equal(readJob(f.root, job.id).sessions.lastDecision, expectResume ? 'within_window' : 'context_too_large');
  }
});

test('the configured window can be shortened but never extended past the cache window', () => {
  const base = { attempts: 2, sessionId: 's', sessions: { lastActiveAt: 0, contextTokens: 1 } };
  assert.equal(decide({ ...base, sessionResumeWindowMs: 60000 }, 120000).resume, false);
  assert.equal(decide({ ...base, sessionResumeWindowMs: 10 * 3600000 }, CACHE_WINDOW_MS + 1).resume, false);
  assert.equal(decide({ ...base }, CACHE_WINDOW_MS).resume, true);
  assert.equal(decide({ ...base, sessions: { lastActiveAt: null, contextTokens: 1 } }, 1).resume, false);
});

test('adapters drop the session on a fresh restart: neither CLI gets a resume argument', () => {
  const cfg = { command: ['x'], manifest: { capabilities: { resume: 'supported' } }, arguments: [], resumeArguments: [] };
  const job = { role: 'devtest', sessionId: null, access: 'standard' };
  assert.ok(!codex.command(cfg, job, false).includes('resume'));
  assert.ok(codex.command(cfg, { ...job, sessionId: 'abc' }, true).includes('resume'));
});

test('session usage accounting reads provider usage lines', () => {
  assert.deepEqual(sessionFromLine(JSON.stringify({ type: 'result', usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 5000 } })), { recached: 200, context: 5210 });
  assert.deepEqual(sessionFromLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 400 } })), { recached: 600, context: 1000 });
  assert.equal(sessionFromLine('not json'), null);
});
