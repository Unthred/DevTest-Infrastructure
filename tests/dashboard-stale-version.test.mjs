// Issue #155: a dashboard server on old code must say so, restart itself after a verified self-upgrade, re-read the config,
// and show "unknown" (never Idle) for a job record it cannot understand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';
import { readJobs, agentStates } from '../supervisor/dashdata.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { SelfUpgrade, findDashboards, restartDashboardServer } from '../supervisor/upgrade.mjs';

const NOW = Date.parse('2026-11-01T21:30:00Z');
const OLD = 'a'.repeat(40), NEW = 'b'.repeat(40);
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } }, ...over });
const job = (over = {}) => ({ id: 'c'.repeat(32), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1, ...over });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function install(root, sha) {
  fs.mkdirSync(path.join(root, 'versions', sha), { recursive: true });
  fs.symlinkSync(`versions/${sha}`, path.join(root, 'current'));
}
const view = (root, over = {}) => buildView({ config: config(), root, jobs: [], events: [], state: {}, cache: { tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, pulls: [], issues: [] }, snapshots: [], now: NOW, ...over });

test('a version mismatch gives one Warning card with the old and new version and no "no version drift" text', async t => {
  const root = tmp(t); install(root, NEW);
  const v = await view(root, { running: OLD });
  const cards = v.attention.filter(a => a.id === 'dashboard-stale');
  assert.equal(cards.length, 1); assert.equal(cards[0].severity, 'warning');
  assert.equal(cards[0].text, `Dashboard is running ${OLD.slice(0, 7)}, Foreman is on ${NEW.slice(0, 7)}; what you see may be out of date.`);
  const html = renderPage(v);
  assert.match(html, /what you see may be out of date/); assert.doesNotMatch(html, /No stalls, stale data or version drift/);
});

test('the card clears once the dashboard server is on the new version', async t => {
  const root = tmp(t); install(root, NEW);
  assert.ok(!(await view(root, { running: NEW })).attention.some(a => a.id === 'dashboard-stale'));
  assert.ok(!(await view(root, { running: null })).attention.some(a => a.id === 'dashboard-stale'), 'a source checkout has no running version to compare');
});

test('a job record this version cannot understand shows unknown, never idle; an unparseable record too', async t => {
  const root = tmp(t);
  assert.equal(agentStates(config(), [job({ status: 'awaiting_quantum' })], NOW).claude.state, 'unknown');
  assert.equal(agentStates(config(), [job({ status: 'awaiting_quantum' })], NOW).codex.state, 'idle', 'another provider is unaffected');
  fs.mkdirSync(path.join(root, 'jobs'));
  fs.writeFileSync(path.join(root, 'jobs', `${'d'.repeat(32)}.json`), '{"id": "trunc');
  const jobs = readJobs(root);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].unreadable, true);
  const v = await view(root, { jobs });
  assert.deepEqual(v.agents.map(a => a.state), ['unknown', 'unknown']);
  assert.match(renderPage(v), /Unknown/); assert.doesNotMatch(renderPage(v), /badge[^>]*>Idle/);
  assert.equal(v.health?.state ?? 'unknown', 'unknown');
});

test('positive control: a known running job still shows running, and known records show idle when there are none', () => {
  assert.equal(agentStates(config(), [job()], NOW).claude.state, 'running');
  assert.equal(agentStates(config(), [job({ status: 'completed' })], NOW).claude.state, 'idle');
  assert.equal(agentStates(config(), [job({ status: 'awaiting_quantum' }), job({ id: 'e'.repeat(32) })], NOW).claude.state, 'running', 'a known running job is still reported');
});

test('the server re-reads its configuration on every request; a bad edit keeps the last good one', async t => {
  const root = tmp(t); let cfg = config(), broken = false, calls = 0;
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port;
  server.on('request', handler({ root, config: () => { calls++; if (broken) throw new Error('half-written'); return cfg; }, host: '127.0.0.1', port, now: () => NOW }));
  const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  const issue = n => ({ number: n, title: `issue ${n}`, state: 'OPEN', body: '', labels: [] });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, pulls: [], issues: [issue(5), issue(30)] }));
  const first = JSON.parse((await get('/api/view.json')).body);
  cfg = config({ agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5, 30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } } });
  const second = JSON.parse((await get('/api/view.json')).body);
  assert.ok(calls >= 2);
  assert.notDeepEqual(first.queues, second.queues, 'a changed issue order shows without a restart');
  broken = true;
  assert.equal((await get('/api/view.json')).status, 200, 'a bad edit keeps the last good configuration');
});

// ---- the restart after a verified upgrade
function fakeProc(t, entries) {
  const dir = tmp(t);
  for (const [pid, argv] of Object.entries(entries)) { fs.mkdirSync(path.join(dir, pid)); fs.writeFileSync(path.join(dir, pid, 'cmdline'), `${argv.join('\0')}\0`); }
  return dir;
}
const cli = sha => `/mnt/cache/ai-supervisor/versions/${sha}/supervisor/cli.mjs`;

test('findDashboards only matches dashboard serve; a worker, a tick or a job is never touched', t => {
  const proc = fakeProc(t, {
    100: ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'],
    101: ['node', cli(OLD), 'worker', 'abc', '--state-root', '/x'],
    102: ['node', cli(OLD), 'reconcile'],
    103: ['claude', '-p', 'dashboard serve --host 192.168.1.5'],
    104: ['vim', 'supervisor/cli.mjs', 'dashboard', 'serve']
  });
  assert.deepEqual(findDashboards(proc, -1), [{ pid: 100, host: '192.168.1.5', port: '8731', version: OLD }]);
});

test('after a simulated upgrade the dashboard server restarts on the new version, same host and port', async t => {
  const proc = fakeProc(t, { 100: ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'], 101: ['node', cli(OLD), 'worker', 'abc'] });
  const killed = [], started = [];
  const alive = new Set([100, 101]);
  const kill = (pid, sig) => { if (sig === 0) { if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return; } killed.push([pid, sig]); alive.delete(pid); fs.rmSync(path.join(proc, String(pid)), { recursive: true }); };
  const start = (wrapper, args) => { started.push([wrapper, args]); fs.mkdirSync(path.join(proc, '200')); fs.writeFileSync(path.join(proc, '200', 'cmdline'), ['node', cli(NEW), ...args].join('\0') + '\0'); };
  const r = await restartDashboardServer(NEW, { procRoot: proc, wrapper: '/w', kill, start, sleep: async () => {} });
  assert.deepEqual(r, { ok: true, restarted: true, host: '192.168.1.5', port: '8731' });
  assert.deepEqual(killed, [[100, 'SIGTERM']], 'the worker is not touched');
  assert.deepEqual(started, [['/w', ['dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731']]]);
  assert.deepEqual(findDashboards(proc, -1).map(d => d.version), [NEW]);
});

test('restart: nothing running, already current, will not stop, or does not come back', async t => {
  const none = await restartDashboardServer(NEW, { procRoot: fakeProc(t, {}), sleep: async () => {} });
  assert.deepEqual([none.ok, none.restarted], [true, false]);
  const cur = fakeProc(t, { 100: ['node', cli(NEW), 'dashboard', 'serve', '--host', '10.0.0.2', '--port', '8731'] });
  const kills = [];
  assert.equal((await restartDashboardServer(NEW, { procRoot: cur, kill: (...a) => kills.push(a), sleep: async () => {} })).restarted, false);
  assert.deepEqual(kills, []);
  const stuck = fakeProc(t, { 100: ['node', cli(OLD), 'dashboard', 'serve', '--host', '10.0.0.2', '--port', '8731'] });
  const r1 = await restartDashboardServer(NEW, { procRoot: stuck, kill: () => {}, start: () => assert.fail('must not start'), sleep: async () => {}, tries: 3 });
  assert.equal(r1.ok, false); assert.match(r1.reason, /did not stop/);
  const gone = fakeProc(t, { 100: ['node', cli(OLD), 'dashboard', 'serve', '--host', '10.0.0.2', '--port', '8731'] });
  const alive = new Set([100]);
  const r2 = await restartDashboardServer(NEW, { procRoot: gone, kill: (pid, sig) => { if (sig === 0 && alive.has(pid)) { return; } if (sig === 0) throw Object.assign(new Error(), { code: 'ESRCH' }); alive.delete(pid); }, start: () => {}, sleep: async () => {}, tries: 3 });
  assert.equal(r2.ok, false); assert.match(r2.reason, /did not come back/);
});

test('a verified self-upgrade restarts the dashboard and records it; a failure is recorded and alerted once', async t => {
  for (const [res, expect] of [[{ ok: true, restarted: true }, 'dashboard_restarted'], [{ ok: false, reason: 'the old dashboard server did not stop' }, 'dashboard_restart_failed']]) {
    const root = tmp(t), alerts = [], calls = [];
    const deps = { config: { agents: {} }, restartDashboard: async sha => { calls.push(sha); return res; }, alert: async x => alerts.push(x) };
    const up = new SelfUpgrade({ root, deps, clock: { now: () => NOW } });
    up.s.pending = { from: OLD, to: NEW, prs: [7], checks: {}, at: NOW - 1000 }; up.save();
    assert.equal(await up.verifyPending({ running: NEW, ok: true }), 'verified');
    assert.deepEqual(calls, [NEW]);
    const results = fs.readFileSync(path.join(root, 'team', 'upgrades.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).result);
    assert.deepEqual(results, ['verified', expect]);
    assert.equal(alerts.length, res.ok ? 0 : 1);
  }
});

test('no restart when the upgrade is not verified (rolled back, still waiting)', async t => {
  const root = tmp(t), calls = [];
  const deps = { config: { agents: {} }, restartDashboard: async s => { calls.push(s); return { ok: true }; }, rollback: async () => ({ ok: true }), alert: async () => {} };
  const up = new SelfUpgrade({ root, deps, clock: { now: () => NOW } });
  up.s.pending = { from: OLD, to: NEW, prs: [7], checks: {}, at: NOW - 1000 }; up.save();
  assert.equal(await up.verifyPending({ running: OLD, ok: true }), 'awaiting-verification');
  assert.equal(await up.verifyPending({ running: NEW, ok: false, reason: 'boom' }), 'rolled-back');
  assert.deepEqual(calls, []);
});
