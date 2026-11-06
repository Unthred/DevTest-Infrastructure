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
  assert.equal(cards[0].text, `Dashboard is running ${OLD.slice(0, 7)}, Foreman is on ${NEW.slice(0, 7)}; what you see may be out of date. Restart the dashboard server.`);
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
  const html = renderPage(v);
  assert.match(html, /\? \/ 2/, 'headline count is unknown, not 0 / 2');
  assert.doesNotMatch(html, /0 \/ 2/);
  assert.match(html, /running count is unknown/, 'warnings panel flags it');
  assert.doesNotMatch(html, /No stalls, stale data or version drift/);
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
  assert.deepEqual(findDashboards(proc, -1), [{ pid: 100, host: '192.168.1.5', port: '8731', version: OLD, argv: ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'] }]);
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

test('an unverified upgrade never restarts onto the new version (still waiting; rolled back restarts onto the old one)', async t => {
  const root = tmp(t), calls = [];
  const deps = { config: { agents: {} }, restartDashboard: async s => { calls.push(s); return { ok: true }; }, rollback: async () => ({ ok: true }), alert: async () => {} };
  const up = new SelfUpgrade({ root, deps, clock: { now: () => NOW } });
  up.s.pending = { from: OLD, to: NEW, prs: [7], checks: {}, at: NOW - 1000 }; up.save();
  assert.equal(await up.verifyPending({ running: OLD, ok: true }), 'awaiting-verification');
  assert.equal(await up.verifyPending({ running: NEW, ok: false, reason: 'boom' }), 'rolled-back');
  assert.deepEqual(calls, [OLD], 'only the rollback restarts, onto the restored version; the failed install never restarts onto the new one');
});

// ---- issue #135
test('restart health check: a new process that answers passes; one that never answers fails and is reported', async t => {
  const mk = () => {
    const proc = fakeProc(t, { 100: ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'] });
    const kill = (pid, sig) => { if (sig === 0) { if (!fs.existsSync(path.join(proc, String(pid)))) throw Object.assign(new Error(), { code: 'ESRCH' }); return; } fs.rmSync(path.join(proc, String(pid)), { recursive: true }); };
    const start = (w, args) => { fs.mkdirSync(path.join(proc, '200')); fs.writeFileSync(path.join(proc, '200', 'cmdline'), ['node', cli(NEW), ...args].join('\0') + '\0'); };
    return { proc, kill, start };
  };
  const a = mk(), seen = [];
  const ok = await restartDashboardServer(NEW, { procRoot: a.proc, kill: a.kill, start: a.start, sleep: async () => {}, health: async (h, p) => { seen.push([h, p]); return seen.length > 1; } });
  assert.equal(ok.ok, true); assert.deepEqual(seen[0], ['192.168.1.5', '8731']);
  const b = mk();
  const bad = await restartDashboardServer(NEW, { procRoot: b.proc, kill: b.kill, start: b.start, startOld: () => {}, sleep: async () => {}, tries: 3, health: async () => false });
  assert.equal(bad.ok, false); assert.match(bad.reason, /health check/);
});

test('issue #135: when the new process is unhealthy it is stopped and the old version serves again', async t => {
  const oldArgv = ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'];
  const proc = fakeProc(t, { 100: oldArgv });
  const kill = (pid, sig) => { if (sig === 0) { if (!fs.existsSync(path.join(proc, String(pid)))) throw Object.assign(new Error(), { code: 'ESRCH' }); return; } fs.rmSync(path.join(proc, String(pid)), { recursive: true }); };
  const spawn = (pid, argv) => { fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0'); };
  const restartedOld = [];
  const r = await restartDashboardServer(NEW, {
    procRoot: proc, kill, sleep: async () => {}, tries: 3,
    start: (w, args) => spawn(200, ['node', cli(NEW), ...args]),
    startOld: argv => { restartedOld.push(argv); spawn(300, argv); },
    health: async () => findDashboards(proc, -1).some(d => d.version === OLD)
  });
  assert.equal(r.ok, false); assert.equal(r.recovered, true);
  assert.match(r.reason, /is serving again/); assert.doesNotMatch(r.reason, /NOT/);
  assert.deepEqual(restartedOld, [oldArgv]);
  assert.deepEqual(findDashboards(proc, -1).map(d => d.version), [OLD], 'the unhealthy new process is gone and only the old version runs');
});

test('httpHealth is true for a 200 from /api/view.json and false for an error status or no listener', async t => {
  const { httpHealth } = await import('../supervisor/upgrade.mjs');
  let code = 200;
  const server = http.createServer((req, res) => { res.statusCode = req.url === '/api/view.json' ? code : 404; res.end('{}'); });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port;
  assert.equal(await httpHealth('127.0.0.1', port), true);
  code = 500; assert.equal(await httpHealth('127.0.0.1', port), false);
  await new Promise(r => server.close(r));
  assert.equal(await httpHealth('127.0.0.1', port), false);
});

test('a rollback restarts the dashboard on the restored version; a failed restart alerts once with the action needed', async t => {
  for (const res of [{ ok: true, restarted: true }, { ok: false, reason: 'did not stop' }]) {
    const root = tmp(t), calls = [], alerts = [];
    const deps = { config: { agents: {} }, restartDashboard: async s => { calls.push(s); return res; }, rollback: async () => ({ ok: true }), alert: async x => alerts.push(x) };
    const up = new SelfUpgrade({ root, deps, clock: { now: () => NOW } });
    up.s.pending = { from: OLD, to: NEW, prs: [7], checks: {}, at: NOW - 1000 }; up.save();
    assert.equal(await up.verifyPending({ running: NEW, ok: false, reason: 'boom' }), 'rolled-back');
    assert.deepEqual(calls, [OLD], 'restarted onto the restored version, not the failed one');
    const rec = fs.readFileSync(path.join(root, 'team', 'upgrades.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.equal(rec[0].result, 'rolled_back');
    assert.equal(rec[1].result, res.ok ? 'dashboard_restarted' : 'dashboard_restart_failed');
    assert.equal(alerts.filter(a => /Dashboard server was not restarted/.test(a)).length, res.ok ? 0 : 1);
    if (!res.ok) assert.match(alerts.find(a => /not restarted/.test(a)), /restart it by hand if needed/);
  }
  const root = tmp(t), calls = [];
  const up = new SelfUpgrade({ root, deps: { config: { agents: {} }, restartDashboard: async s => { calls.push(s); return { ok: true }; }, rollback: async () => ({ ok: false, reason: 'x' }), alert: async () => {} }, clock: { now: () => NOW } });
  up.s.pending = { from: OLD, to: NEW, prs: [7], checks: {}, at: NOW - 1000 }; up.save();
  await up.verifyPending({ running: NEW, ok: false });
  assert.deepEqual(calls, [], 'a failed rollback does not restart anything');
});

test('the badge shows "running X, installed Y, restart pending" in amber when they differ, and the status data carries the running commit', async t => {
  const root = tmp(t); install(root, NEW);
  const v = await view(root, { running: OLD });
  assert.equal(v.version.running, OLD);
  const html = renderPage(v);
  assert.match(html, new RegExp(`Restart needed: ${OLD.slice(0, 7)} running, ${NEW.slice(0, 7)} installed`));
  assert.match(html, /badge sev-warning [^>]*>(<svg[^]*?<\/svg>)?Restart needed: [0-9a-f]{7} running, [0-9a-f]{7} installed/);
  const agree = renderPage(await view(root, { running: NEW }));
  assert.doesNotMatch(agree, /Restart needed/);
});

test('issue #265: hand-deploy item and drift values come from live main and the installed commit', async t => {
  const root = tmp(t); install(root, OLD); fs.mkdirSync(path.join(root, 'team'));
  const state = o => fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify(o));
  const cmd = `bash tools/bootstrap-install.sh install https://example.invalid/r.git ${NEW}`;
  state({ main: { sha: NEW, from: OLD, behind: 3, at: NOW }, handDeploy: { from: OLD, to: NEW, files: ['tools/bootstrap-install.sh'], command: cmd, at: NOW } });
  let v = await view(root, { running: OLD });
  const hd = v.attention.filter(a => a.id === 'hand-deploy');
  assert.equal(hd.length, 1); assert.equal(hd[0].severity, 'action');
  assert.ok(hd[0].text.includes(NEW.slice(0, 7)) && hd[0].text.includes('tools/bootstrap-install.sh') && hd[0].text.includes(cmd));
  const drift = v.attention.find(a => a.id === 'drift');
  assert.match(drift.text, /behind main bbbbbbb by 3 commits/);
  // the installed commit moves (manual swap): the item and the stale drift go away
  fs.unlinkSync(path.join(root, 'current')); install(root, NEW);
  v = await view(root, { running: OLD });
  assert.ok(!v.attention.some(a => a.id === 'hand-deploy'), 'item clears when the installed commit moves');
  assert.ok(!v.attention.some(a => a.id === 'drift'));
  assert.match(v.attention.find(a => a.id === 'dashboard-stale').text, /Restart the dashboard server/);
});

test('issue #302: a rollback latch raises a Needs you item with the clear command and replaces the "next try" promise', async t => {
  const root = tmp(t); install(root, OLD); fs.mkdirSync(path.join(root, 'team'));
  fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify({ lastUpgradeAt: NOW - 60_000 }));
  let v = await view(root, { running: OLD });
  assert.ok(!v.attention.some(a => a.id === 'upgrade-latched'));
  assert.ok(v.estimates.waits.some(w => w.kind === 'upgrade'), 'unlatched: the rate-limit wait is shown');
  fs.writeFileSync(path.join(root, 'team', 'self-upgrade.latch'), JSON.stringify({ at: NOW, from: OLD, to: NEW, reason: 'live tick failed: boom' }));
  v = await view(root, { running: OLD });
  const item = v.attention.filter(a => a.id === 'upgrade-latched');
  assert.equal(item.length, 1); assert.equal(item[0].severity, 'action');
  assert.ok(item[0].text.includes(NEW.slice(0, 7)) && item[0].text.includes('live tick failed: boom'));
  const need = v.panels.needsYou.find(a => a.id === 'upgrade-latched');
  assert.equal(need.command, 'ai-supervisor self-upgrade clear-latch');
  assert.ok(!v.estimates.waits.some(w => /next try/.test(w.text)), 'no next try is promised while latched');
  assert.ok(v.estimates.waits.some(w => w.kind === 'upgrade-latched' && /clear-latch/.test(w.text)));
});

// ---- issue #193
test('issue #193: a new server that exits after the first sighting is not recorded as restarted; one that stays up is', async t => {
  const oldArgv = ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'];
  for (const [dies, withHealth] of [[true, false], [true, true], [false, false], [false, true]]) {
    const proc = fakeProc(t, { 100: oldArgv });
    const kill = (pid, sig) => { if (sig === 0) { if (!fs.existsSync(path.join(proc, String(pid)))) throw Object.assign(new Error(), { code: 'ESRCH' }); return; } fs.rmSync(path.join(proc, String(pid)), { recursive: true, force: true }); };
    const spawn = (pid, argv) => { fs.mkdirSync(path.join(proc, String(pid))); fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0'); };
    // The grace-period sleep is where the new process dies (EADDRINUSE-style): it is gone when the check looks again.
    let slept = 0;
    const sleep = async () => { slept++; if (dies && fs.existsSync(path.join(proc, '200'))) fs.rmSync(path.join(proc, '200'), { recursive: true }); };
    const r = await restartDashboardServer(NEW, { procRoot: proc, kill, sleep, tries: 3, start: (w, a) => spawn(200, ['node', cli(NEW), ...a]), startOld: argv => spawn(300, argv),
      ...(withHealth ? { health: async () => true } : {}) });
    assert.equal(r.ok, !dies, `dies=${dies} health=${withHealth}`);
    if (dies) { assert.match(r.reason, /stay|did not come back|did not answer/); }
    else assert.equal(r.restarted, true);
    assert.ok(slept > 0);
  }
});

test('issue #193: a restart lost between the verified record and its outcome is retried on the next step, once', async t => {
  const root = tmp(t), calls = [];
  const deps = { config: { agents: {} }, restartDashboard: async sha => { calls.push(sha); return { ok: true, restarted: true }; }, alert: async () => {}, installed: () => null };
  const first = new SelfUpgrade({ root, deps, clock: { now: () => NOW } });
  first.s.dashboardPending = { from: OLD, to: NEW, rollingBack: false }; first.save();   // the tick died here
  const second = new SelfUpgrade({ root, deps, clock: { now: () => NOW } });
  await second.step();
  assert.deepEqual(calls, [NEW]);
  const results = fs.readFileSync(path.join(root, 'team', 'upgrades.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).result);
  assert.deepEqual(results, ['dashboard_restarted']);
  await new SelfUpgrade({ root, deps, clock: { now: () => NOW } }).step();
  assert.deepEqual(calls, [NEW], 'not retried again once recorded');
});

test('issue #193: the restart intent is cleared only after the outcome record is written', async t => {
  const root = tmp(t), order = [];
  const deps = { config: { agents: {} }, restartDashboard: async () => ({ ok: true, restarted: true }), alert: async () => {}, installed: () => null };
  const u = new SelfUpgrade({ root, deps, clock: { now: () => NOW } });
  const rec = u.record.bind(u);
  u.record = e => { order.push(['record', !!u.s.dashboardPending]); rec(e); };
  await u.restartDashboard({ from: OLD, to: NEW });
  assert.deepEqual(order, [['record', true]], 'pending still saved when the outcome is written');
  assert.equal(u.s.dashboardPending, undefined);
});

test('issue #193: an unreadable record is named, and a stale unknown record stops making agents Unknown', async t => {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'jobs'));
  const bad = path.join(root, 'jobs', `${'d'.repeat(32)}.json`);
  fs.writeFileSync(bad, '{"id": "trunc');
  const jobs = readJobs(root);
  assert.equal(jobs[0].file, `${'d'.repeat(32)}.json`);
  const v = await view(root, { jobs: [{ ...jobs[0], at: NOW - 60000 }] });
  const item = v.attention.find(a => a.id === 'unknown-job-records');
  assert.ok(item); assert.ok(item.text.includes('d'.repeat(32) + '.json'));
  const old = NOW - 8 * 24 * 3600000;
  assert.equal(agentStates(config(), [{ ...jobs[0], at: old }], NOW).claude.state, 'idle', 'an old unreadable file ages out');
  assert.equal(agentStates(config(), [job({ status: 'awaiting_quantum', updatedAt: old, createdAt: old })], NOW).claude.state, 'idle');
  assert.equal(agentStates(config(), [job({ status: 'awaiting_quantum' })], NOW).claude.state, 'unknown', 'a recent unknown record still counts');
  assert.deepEqual(agentStates(config(), [{ ...jobs[0], at: NOW }], NOW).claude.unknownRecords, [`${'d'.repeat(32)}.json`]);
  const none = await view(root, { jobs: [] });
  assert.ok(!none.attention.some(a => a.id === 'unknown-job-records'));
});

// ---- issue #209
const GOOD_ARGV = ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'];
const procKit = (t, initial) => {
  const proc = fakeProc(t, initial);
  const kill = (pid, sig) => { if (sig === 0) { if (!fs.existsSync(path.join(proc, String(pid)))) throw Object.assign(new Error(), { code: 'ESRCH' }); return; } fs.rmSync(path.join(proc, String(pid)), { recursive: true, force: true }); };
  const spawn = (pid, argv) => { fs.mkdirSync(path.join(proc, String(pid)), { recursive: true }); fs.writeFileSync(path.join(proc, String(pid), 'cmdline'), argv.join('\0') + '\0'); };
  return { proc, kill, spawn };
};

test('issue #209: a start that throws is retried once, then the last good version is started and the failure says so', async t => {
  const k = procKit(t, { 100: GOOD_ARGV });
  let starts = 0;
  const r = await restartDashboardServer(NEW, { procRoot: k.proc, kill: k.kill, sleep: async () => {}, tries: 3,
    start: () => { starts++; throw new Error('EACCES'); }, startOld: argv => k.spawn(300, argv), health: async () => findDashboards(k.proc, -1).some(d => d.version === OLD) });
  assert.equal(starts, 2, 'one try and one retry');
  assert.equal(r.ok, false); assert.equal(r.recovered, true);
  assert.match(r.reason, /could not start/); assert.match(r.reason, /tried twice/);
  assert.deepEqual(findDashboards(k.proc, -1).map(d => d.version), [OLD]);
});

test('issue #209: a server that starts but never answers is retried once, then the last good version serves again', async t => {
  const k = procKit(t, { 100: GOOD_ARGV });
  let starts = 0;
  const r = await restartDashboardServer(NEW, { procRoot: k.proc, kill: k.kill, sleep: async () => {}, tries: 3,
    start: (w, a) => { starts++; k.spawn(200 + starts, ['node', cli(NEW), ...a]); }, startOld: argv => k.spawn(300, argv),
    health: async () => findDashboards(k.proc, -1).every(d => d.version === OLD) && findDashboards(k.proc, -1).length > 0 });
  assert.equal(starts, 2); assert.equal(r.ok, false); assert.equal(r.recovered, true);
  assert.match(r.reason, /did not answer/);
  assert.deepEqual(findDashboards(k.proc, -1).map(d => d.version), [OLD], 'both new processes were stopped');
});

test('issue #209: the first try fails, the retry answers: restarted, no fallback', async t => {
  const k = procKit(t, { 100: GOOD_ARGV });
  let starts = 0, fallback = 0;
  const r = await restartDashboardServer(NEW, { procRoot: k.proc, kill: k.kill, sleep: async () => {}, tries: 3,
    start: (w, a) => { starts++; k.spawn(200 + starts, ['node', cli(NEW), ...a]); }, startOld: () => { fallback++; },
    health: async () => starts >= 2 });
  assert.equal(r.ok, true); assert.equal(r.restarted, true); assert.equal(starts, 2); assert.equal(fallback, 0);
});

test('issue #209: when even the last good version cannot be started the result says nothing is serving', async t => {
  const k = procKit(t, { 100: GOOD_ARGV });
  const r = await restartDashboardServer(NEW, { procRoot: k.proc, kill: k.kill, sleep: async () => {}, tries: 2,
    start: () => { throw new Error('boom'); }, startOld: () => { throw new Error('boom'); }, health: async () => false });
  assert.equal(r.ok, false); assert.equal(r.recovered, false); assert.match(r.reason, /nothing is serving now/);
});

test('issue #209: revive starts a server that is not running; without revive nothing is started', async t => {
  const none = procKit(t, {}); let starts = 0;
  const noRevive = await restartDashboardServer(NEW, { procRoot: none.proc, kill: none.kill, sleep: async () => {}, start: () => { starts++; } });
  assert.equal(noRevive.restarted, false); assert.equal(starts, 0);
  const r = await restartDashboardServer(NEW, { procRoot: none.proc, kill: none.kill, sleep: async () => {}, tries: 3, revive: { host: '192.168.1.5', port: '8731', argv: GOOD_ARGV, version: OLD },
    start: (w, a) => { starts++; none.spawn(200, ['node', cli(NEW), ...a]); }, health: async () => true });
  assert.equal(r.ok, true); assert.equal(r.restarted, true); assert.equal(starts, 1);
});

// The tick watchdog, driven with a fake dashboard whose state the test controls.
const watchRig = (t, { startsOk = true } = {}) => {
  const root = tmp(t), log = { restarts: [], alerts: [] };
  const sim = { running: true, healthy: true, startsOk };
  const deps = { config: { agents: {} }, installed: () => NEW, alert: async x => log.alerts.push(x),
    dashboardStatus: async () => ({ running: sim.running, healthy: sim.running && sim.healthy, good: sim.running ? { host: '192.168.1.5', port: '8731', version: OLD, argv: GOOD_ARGV } : null }),
    restartDashboard: async (sha, opts) => { log.restarts.push({ sha, opts }); if (sim.startsOk) { sim.running = true; sim.healthy = true; return { ok: true, restarted: true }; } return { ok: false, recovered: false, reason: 'the dashboard server did not come back' }; } };
  let now = NOW;
  const mkUp = () => new SelfUpgrade({ root, deps, clock: { now: () => now } });
  return { root, log, sim, mk: mkUp, advance: ms => { now += ms; } };
};

test('issue #209: the tick watchdog revives a killed server and leaves a healthy one alone', async t => {
  const w = watchRig(t);
  assert.equal(await w.mk().watchdog(), 'ok'); assert.equal(w.log.restarts.length, 0, 'healthy: untouched');
  w.sim.running = false;   // someone killed it
  assert.equal(await w.mk().watchdog(), 'revived');
  assert.equal(w.log.restarts.length, 1);
  assert.equal(w.log.restarts[0].opts.force, true); assert.deepEqual(w.log.restarts[0].opts.revive.argv, GOOD_ARGV);
  const results = fs.readFileSync(path.join(w.root, 'team', 'upgrades.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l).result);
  assert.deepEqual(results, ['dashboard_revived']);
  assert.equal(w.log.alerts.length, 0);
});

test('issue #209: a running server that does not answer is restarted only when seen unhealthy on two ticks', async t => {
  const w = watchRig(t);
  await w.mk().watchdog();
  w.sim.healthy = false;
  assert.equal(await w.mk().watchdog(), 'unhealthy-wait'); assert.equal(w.log.restarts.length, 0, 'it may still be starting');
  w.advance(300000);
  assert.equal(await w.mk().watchdog(), 'revived'); assert.equal(w.log.restarts.length, 1);
  w.sim.healthy = false; w.advance(300000);
  assert.equal(await w.mk().watchdog(), 'unhealthy-wait', 'a recovered server that answers again resets the wait');
});

test('issue #209: crash-loop throttling: restarts back off, cap, and reset after a quiet half hour', async t => {
  const w = watchRig(t);
  await w.mk().watchdog();
  const crash = async () => { w.sim.running = false; return w.mk().watchdog(); };
  assert.equal(await crash(), 'revived');                     // attempt 1 at t=0
  w.advance(60000); assert.equal(await crash(), 'throttled'); // 1 min later: within the 5 minute delay
  assert.equal(w.log.restarts.length, 1);
  w.advance(300000); assert.equal(await crash(), 'revived');  // attempt 2 allowed after 5 min
  w.advance(300000); assert.equal(await crash(), 'throttled'); // attempt 3 needs 10 min
  w.advance(300000); assert.equal(await crash(), 'revived');
  assert.equal(w.log.restarts.length, 3);
  w.advance(11 * 60000); assert.equal(await crash(), 'throttled', 'the third failure needs 20 min');
  // A quiet period: healthy and 30+ minutes since the last attempt resets the count.
  w.sim.running = true; w.sim.healthy = true; w.advance(31 * 60000);
  assert.equal(await w.mk().watchdog(), 'ok');
  assert.equal(await crash(), 'revived', 'the next crash restarts straight away');
  assert.equal(w.log.restarts.length, 4);
});

test('issue #209: a restart that fails is recorded, alerted once, and raised as a Needs you item once the server is back', async t => {
  const w = watchRig(t, { startsOk: false });
  await w.mk().watchdog();
  w.sim.running = false;
  assert.equal(await w.mk().watchdog(), 'revive-failed');
  w.advance(300000); assert.equal(await w.mk().watchdog(), 'revive-failed');
  assert.equal(w.log.alerts.length, 1, 'one alert per outage');
  const state = JSON.parse(fs.readFileSync(path.join(w.root, 'team', 'self-upgrade.json'), 'utf8'));
  assert.equal(state.dashboardFailure.kind, 'watchdog');
  install(w.root, NEW);
  let v = await view(w.root, { running: NEW });
  const item = v.panels.needsYou.filter(a => a.id === 'dashboard-restart-failed');
  assert.equal(item.length, 1); assert.equal(item[0].severity, 'action');
  assert.match(item[0].text, /did not come back/);
  // The server answers again (someone started it by hand): the watchdog clears its own item.
  w.sim.running = true; w.sim.healthy = true;
  assert.equal(await w.mk().watchdog(), 'ok');
  v = await view(w.root, { running: NEW });
  assert.ok(!v.attention.some(a => a.id === 'dashboard-restart-failed'));
});

test('issue #209: a failed restart after a recovery is a new outage and is alerted again', async t => {
  const w = watchRig(t, { startsOk: false });
  await w.mk().watchdog();
  w.sim.running = false;
  assert.equal(await w.mk().watchdog(), 'revive-failed');
  assert.equal(w.log.alerts.length, 1);
  w.sim.startsOk = true;
  w.advance(300000); assert.equal(await w.mk().watchdog(), 'revived');
  w.sim.startsOk = false; w.sim.running = false;
  w.advance(600000); assert.equal(await w.mk().watchdog(), 'revive-failed');
  assert.equal(w.log.alerts.length, 2, 'the second outage sends its own alert');
});

test('issue #209: a failed upgrade restart that fell back to the last good version stays a Needs you item until a restart succeeds', async t => {
  const root = tmp(t), alerts = []; install(root, NEW);
  let res = { ok: false, recovered: true, reason: 'the dashboard server started on bbbbbbb but did not answer its health check (tried twice)' };
  const deps = { config: { agents: {} }, restartDashboard: async () => res, alert: async x => alerts.push(x) };
  await new SelfUpgrade({ root, deps, clock: { now: () => NOW } }).restartDashboard({ from: OLD, to: NEW });
  let v = await view(root, { running: OLD });
  const item = v.panels.needsYou.find(a => a.id === 'dashboard-restart-failed');
  assert.ok(item); assert.match(item.text, /last good version was started again/); assert.ok(item.text.includes(NEW.slice(0, 7)));
  assert.equal(alerts.length, 1);
  res = { ok: true, restarted: true };
  await new SelfUpgrade({ root, deps, clock: { now: () => NOW } }).restartDashboard({ from: OLD, to: NEW });
  v = await view(root, { running: NEW });
  assert.ok(!v.attention.some(a => a.id === 'dashboard-restart-failed'));
});

test('issue #209: the watchdog does nothing while an upgrade awaits verification, or when no server was ever seen', async t => {
  const w = watchRig(t);
  w.sim.running = false;
  assert.equal(await w.mk().watchdog(), 'unknown'); assert.equal(w.log.restarts.length, 0, 'host and port are unknown, so nothing is guessed');
  const up = w.mk(); up.s.pending = { from: OLD, to: NEW, at: NOW }; up.save();
  assert.equal(await w.mk().watchdog(), 'skipped');
});

test('issue #488: the dashboard shows the refusal item only while installed commit and main still match it', async t => {
  const root = tmp(t); install(root, OLD); fs.mkdirSync(path.join(root, 'team'));
  const state = o => fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify(o));
  state({ main: { sha: NEW, from: OLD, behind: 1, at: NOW }, refusal: { from: OLD, to: NEW, kind: 'not-eligible', reason: 'CI was not green', at: NOW } });
  let v = await view(root, { running: OLD });
  const it = v.attention.filter(a => a.id === 'upgrade-refused');
  assert.equal(it.length, 1); assert.equal(it[0].severity, 'action'); assert.match(it[0].text, /not eligible.*CI was not green/);
  state({ main: { sha: 'c'.repeat(40), from: OLD, behind: 2, at: NOW }, refusal: { from: OLD, to: NEW, kind: 'not-eligible', reason: 'x', at: NOW } });
  v = await view(root, { running: OLD }); assert.ok(!v.attention.some(a => a.id === 'upgrade-refused'), 'main moved');
  state({ main: { sha: NEW, from: OLD, behind: 1, at: NOW }, refusal: { from: OLD, to: NEW, kind: 'precheck', reason: 'x', at: NOW } });
  fs.unlinkSync(path.join(root, 'current')); install(root, NEW);
  v = await view(root, { running: NEW }); assert.ok(!v.attention.some(a => a.id === 'upgrade-refused'), 'installed commit moved');
});

// ---- issue #632: a slow healthy server passes; an immediate exit fails with its output kept, redacted
test('issue #632: a slow-to-answer but healthy server passes; a process that exits straight away fails with cause and output', async t => {
  const mk = () => {
    const proc = fakeProc(t, { 100: ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'] });
    const kill = (pid, sig) => { if (sig === 0) { if (!fs.existsSync(path.join(proc, String(pid)))) throw Object.assign(new Error(), { code: 'ESRCH' }); return; } fs.rmSync(path.join(proc, String(pid)), { recursive: true }); };
    const start = (w, args) => { fs.mkdirSync(path.join(proc, '200')); fs.writeFileSync(path.join(proc, '200', 'cmdline'), ['node', cli(NEW), ...args].join('\0') + '\0'); };
    return { proc, kill, start };
  };
  // Slow: the first probes time out under load, then it answers steadily. No failure, no second attempt.
  const a = mk(); let probes = 0, starts = 0;
  const slow = await restartDashboardServer(NEW, { procRoot: a.proc, kill: a.kill, start: (w, x) => { starts++; a.start(w, x); }, sleep: async () => {}, health: async () => ++probes > 5 });
  assert.equal(slow.ok, true); assert.equal(starts, 1); assert.ok(probes >= 8, 'several probes, not one');

  // Exits right after it first answered: fails with cause "exited" and the redacted output the process wrote.
  const fakeKey = ['sk', 'x'.repeat(24)].join('-'), fakeBearer = ['Bearer', 'a1b2c3d4e5f6a7b8c9d0'].join(' ');
  const b = mk(); let answered = 0;
  const gone = await restartDashboardServer(NEW, {
    procRoot: b.proc, kill: b.kill, start: b.start, startOld: () => {}, sleep: async () => {}, tries: 3,
    health: async () => { if (++answered === 1) return true; fs.rmSync(path.join(b.proc, '200'), { recursive: true, force: true }); return false; },
    logMark: () => 0, logTail: () => `Error: listen EADDRINUSE 192.168.1.5:8731 token=${fakeKey} ${fakeBearer}`
  });
  assert.equal(gone.ok, false); assert.equal(gone.cause, 'exited');
  assert.match(gone.output, /EADDRINUSE/);
  assert.doesNotMatch(JSON.stringify(gone), new RegExp(fakeKey.slice(3, 15))); assert.doesNotMatch(JSON.stringify(gone), /a1b2c3d4e5f6/);
});

test('issue #632: a running server that never answers is "unresponsive" after the bounded wait, not "exited"', async t => {
  const proc = fakeProc(t, { 100: ['node', cli(OLD), 'dashboard', 'serve', '--host', '192.168.1.5', '--port', '8731'] });
  const kill = (pid, sig) => { if (sig === 0) { if (!fs.existsSync(path.join(proc, String(pid)))) throw Object.assign(new Error(), { code: 'ESRCH' }); return; } fs.rmSync(path.join(proc, String(pid)), { recursive: true }); };
  const start = (w, args) => { fs.mkdirSync(path.join(proc, '200')); fs.writeFileSync(path.join(proc, '200', 'cmdline'), ['node', cli(NEW), ...args].join('\0') + '\0'); };
  let n = 0;
  const r = await restartDashboardServer(NEW, { procRoot: proc, kill, start, startOld: () => {}, sleep: async () => {}, tries: 3, settleMaxMs: 10000, settleProbeMs: 1000, health: async () => (++n === 1), logTail: () => '' });
  assert.equal(r.ok, false); assert.equal(r.cause, 'unresponsive'); assert.match(r.reason, /stopped answering/);
});
