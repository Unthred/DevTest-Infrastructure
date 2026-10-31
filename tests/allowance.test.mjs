// Allowance evidence (issue #20). LIVE = parsed from a real captured fixture; SIMULATED = built from a live shape with
// an exhausted state that has not yet been observed from either CLI. Nothing here proves live auto-resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { billingRisk, claudeAllowance, codexAllowance, codexAllowanceFromRollout, codexRolloutFile, limitFromAllowance } from '../supervisor/allowance.mjs';
import { createJob, drive, stateRoot } from '../supervisor/core.mjs';
import { runProcess } from '../supervisor/process.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';
import * as codex from '../supervisor/adapters/codex.mjs';

const fixture = name => fs.readFileSync(new URL(`./fixtures/allowance/${name}`, import.meta.url), 'utf8').trim();
const claudeLive = JSON.parse(fixture('claude-2.1.314-rate_limit_event.allowed.json'));
const codexLive = JSON.parse(fixture('codex-0.166-token_count.not-reached.json'));
const NOW = Date.parse('2026-10-30T08:00:00Z');
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();

test('LIVE Claude rate_limit_event parses to windows and no event', () => {
  const parsed = claude.observe(JSON.stringify(claudeLive));
  assert.equal(parsed.event, undefined);
  const a = parsed.allowance;
  assert.equal(a.provider, 'claude'); assert.equal(a.status, 'allowed');
  assert.deepEqual(a.windows.map(w => [w.type, w.utilization, w.resetsAt]), [['five_hour', 0.06, 1793358600000], ['seven_day', 0.06, 1793851200000]]);
  assert.equal(a.billing.usingOverage, false);
  assert.equal(limitFromAllowance(a, NOW), null); assert.equal(billingRisk(a), false);
});

test('LIVE Codex token_count rate_limits parse to windows; not reached means no limit', () => {
  const a = codexAllowance(codexLive.payload.rate_limits);
  assert.equal(a.status, 'allowed'); assert.equal(a.reachedType, null);
  assert.deepEqual(a.windows.map(w => [w.type, w.windowMinutes, w.utilization, w.resetsAt]), [['primary', 300, 0.46, 1793360654000], ['secondary', 10080, 0.41, 1793776715000]]);
  assert.equal(a.billing.creditsAvailable, false);
  assert.equal(limitFromAllowance(a, NOW), null);
});

test('SIMULATED exhausted states: provider-reported reset used, never verified, no invented time', () => {
  const claudeLimited = claudeAllowance({ ...claudeLive.rate_limit_info, status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1793358600, status: 'rejected' }, seven_day: { utilization: 0.2, resetsAt: 1793851200, status: 'allowed' } } });
  const c = limitFromAllowance(claudeLimited, Date.parse('2026-10-30T08:00:00Z'));
  assert.equal(c.event, 'usage_limit'); assert.equal(c.resetAt, 1793358600000); assert.equal(c.verified, false); assert.equal(c.resetSource, 'provider_reported');
  const limits = structuredClone(codexLive.payload.rate_limits); limits.rate_limit_reached_type = 'primary'; limits.primary.used_percent = 100;
  const x = limitFromAllowance(codexAllowance(limits), Date.parse('2026-10-30T08:00:00Z'));
  assert.equal(x.event, 'usage_limit'); assert.equal(x.resetAt, 1793360654000); assert.equal(x.verified, false);
  // reset already in the past or absent: no invented time
  const stale = limitFromAllowance(codexAllowance(limits), Date.parse('2026-12-01T00:00:00Z'));
  assert.equal(stale.resetAt, null); assert.equal(stale.resetSource, 'none');
});

test('an unfamiliar status after a failure is recorded but never claimed as a usage limit', () => {
  const odd = claudeAllowance({ ...claudeLive.rate_limit_info, status: 'queued_for_review', unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1793358600, status: 'something_new' } } });
  assert.equal(limitFromAllowance(odd, NOW), null);
});

test('billing guard: overage use blocks for a human instead of waiting or retrying', () => {
  const overage = claudeAllowance({ ...claudeLive.rate_limit_info, status: 'rejected', isUsingOverage: true });
  assert.equal(billingRisk(overage), true);
  assert.equal(limitFromAllowance(overage, NOW).event, 'approval_required');
});

test('Codex rollout lookup is bounded: bad ids rejected, tail read, last record wins, no message text kept', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-home-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-10-30T08:00:00Z'), id = '01a18bc1-5e3a-7993-bc29-6e1432327da5';
  const dir = path.join(home, '.codex/sessions/2026/10/30'); fs.mkdirSync(dir, { recursive: true });
  const reached = structuredClone(codexLive); reached.payload.rate_limits.rate_limit_reached_type = 'primary'; reached.payload.rate_limits.primary.used_percent = 100;
  const secret = { type: 'response_item', payload: { type: 'message', content: 'PRIVATE-PROMPT-TEXT rate_limits' } };
  fs.writeFileSync(path.join(dir, `rollout-2026-10-30T07-41-08-${id}.jsonl`), [codexLive, secret, reached, { type: 'event_msg', payload: { type: 'task_complete' } }].map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.equal(codexRolloutFile('../../etc/passwd', home, now), null); assert.equal(codexRolloutFile('', home, now), null);
  const file = codexRolloutFile(id, home, now); assert.ok(file);
  const a = codexAllowanceFromRollout(file);
  assert.equal(a.reachedType, 'primary');
  assert.ok(!JSON.stringify(a).includes('PRIVATE-PROMPT-TEXT'));
  assert.equal(codexRolloutFile('01a18bc1-0000-0000-0000-000000000000', home, now), null);
});

function sandbox(t, source, adapterExtras = {}, autoResume = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allowance-run-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), wt = path.join(dir, 'wt'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'a@b.invalid'); git(repo, 'config', 'user.name', 't'); fs.writeFileSync(path.join(repo, 'r'), 'x'); git(repo, 'add', 'r'); git(repo, 'commit', '-qm', 'i'); git(repo, 'worktree', 'add', '-qb', 'i20', wt);
  const manifest = { schema_version: 1, id: 'codex', display_name: 'c', adapter_version: '0.1.0', launch: { command: 'x', args: [] }, capabilities: Object.fromEntries(['launch', 'resume', 'session_status', 'usage_limit_detection', 'reset_time_parsing', 'checkpoint', 'non_interactive'].map(k => [k, 'supported'])), billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify(manifest)); const registry = path.join(dir, 'reg.json'); fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  const script = path.join(dir, 'agent.mjs'); fs.writeFileSync(script, source);
  const spec = { role: 'devtest', provider: 'codex', repository: repo, worktree: wt, issue: 20, scope: 's', allowed_actions: ['read'], prompt: 'p', autoResume };
  const run = (root, job) => (c, ad, j, cl) => runProcess(root, j, { manifest: { launch: { env_allowlist: ['PATH'] } } }, { command: () => [process.execPath, script], observe: claude.observe, preflight: () => true, ...adapterExtras }, cl);
  return { dir, registry, spec, run, root: stateRoot(path.join(dir, 's')) };
}
const emit = event => `console.log(${JSON.stringify(JSON.stringify(event))});`;
const exhausted = { ...claudeLive, rate_limit_info: { ...claudeLive.rate_limit_info, status: 'rejected', unifiedWindows: { five_hour: { utilization: 1, resetsAt: Math.floor(Date.now() / 1000) + 7200, status: 'rejected' } } } };
const clk = { now: () => Date.now(), sleep: async () => {} };

test('end to end, SIMULATED exhaustion: failed run with exhausted Claude window becomes usage_limit with the reported reset', async t => {
  const s = sandbox(t, `${emit(exhausted)} process.exit(1);`), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'blocked'); assert.equal(r.lastEvent, 'usage_limit');   // autoResume off: blocked, not retried
  assert.equal(r.allowance.provider, 'claude'); assert.equal(r.allowance.windows[0].status, 'rejected');
});

test('a successful run is never turned into a limit by allowance data', async t => {
  const s = sandbox(t, `${emit(exhausted)} console.log('done');`), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'completed');
});

test('allowed allowance on a failed run adds no limit; it stays a plain failure', async t => {
  const s = sandbox(t, `${emit(claudeLive)} process.exit(1);`), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'failed'); assert.notEqual(r.lastEvent, 'usage_limit');
});

test('SIMULATED overage on a failed run blocks for approval and is not retried even with auto-resume requested', async t => {
  const over = { ...exhausted, rate_limit_info: { ...exhausted.rate_limit_info, isUsingOverage: true } };
  const s = sandbox(t, `${emit(over)} process.exit(1);`), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'blocked'); assert.equal(r.lastEvent, 'approval_required'); assert.equal(r.attempts, 1);
});

test('SIMULATED overage on a SUCCESSFUL exit still blocks for approval; no completion, no retry (real subprocess)', async t => {
  // synthetic shape: status allowed, isUsingOverage true, exit 0. Not a live billing capture.
  const over = { ...claudeLive, rate_limit_info: { ...claudeLive.rate_limit_info, isUsingOverage: true } };
  for (const autoRestart of [false, true]) {
    const s = sandbox(t, `${emit(over)} console.log('all done');`, {}, autoRestart), job = await createJob(s.root, { ...s.spec, autoRestart }, s.registry);
    const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
    assert.equal(r.status, 'blocked'); assert.equal(r.lastEvent, 'approval_required'); assert.equal(r.attempts, 1);
    assert.equal(r.allowance.billing.usingOverage, true);
  }
});

test('overage outranks a reported usage limit: blocks for approval, never waits for a reset', async t => {
  const over = { ...exhausted, rate_limit_info: { ...exhausted.rate_limit_info, isUsingOverage: true } };
  const s = sandbox(t, `${emit(over)} process.exit(1);`), job = await createJob(s.root, { ...s.spec, autoRestart: true }, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.lastEvent, 'approval_required'); assert.equal(r.attempts, 1); assert.equal(r.resetAt, null);
});

test('without overage a successful run with allowance data still completes (guard is not over-broad)', async t => {
  const s = sandbox(t, `${emit(claudeLive)} console.log('done');`), job = await createJob(s.root, s.spec, s.registry);
  assert.equal((await drive(s.root, job, s.registry, clk, s.run(s.root, job))).status, 'completed');
});

test('Codex postRun hook feeds rollout evidence into a failed run', async t => {
  const reached = structuredClone(codexLive.payload.rate_limits); reached.rate_limit_reached_type = 'primary'; reached.primary.used_percent = 100; reached.primary.resets_at = Math.floor(Date.now() / 1000) + 3600;
  const s = sandbox(t, "console.error('turn failed'); process.exit(1);", { observe: () => ({}), postRun: () => codexAllowance(reached) });
  const job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.lastEvent, 'usage_limit'); assert.equal(r.allowance.provider, 'codex'); assert.equal(r.allowance.reachedType, 'primary');
});

test('production manifests still refuse auto-resume: nothing here marks a capability verified', async t => {
  const s = sandbox(t, '');
  const registry = new URL('../supervisor/providers.json', import.meta.url).pathname;
  for (const provider of ['claude', 'codex']) await assert.rejects(createJob(s.root, { ...s.spec, provider, autoResume: true, issue: provider === 'claude' ? 21 : 22 }, registry), /auto-resume requires verified/);
});

// Issue #33: the supervisor cuts each output line to 16 KiB; a cut JSON line used to be scanned as plain text, so an agent that merely
// READ a file mentioning "usage limit" paused its own job (false pause of job 7829a980…, issue #30).
const shape = JSON.parse(fixture('claude-2.1.314-stream-tool_result.shape.json'));
const longToolResult = (phrase, padTo = 40000) => { const e = structuredClone(shape); e.message.content[0].content = `${phrase} ${'x'.repeat(padTo)}`; return JSON.stringify(e); };
const cut = line => line.slice(0, 16384);   // exactly what process.mjs hands the adapter

test('a truncated structured line is never limit, auth, context, approval or rate evidence (Claude and Codex)', () => {
  for (const phrase of ['usage limit', 'weekly limit', 'session limit', 'out of extra usage', 'rate limit', 'context window', 'not logged in', 'approval required', 'you have hit your limit']) {
    const line = cut(longToolResult(`Docs say: ${phrase}.`));
    assert.throws(() => JSON.parse(line), 'the fixture really is an unparseable fragment');
    assert.deepEqual(claude.observe(line), {}, `claude: ${phrase}`);
    assert.deepEqual(codex.observe(line), {}, `codex: ${phrase}`);
  }
  assert.deepEqual(claude.observe('  [{"cut array quoting usage limit'), {});
});

test('the fix is narrow: whole JSON lines, structured errors and plain stderr text classify exactly as before', () => {
  assert.equal(claude.observe(JSON.stringify(shape)).event, undefined, 'an intact tool_result quoting the phrase was already ignored');
  assert.equal(claude.observe('Claude AI usage limit reached').event, 'usage_limit');                         // plain text line (stderr)
  assert.equal(claude.observe(JSON.stringify({ type: 'error', error: { message: 'You hit your weekly limit' } })).event, 'usage_limit');
  assert.equal(codex.observe("You've hit your usage limit. Upgrade to Pro or try again at 11:44 AM.").event, 'usage_limit');
  assert.equal(claude.observe(JSON.stringify({ type: 'result', is_error: true, api_error_status: 401, result: 'x' })).event, 'auth_error');
});

for (const [name, adapter] of [['claude', claude], ['codex', codex]]) {
  test(`${name}: a long tool result quoting "usage limit" does not pause a run that completed (real subprocess, exit 0)`, async t => {
    const s = sandbox(t, `process.stdout.write(${JSON.stringify(longToolResult('The usage limit and weekly limit are documented here.'))} + '\\n'); console.log('done');`, { observe: adapter.observe }), job = await createJob(s.root, s.spec, s.registry);
    const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
    assert.equal(r.status, 'completed'); assert.notEqual(r.lastEvent, 'usage_limit'); assert.equal(r.attempts, 1);
  });
}

test('the same long line on a failed run is a plain failure, not a limit', async t => {
  const s = sandbox(t, `process.stdout.write(${JSON.stringify(longToolResult('usage limit'))} + '\\n'); process.exit(1);`, { observe: claude.observe }), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'failed'); assert.notEqual(r.lastEvent, 'usage_limit');
});

test('the overage guard is untouched: an overage event after a long quoting line still blocks for approval', async t => {
  const over = { ...claudeLive, rate_limit_info: { ...claudeLive.rate_limit_info, isUsingOverage: true } };
  const s = sandbox(t, `process.stdout.write(${JSON.stringify(longToolResult('usage limit'))} + '\\n'); ${emit(over)} console.log('done');`, { observe: claude.observe }), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'blocked'); assert.equal(r.lastEvent, 'approval_required'); assert.equal(r.attempts, 1);
});

test('a REAL structured exhausted event after a long quoting line is still detected', async t => {
  const s = sandbox(t, `process.stdout.write(${JSON.stringify(longToolResult('usage limit'))} + '\\n'); ${emit(exhausted)} process.exit(1);`, { observe: claude.observe }), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.lastEvent, 'usage_limit'); assert.equal(r.allowance.windows[0].status, 'rejected');
});

test('token counts and the CLI cost estimate from the provider stream are recorded on the job, accumulated across attempts, with no message text', async t => {
  const result = { type: 'result', result: 'PRIVATE-MODEL-TEXT', usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 90 }, total_cost_usd: 0.02 };
  const s = sandbox(t, `${emit(result)}`), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'completed');
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 4, costUsdEstimate: 0.02 });
  assert.ok(!JSON.stringify(r).includes('PRIVATE-MODEL-TEXT'));
});

test('issue #68: a clean exit with "requires approval" on stderr and an allowed allowance completes; the cause is recorded redacted', async t => {
  const s = sandbox(t, `${emit(claudeLive)} console.error('step requires approval'); console.log('all done');`), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'completed'); assert.equal(r.attempts, 1);
  const log = fs.readFileSync(path.join(s.root, 'events', `${job.id}.jsonl`), 'utf8');
  assert.match(log, /classified:approval_required:stderr:non-json/); assert.match(log, /approval_ignored:clean_exit_allowance_allowed:stderr:non-json/);
  assert.doesNotMatch(log, /requires approval/);
});

test('issue #68: a FAILED run with the same stderr text and an allowed allowance still blocks; overage still blocks on a clean exit', async t => {
  const s = sandbox(t, `${emit(claudeLive)} console.error('step requires approval'); process.exit(1);`), job = await createJob(s.root, s.spec, s.registry);
  const r = await drive(s.root, job, s.registry, clk, s.run(s.root, job));
  assert.equal(r.status, 'blocked'); assert.equal(r.lastEvent, 'approval_required');
  const over = { ...claudeLive, rate_limit_info: { ...claudeLive.rate_limit_info, isUsingOverage: true } };
  const o = sandbox(t, `${emit(over)} console.error('step requires approval'); console.log('done');`), oj = await createJob(o.root, o.spec, o.registry);
  const ro = await drive(o.root, oj, o.registry, clk, o.run(o.root, oj));
  assert.equal(ro.status, 'blocked'); assert.equal(ro.lastEvent, 'approval_required');
});
