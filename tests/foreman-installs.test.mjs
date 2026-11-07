// Issue #625: foreman_installs and foreman_breaker_history (D-030). Bounded, redacted, read-only records served by the dashboard and read by
// the MCP tools. Every secret-shaped fixture is assembled at run time; no model is called and no real state is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { installs, breakerHistory, processVersions } from '../supervisor/installs.mjs';
import * as breaker from '../supervisor/breaker.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { getJson } from '../foreman-mcp/source.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const PW = ['pass', 'word'].join(''), PWVAL = ['hunter2', 'hunter2x'].join('');
const tmp = (t, p = 'inst-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const CONFIG = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/nonexistent/repo', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [3] } } };

function seed(root) {
  fs.mkdirSync(path.join(root, 'team'), { recursive: true }); fs.mkdirSync(path.join(root, 'versions', A), { recursive: true });
  fs.symlinkSync(`versions/${A}`, path.join(root, 'current'));
  fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), [
    { at: 1000, from: A, to: B, prs: [5], result: 'precheck_failed', reason: `tests failed ${PW}=${PWVAL}`, checks: { preChecks: 'failed' } },
    { at: 2000, from: A, to: C, prs: [6, 7], result: 'upgraded', checks: { preChecks: 'ok' } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify({
    install: { result: 'precheck_failed', sha: B, at: 1000, reason: `1 test failed, token ${GH}`, tests: ['tests/flaky.test.mjs: waits for a socket'], excerpt: `not ok 3 - flaky\n  ${PW}: ${PWVAL}`, retried: true },
    holding: { to: C, since: 3000, jobs: 2 }, main: { sha: C, from: A, behind: 2 }, prechecked: { [B]: 1000 } }));
}
function fakeProc(t, entries) {
  const proc = tmp(t, 'proc-');
  for (const [pid, args] of entries) { fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), args.join('\0') + '\0'); }
  return proc;
}

test('processVersions reads the version per role from command lines only, and ignores unrelated processes', t => {
  const proc = fakeProc(t, [
    [11, ['node', `/r/versions/${A}/supervisor/dashserver.mjs`, '--token', GH]],
    [12, ['node', `/r/versions/${B}/supervisor/cli.mjs`, 'team', 'tick']],
    [13, ['node', `/r/versions/${A}/supervisor/viewworker-entry.mjs`]],
    [14, ['bash', '-c', 'sleep 1']], [15, ['node', '/home/x/versions/short/a.mjs']],
  ]);
  const got = processVersions(proc);
  assert.deepEqual(got.map(p => [p.role, p.version]).sort(), [['dashboard', A], ['foreman', B], ['worker', A]]);
  assert.ok(!JSON.stringify(got).includes(GH), 'arguments are never returned');
  assert.deepEqual(processVersions('/nonexistent-proc'), []);
});

test('processVersions recognises the real host command lines: dashboard via cli.mjs, Foreman via current/ reconcile', t => {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'versions', A, 'supervisor'), { recursive: true }); fs.writeFileSync(path.join(root, 'versions', A, 'supervisor', 'cli.mjs'), '');
  fs.symlinkSync('versions/' + A, path.join(root, 'current'));
  const proc = fakeProc(t, [
    [21, ['node', `${root}/versions/${B}/supervisor/cli.mjs`, 'dashboard', 'serve', '--host', 'h', '--port', '8731']],
    [22, ['node', `${root}/current/supervisor/cli.mjs`, 'reconcile', '--wake', 'x']],
  ]);
  assert.deepEqual(processVersions(proc).map(p => [p.role, p.version]).sort(), [['dashboard', B], ['foreman', A]]);
  fs.rmSync(path.join(root, 'versions', A), { recursive: true }); // symlink target gone: fall back to the installed version
  assert.deepEqual(processVersions(proc, { currentSha: C }).map(p => [p.role, p.version]).sort(), [['dashboard', B], ['foreman', C]]);
});

test('installs reports installed/main, draining, the failing test, a stale process version and redacts', t => {
  const root = tmp(t); seed(root);
  const proc = fakeProc(t, [[1, ['node', `/r/versions/${A}/supervisor/dashserver.mjs`]], [2, ['node', `/r/versions/${B}/supervisor/cli.mjs`, 'team', 'tick']]]);
  const r = installs(root, { now: 5000, procRoot: proc });
  assert.equal(r.installed, A); assert.equal(r.main, C); assert.equal(r.behind, 2); assert.equal(r.drift, true);
  assert.deepEqual(r.draining, { to: C, since: new Date(3000).toISOString(), jobsRunning: 2 });
  assert.equal(r.lastInstall.result, 'precheck_failed'); assert.deepEqual(r.lastInstall.failingTests, ['tests/flaky.test.mjs: waits for a socket']); assert.equal(r.lastInstall.retried, true);
  assert.deepEqual(r.processes.map(p => [p.role, p.matchesInstalled]), [['dashboard', true], ['foreman', false]]);
  assert.deepEqual(r.recent.map(x => [x.result, x.failed]), [['upgraded', false], ['precheck_failed', true]], 'newest first');
  const text = JSON.stringify(r);
  for (const bad of [GH, PWVAL]) assert.ok(!text.includes(bad), `leaked ${bad.slice(0, 6)}`);
});

test('installs with no records and no link is empty, not an error', t => {
  const r = installs(tmp(t), { procRoot: '/nonexistent-proc' });
  assert.equal(r.installed, null); assert.equal(r.draining, null); assert.equal(r.lastInstall, null); assert.deepEqual(r.recent, []); assert.deepEqual(r.processes, []);
});

const limits = { ...breaker.BREAKER_DEFAULTS };
const waste = (job, at, cost, cause = 'review:refused:x') => ({ job, at, type: 'review', cause, agent: 'claude', pr: 9, issue: null, model: 'm', inputTokens: 5, outputTokens: 5, tokens: 10, cost });

test('the breaker records each trip with cause, jobs, cost and when it cleared; a re-trip is a new entry', () => {
  const s = breaker.emptyState(); const T = 1e12;
  for (let i = 0; i < 3; i++) breaker.record(s, waste(`j${i}`, T + i, 0.5), T + i);
  assert.equal(breaker.evaluate(s, limits, T + 10).length, 1);
  let h = breakerHistory({ breaker: s });
  assert.equal(h.count, 1); assert.equal(h.halted, true); assert.equal(h.trips[0].stillHalted, true); assert.equal(h.trips[0].clearedAt, null);
  assert.equal(h.trips[0].scope, 'review:refused:x'); assert.equal(h.trips[0].jobs, 3); assert.equal(h.trips[0].costUsdEquivalent, 1.5); assert.deepEqual(h.trips[0].prs, [9]);
  breaker.evaluate(s, limits, T + 20); assert.equal(s.history.length, 1, 'a held halt updates its entry, no duplicate');
  breaker.resume(s, 'all', T + 100);
  h = breakerHistory({ breaker: s }); assert.equal(h.halted, false); assert.equal(h.trips[0].clearedAt, new Date(T + 100).toISOString()); assert.equal(h.trips[0].stillHalted, false);
  for (let i = 3; i < 6; i++) breaker.record(s, waste(`j${i}`, T + 200 + i, 0.5), T + 200 + i);
  breaker.evaluate(s, limits, T + 300);
  h = breakerHistory({ breaker: s }); assert.equal(h.count, 2); assert.equal(h.trips[0].stillHalted, true); assert.equal(h.trips[1].stillHalted, false, 'newest first');
});

test('a halt ended by a later success of its job type is marked cleared in the history', () => {
  const s = breaker.emptyState(); const T = 1e12;
  for (let i = 0; i < 3; i++) breaker.record(s, waste(`j${i}`, T + i, 0.5), T + i);
  breaker.evaluate(s, limits, T + 10);
  assert.deepEqual(breaker.succeeded(s, { type: 'review', createdAt: T + 50 }, T + 60), ['review:refused:x']);
  const h = breakerHistory({ breaker: s });
  assert.equal(h.halted, false); assert.equal(h.trips[0].stillHalted, false); assert.equal(h.trips[0].clearedAt, new Date(T + 60).toISOString());
});

test('breaker history: old state without history shows the halt in force; limit and corrupt rows are handled; nothing secret escapes', () => {
  const live = { breaker: { halts: { [`review:no-verdict:${GH}`]: { cause: `review:no-verdict:${GH}`, since: 5, trippedBy: 'count', jobs: 3, tokens: 30, cost: 1, prs: [1], issues: [], types: ['review'], jobIds: ['x'] } }, waste: {}, history: [null, 'junk'] } };
  const h = breakerHistory(live); assert.equal(h.count, 1); assert.equal(h.trips[0].stillHalted, true); assert.ok(!JSON.stringify(h).includes(GH));
  assert.deepEqual(breakerHistory({}).trips, []); assert.deepEqual(breakerHistory(null).trips, []);
  const many = { breaker: { history: Array.from({ length: 10 }, (_, i) => ({ scope: `c${i}`, since: i + 1, clearedAt: i + 2, jobs: 1, tokens: 1, cost: 0.1 })) } };
  const lim = breakerHistory(many, 3); assert.equal(lim.count, 10); assert.equal(lim.shown, 3); assert.equal(lim.trips[0].scope, 'c9');
});

test('the history is capped', () => {
  const t = breaker.emptyState(); for (let i = 0; i < 130; i++) { t.waste = {}; for (let k = 0; k < 3; k++) t.waste[`w${i}-${k}`] = waste(`w${i}-${k}`, 1e12 + i * 1000, 0.1, `c${i}`); breaker.evaluate(t, limits, 1e12 + i * 1000 + 1); breaker.resume(t, 'all', 1e12 + i * 1000 + 2); }
  assert.equal(t.history.length, 100);
});

async function serve(t, root) {
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port; server.on('request', handler({ root, config: CONFIG, host: '127.0.0.1', port }));
  const raw = (method, p) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}` } }, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); }); q.on('error', rej); q.end(); });
  return { base: `http://127.0.0.1:${port}`, raw };
}

const snapshot = root => { const out = {}; const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out[p] = fs.readFileSync(p, 'utf8'); } }; walk(root); return out; };

test('end to end: GET-only routes, the two MCP tools, limit, redaction and an unchanged state tree', async t => {
  const root = tmp(t); seed(root);
  const s0 = breaker.emptyState(); for (let i = 0; i < 3; i++) breaker.record(s0, waste(`j${i}`, 1e12 + i, 0.5, `review:x ${GH}`), 1e12);
  breaker.evaluate(s0, limits, 1e12 + 10);
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {}, breaker: s0 }));
  const s = await serve(t, root);
  assert.equal((await s.raw('POST', '/api/installs.json')).status !== 200, true); assert.equal((await s.raw('POST', '/api/breaker.json')).status !== 200, true);
  assert.equal(JSON.parse((await s.raw('GET', '/api/installs.json')).body).installed, A);
  assert.equal(JSON.parse((await s.raw('GET', '/api/breaker.json')).body).count, 1);
  const before = snapshot(root);
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), getPath: p => getJson(new URL(p, `${s.base}/api/view.json`).href) });
  const mine = tools.list().filter(x => ['foreman_installs', 'foreman_breaker_history'].includes(x.name)); assert.equal(mine.length, 2); assert.ok(mine.every(x => x.annotations.readOnlyHint === true));
  const i = await tools.call('foreman_installs', { limit: 1 }); assert.equal(i.isError, false);
  const iv = JSON.parse(i.text); assert.equal(iv.recent.length, 1); assert.equal(iv.lastInstall.failingTests[0], 'tests/flaky.test.mjs: waits for a socket');
  const b = await tools.call('foreman_breaker_history'); const bv = JSON.parse(b.text); assert.equal(bv.shown, 1); assert.equal(bv.trips[0].jobs, 3);
  for (const bad of [GH, PWVAL]) for (const r of [i, b]) assert.ok(!r.text.includes(bad), 'no secret-shaped output');
  assert.deepEqual(snapshot(root), before, 'state is untouched');
});

test('without a dashboard address both tools fail cleanly', async () => {
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}) });
  assert.equal((await tools.call('foreman_installs')).isError, true); assert.equal((await tools.call('foreman_breaker_history')).isError, true);
});

test('processVersions takes the cli role from the subcommand position, not a later argument', t => {
  const proc = fakeProc(t, [
    [31, ['node', `/r/versions/${A}/supervisor/cli.mjs`, 'status', 'dashboard']],
    [32, ['node', `/r/versions/${A}/supervisor/cli.mjs`, 'worker', 'run', 'dashboard']],
  ]);
  assert.deepEqual(processVersions(proc).map(p => [p.pid, p.role]), [[31, 'supervisor-cli'], [32, 'worker']].sort((a, b) => a[1].localeCompare(b[1])));
});

test('installs validates refusal.from as a commit SHA, like to', t => {
  const root = tmp(t); seed(root);
  const file = path.join(root, 'team', 'self-upgrade.json'), su = JSON.parse(fs.readFileSync(file, 'utf8'));
  const refusal = from => { fs.writeFileSync(file, JSON.stringify({ ...su, refusal: { kind: 'x', from, to: C, at: 1, reason: 'r' } })); return installs(root, { procRoot: '/nonexistent-proc' }).refusal; };
  assert.equal(refusal(A).from, A);
  assert.equal(refusal(`${GH}`).from, null);
  assert.equal(refusal(undefined).from, null);
});
