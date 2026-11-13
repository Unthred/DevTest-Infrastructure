// Issue #1330: a requested allowance refresh for a provider whose probe is the session log read takes a real new reading (one minimal session when the
// log holds nothing newer) and the Usage page says what it found. No provider is called: the session is a fake runner that writes a log record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { refreshProvider } from '../supervisor/probe.mjs';
import { probeNow } from '../supervisor/probenow.mjs';
import { probeOutcome, outcomeFromQuery, outcomeSentence } from '../supervisor/probeoutcome.mjs';
import { storeProbes, readCache } from '../supervisor/dashdata.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { defaultRegistry } from '../supervisor/core.mjs';
import { isolatedEnv, INERT_ALERTS } from './helpers/isolated-env.mjs';

// The real case of 13 Nov 2026: stored reading of 12 Nov 23:29 UTC at 46 percent weekly, five hour window ended 13 Nov 01:34 UTC, refresh asked 20:45 UTC.
const STORED_AT = Date.parse('2026-11-12T23:29:00Z'), NOW = Date.parse('2026-11-13T20:45:00Z'), HOUR = 3600000;
const WEEK_RESET = Date.parse('2026-11-18T09:00:00Z'), FIVE_RESET = Date.parse('2026-11-13T01:34:00Z');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-session-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const record = (at, weekly) => JSON.stringify({ timestamp: new Date(at).toISOString(), payload: { type: 'token_count', rate_limits: {
  primary: { used_percent: 4, window_minutes: 300, resets_at: Math.floor((at + 5 * HOUR) / 1000) }, secondary: { used_percent: weekly, window_minutes: 10080, resets_at: Math.floor(WEEK_RESET / 1000) } } } }) + '\n';
// Where Codex puts a rollout: the local date folder, as supervisor/allowance.mjs reads it.
function writeRollout(home, at, weekly, name = 'a') {
  const d = new Date(at), dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${name}.jsonl`); fs.writeFileSync(file, record(at, weekly)); fs.utimesSync(file, at / 1000, at / 1000);
}
const storedReading = (over = {}) => ({ provider: 'codex', status: 'allowed', observedAt: STORED_AT, source: 'session-log', billing: { overageStatus: 'unknown', usingOverage: false },
  windows: [{ type: 'primary', windowMinutes: 300, utilization: 0.04, resetsAt: FIVE_RESET, status: 'unknown' }, { type: 'secondary', windowMinutes: 10080, utilization: 0.46, resetsAt: WEEK_RESET, status: 'unknown' }], ...over });
// A fake runner for the minimal session: records the call, optionally writes the record the real session would, then closes.
function fakeRunner(onRun, code = 0) {
  const calls = [];
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, cwd: options.cwd });
    const child = new EventEmitter(); child.pid = undefined; child.kill = () => {};
    setImmediate(() => { onRun?.(); child.emit('close', code); });
    return child;
  };
  return { spawnFn, calls };
}
function world(t, { stored = storedReading(), logAt = STORED_AT, logWeekly = 46 } = {}) {
  const dir = tmp(t), home = path.join(dir, 'home'), root = path.join(dir, 'state');
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ schema: 1, tick: { at: NOW, status: 'ok', lastOkAt: NOW }, probes: stored ? { codex: stored } : {}, pulls: [], issues: [], delivered: [], merged: [], fetchedAt: NOW }));
  if (logAt) writeRollout(home, logAt, logWeekly);
  const refresh = (spawnFn, extra = {}) => (registry, id, o) => refreshProvider(registry, id, { ...o, home, spawnFn, lockDir: path.join(dir, 'locks'), ...extra });
  return { dir, home, root, refresh };
}
const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };

test('log older than the stored reading: one minimal session runs and the reading it records is stored', async t => {
  const w = world(t), run = fakeRunner(() => writeRollout(w.home, NOW - 1000, 47, 'b'));
  const out = await probeNow({ root: w.root, registry: defaultRegistry, config: cfg, agent: 'codex', now: NOW, refresh: w.refresh(run.spawnFn) });
  assert.equal(run.calls.length, 1, 'exactly one session');
  assert.equal(run.calls[0].command, 'codex'); assert.ok(run.calls[0].args.includes('exec') && run.calls[0].args.includes('read-only'), 'a minimal read-only exec');
  assert.notEqual(run.calls[0].cwd, process.cwd(), 'started outside any repository');
  assert.equal(out.ok, true); assert.equal(out.outcome, 'new'); assert.equal(out.observedAt, NOW - 1000);
  assert.equal(readCache(w.root).probes.codex.observedAt, NOW - 1000);
  assert.equal(readCache(w.root).probes.codex.windows.find(x => x.type === 'secondary').utilization, 0.47);
});

test('log already newer than the stored reading: no session is run', async t => {
  const w = world(t, { logAt: NOW - 5 * 60000, logWeekly: 47 }), run = fakeRunner();
  const out = await probeNow({ root: w.root, registry: defaultRegistry, config: cfg, agent: 'codex', now: NOW, refresh: w.refresh(run.spawnFn) });
  assert.equal(run.calls.length, 0);
  assert.equal(out.outcome, 'new'); assert.equal(out.observedAt, NOW - 5 * 60000);
});

test('the minimal session is refused while the stored reading shows overage in use, and nothing is spawned', async t => {
  const w = world(t, { stored: storedReading({ billing: { overageStatus: 'allowed', usingOverage: true }, windows: [{ type: 'secondary', utilization: 0.5, resetsAt: NOW + 2 * HOUR, status: 'unknown' }] }) });
  const run = fakeRunner(() => writeRollout(w.home, NOW - 1000, 47, 'b'));
  const out = await probeNow({ root: w.root, registry: defaultRegistry, config: cfg, agent: 'codex', now: NOW, refresh: w.refresh(run.spawnFn) });
  assert.deepEqual(out, { agent: 'codex', ok: false, error: 'overage-risk' });
  assert.equal(run.calls.length, 0);
  assert.equal(probeOutcome(out).outcome, 'refused');
});

test('a session that records nothing new is "nothing-newer"; a session that fails is a failure with its reason', async t => {
  const w = world(t), quiet = fakeRunner();
  const none = await probeNow({ root: w.root, registry: defaultRegistry, config: cfg, agent: 'codex', now: NOW, refresh: w.refresh(quiet.spawnFn) });
  assert.equal(none.ok, true); assert.equal(none.outcome, 'nothing-newer'); assert.equal(none.observedAt, STORED_AT); assert.equal(quiet.calls.length, 1);
  const bad = fakeRunner(null, 1);
  const out = await probeNow({ root: w.root, registry: defaultRegistry, config: cfg, agent: 'codex', now: NOW + 1, refresh: w.refresh(bad.spawnFn) });
  assert.deepEqual(out, { agent: 'codex', ok: false, error: 'session-failed' });
  assert.deepEqual(probeOutcome(out), { outcome: 'failed', reason: 'session-failed' });
});

test('allowSession false (the refresh before a job is admitted) only reads the log', async t => {
  const w = world(t), run = fakeRunner(() => writeRollout(w.home, NOW - 1000, 47, 'b'));
  const r = await refreshProvider(defaultRegistry, 'codex', { now: NOW, home: w.home, spawnFn: run.spawnFn, lockDir: path.join(w.dir, 'locks'), stored: storedReading(), allowSession: false });
  assert.equal(run.calls.length, 0); assert.equal(r.outcome, 'nothing-newer');
});

test('the sentence for each outcome, and only known codes become words', () => {
  const h = { esc: s => s, lt: ms => `T${ms}`, ago: () => '20h ago' }, u = { observedAt: STORED_AT };
  const say = (outcome, reason = '') => outcomeSentence({ outcome, reason }, u, NOW, h);
  assert.match(say('new'), /^Refresh finished: a new reading was observed at T/);
  assert.match(say('nothing-newer'), new RegExp(`no newer reading.*taken at T${STORED_AT} \\(20h ago\\)`));
  assert.match(say('refused'), /not run.*overage/);
  assert.match(say('failed', 'session-failed'), /failed: the minimal session did not finish/);
  assert.equal(outcomeFromQuery(new URLSearchParams('probe=<b>&agent=codex'), 'codex'), null);
  assert.equal(outcomeFromQuery(new URLSearchParams('probe=new&agent=claude'), 'codex'), null);
  assert.deepEqual(outcomeFromQuery(new URLSearchParams('probe=failed&agent=codex&reason=<script>'), 'codex'), { outcome: 'failed', reason: '' });
});

// ---- through the real dashboard server: the redirect ends on a Usage page that contains the sentence
async function pageAfterRefresh(t, w, probe) {
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root: w.root, config: cfg, host: '127.0.0.1', port, now: () => NOW, probe }));
  const call = (p, method = 'GET', body) => new Promise((resolve, reject) => { const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } },
    res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, body: b })); }).on('error', reject); q.end(body); });
  const post = await call('/probe/codex', 'POST', `proof=${writeToken(w.root)}`);
  assert.equal(post.status, 303); const page = await call(post.location);
  assert.equal(page.status, 200); return { post, page, call };
}
const sentenceOf = page => /<p class="probe-outcome"[^>]*data-outcome="([\w-]+)">(.*?)<\/p>/s.exec(page.body);
const OVERAGE = storedReading({ billing: { overageStatus: 'allowed', usingOverage: true }, windows: [{ type: 'secondary', utilization: 0.5, resetsAt: NOW + 2 * HOUR, status: 'unknown' }] });
for (const [label, worldOpts, makeRun, outcome, text] of [
  ['new reading', {}, w => fakeRunner(() => writeRollout(w.home, NOW - 1000, 47, 'b')), 'new', /a new reading was observed at/],
  ['nothing newer', {}, () => fakeRunner(), 'nothing-newer', /no newer reading.*the last one, taken at/],
  ['refused', { stored: OVERAGE }, () => fakeRunner(), 'refused', /not run.*paid overage/],
  ['failed', {}, () => fakeRunner(null, 1), 'failed', /Refresh failed: the minimal session did not finish/]]) {
  test(`dashboard: a refresh that ends "${label}" lands on /usage with its sentence on the agent card`, async t => {
    const w = world(t, worldOpts), run = makeRun(w);
    const { post, page } = await pageAfterRefresh(t, w, o => probeNow({ ...o, refresh: w.refresh(run.spawnFn) }));
    assert.match(post.location, new RegExp(`^/usage\\?probe=${outcome}&agent=codex`));
    const m = sentenceOf(page); assert.ok(m, 'the page has the outcome sentence'); assert.equal(m[1], outcome); assert.match(m[2], text);
    assert.equal(run.calls.length, outcome === 'refused' ? 0 : 1);
  });
}
test('dashboard: a plain /usage visit shows no outcome sentence, and a forged outcome for another agent shows none', async t => {
  const w = world(t), { call } = await pageAfterRefresh(t, w, async () => ({ ok: true, outcome: 'nothing-newer' }));
  assert.doesNotMatch((await call('/usage')).body, /probe-outcome/);
  assert.doesNotMatch((await call('/usage?probe=new&agent=claude')).body, /probe-outcome/);
});

// ---- the real tick (supervisor/cli.mjs team tick): a held Codex agent with a stale reading gets the minimal session, once
test('a live tick runs the minimal session for a held Codex agent with a stale reading, and not again inside the probe interval', t => {
  const dir = tmp(t), root = path.join(dir, 'state'), bin = path.join(dir, 'bin'), marker = path.join(dir, 'session-calls');
  const here = path.dirname(fileURLToPath(import.meta.url)), cli = path.join(here, '..', 'supervisor', 'cli.mjs');
  fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700); fs.mkdirSync(bin);
  const exe = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  exe('gh', 'echo "[]"');
  exe('git', `case "$*" in *"show origin/main:docs/DECISIONS.md"*) cat '${path.join(here, '..', 'docs', 'DECISIONS.md')}';; esac\nexit 0`);
  // The fake Codex session writes the rate limit record a real one does, into today's folder under HOME.
  exe('codex', `echo run >> '${marker}'\nd="$HOME/.codex/sessions/$(date +%Y/%m/%d)"\nmkdir -p "$d"\n`
    + `echo '{"timestamp":"'"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"'","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":3,"window_minutes":300,"resets_at":'$(( $(date +%s) + 18000 ))'},"secondary":{"used_percent":46,"window_minutes":10080,"resets_at":'$(( $(date +%s) + 400000 ))'}}}}' > "$d/rollout-tick.jsonl"`);
  fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify({ enabled: true, alerts: INERT_ALERTS }));
  const now = Date.now();
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ budget: { codex: { mode: 'waiting', until: now - 10 * 60000, since: now - 30 * 3600000, reason: 'weekly 100%: used up', alerted: true } } }));
  const run = () => spawnSync(process.execPath, [cli, 'team', 'tick', '--state-root', root], { encoding: 'utf8', timeout: 90000, env: isolatedEnv(dir, { TMPDIR: dir }, bin) });
  const calls = () => (fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean).length : 0);
  run();
  assert.equal(calls(), 1, 'one minimal session for the held agent');
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'dashboard', 'cache.json'), 'utf8')).probes.codex;
  assert.ok(stored.observedAt >= now - 1000, 'the reading the session recorded was stored');
  run();
  assert.equal(calls(), 1, 'not again inside the probe interval');
});
