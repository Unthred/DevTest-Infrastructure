// Issue #1151: the host pressure hold uses real memory pressure (swap activity, available memory), not how full swap ever got, and the
// reason it gives is the same on every surface. Pure decisions first, then the real tick, the real view and the real MCP tools.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { compactIssues } from '../supervisor/dashdata.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { createProtocol } from '../foreman-mcp/protocol.mjs';
import { HOST_PRESSURE_DEFAULTS, hostPressureConfig, evaluateHostPressure, addSwapSample, swapRate, readHostPressure, readMemory, readSwapPages, hostPressureView } from '../supervisor/hostpressure.mjs';

const CFG = { ...HOST_PRESSURE_DEFAULTS };
const MIN = 60000;
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];

test('swap used 92% with no swap activity and memory above the floor does not hold; it is a warning only', () => {
  const v = evaluateHostPressure(CFG, { diskPercent: 40, swapPercent: 92, swapRate: 0, availableMb: 7900 });
  assert.equal(v.hold, false);
  assert.deepEqual(v.reasons, []);
  assert.equal(v.warnings.length, 1);
  assert.match(v.warnings[0], /swap is 92% used \(a warning only/);
});

test('sustained swap activity holds and names the measure and its value; so does low available memory; so does a full disk', () => {
  const act = evaluateHostPressure(CFG, { diskPercent: 40, swapPercent: 10, swapRate: 340.4, availableMb: 7900 });
  assert.equal(act.hold, true);
  assert.deepEqual(act.reasons, ['swap activity is 340 pages per second over 5 minutes (limit 200)']);
  const mem = evaluateHostPressure(CFG, { diskPercent: 40, swapPercent: 10, swapRate: 0, availableMb: 612 });
  assert.deepEqual(mem.reasons, ['available memory is 612 MB (floor 1024 MB)']);
  const disk = evaluateHostPressure(CFG, { diskPercent: 81, swapPercent: 10, swapRate: 0, availableMb: 7900 });
  assert.deepEqual(disk.reasons, ['the root volume is 81% full (limit 80%)']);
  assert.equal(evaluateHostPressure(CFG, { diskPercent: 80, swapPercent: 10, swapRate: 200, availableMb: 1024 }).hold, false, 'the thresholds are exclusive');
});

test('an unreadable measure never holds', () => {
  assert.equal(evaluateHostPressure(CFG, {}).hold, false);
});

test('the swap window: an average over the window, no verdict until half the window is covered, a counter reset starts again', () => {
  let s = [];
  for (let i = 0; i <= 6; i++) s = addSwapSample(s, [i * MIN, i * 60 * 500], 5);
  assert.equal(swapRate(s, 5), 500);
  assert.equal(swapRate(addSwapSample([], [0, 0], 5), 5), null, 'one sample is no rate');
  assert.equal(swapRate(addSwapSample(addSwapSample([], [0, 0], 5), [MIN, 6000], 5), 5), null, 'one minute covers under half of five');
  const rebooted = addSwapSample(s, [7 * MIN, 10], 5);
  assert.equal(rebooted.length, 1, 'the counter went down: history dropped');
  assert.equal(swapRate(rebooted, 5), null);
  const burst = addSwapSample(addSwapSample([[0, 0]], [3 * MIN, 0], 5), [4 * MIN, 120000], 5);
  assert.equal(Math.round(swapRate(burst, 5)), 500, 'a burst is averaged over the window, not read as an instant');
});

test('configuration: defaults, overrides and bad values', () => {
  assert.deepEqual(hostPressureConfig(undefined), HOST_PRESSURE_DEFAULTS);
  assert.equal(hostPressureConfig({ min_available_mb: 2048 }).min_available_mb, 2048);
  assert.equal(hostPressureConfig({ min_available_mb: 2048 }).swap_pages_per_second, 200);
  for (const bad of [{ swap_window_minutes: 0 }, { swap_pages_per_second: 'x' }, { nope: 1 }, [], null, { disk_percent: 101 }]) assert.throws(() => hostPressureConfig(bad), /host_pressure/);
  const base = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateTeamConfig(base).host_pressure, HOST_PRESSURE_DEFAULTS, 'team.json carries the documented defaults');
  assert.throws(() => validateTeamConfig({ ...base, host_pressure: { swap_window_minutes: -1 } }), /host_pressure/);
});

test('readers: meminfo and vmstat from files; unreadable gives null', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'meminfo'), 'MemAvailable:    8286208 kB\nSwapTotal:      17179868 kB\nSwapFree:        1048576 kB\n');
  fs.writeFileSync(path.join(dir, 'vmstat'), 'pswpin 100\npswpout 250\n');
  assert.deepEqual(readMemory(path.join(dir, 'meminfo')), { availableMb: 8092, swapPercent: 94 });
  assert.equal(readSwapPages(path.join(dir, 'vmstat')), 350);
  assert.deepEqual(readMemory(path.join(dir, 'none')), { availableMb: null, swapPercent: null });
  assert.equal(readSwapPages(path.join(dir, 'none')), null);
});

// ---- the real tick, view and tools

const NOW = Date.parse('2026-11-10T17:17:00Z');
const RESET = NOW + 3 * 86400000;
const claudeAllowance = weekly => ({ provider: 'claude', status: 'allowed', observedAt: NOW,
  windows: [{ type: 'five_hour', utilization: 0.1, resetsAt: NOW + 3 * 3600000, status: 'allowed' }, { type: 'seven_day', utilization: weekly, resetsAt: RESET, status: 'allowed' }],
  billing: { overageStatus: 'rejected', usingOverage: false } });
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });
const issue = n => ({ number: n, title: `Issue ${n}`, state: 'OPEN', body: '', labels: [] });
const pull = { number: 10, title: 'pr ten', headRefName: 'codex/issue-2-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], url: 'u' };
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: agent-proposal\n';

// The 10 Nov 2026 situation: claude is "reviews only: weekly 93%", a review of PR 10 is planned, and the host readings are injected.
function world(t, host) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { created: [] };
  const gh = { listPulls: async () => [pull], getPull: async () => pull, listIssues: async () => [issue(23), issue(2)], comment: async () => {}, addLabel: async () => {}, board: async () => {},
    listMergedPulls: async () => [], hasComment: async () => false, findIssueByMarker: async () => null, findOpenIssueByMarker: async () => null };
  const jobs = { active: [], states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const clock = { t: NOW, now: () => clock.t };
  const usage = { allowance: { claude: claudeAllowance(0.93) }, jobs: [], snapshots: [] };
  const w = { dir, calls, clock, host };
  w.team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock, usage,
    hostPressure: () => readHostPressure(w.team, { disk: () => ({ disk: { percent: 40 }, top: [] }), memory: () => host.memory, swapPages: () => host.pages }) });
  return w;
}
const calm = () => ({ memory: { availableMb: 7900, swapPercent: 92 }, pages: 1000 });
const view = async (w, probes = { claude: claudeAllowance(0.93) }) => buildView({ config: config(), root: w.dir, jobs: [], events: [], state: JSON.parse(JSON.stringify(w.team.s)), snapshots: [], now: w.clock.now(), tz: 'UTC',
  cache: { tick: { at: w.clock.now(), status: 'ok', error: null, lastOkAt: w.clock.now() }, fetchedAt: w.clock.now(), pulls: [pull], issues: compactIssues([issue(23), issue(2)]), probes } });

test('control: swap 92% used, zero swap activity, memory above the floor: the planned review starts (the Tower acceptance case)', async t => {
  const w = world(t, calm());
  const r = await w.team.tick();
  assert.equal(w.calls.created.length, 1, 'the planned review started');
  assert.equal(w.calls.created[0].provider, 'claude');
  assert.equal(r.held, undefined);
  const rec = w.team.s.hostPressure;
  assert.equal(rec.hold, false);
  assert.match(rec.warnings[0], /swap is 92% used/);
  assert.equal(w.team.selfCheckItems().some(i => i.id === 'selfcheck-host-pressure'), false);
});

test('sustained swap activity holds starts; every surface gives the host reason for the review, never the allowance mode', async t => {
  const w = world(t, calm());
  w.team.s.hostPressure = { samples: [[NOW - 6 * MIN, 0]] };   // six minutes of history, then 500 pages per second
  w.host.pages = 6 * 60 * 500;
  const r = await w.team.tick();
  assert.equal(w.calls.created.length, 0, 'no job started under pressure');
  assert.match(r.held.reason, /^host pressure: swap activity is 500 pages per second over 5 minutes \(limit 200\)$/);
  assert.deepEqual(r.actions.filter(a => a.type !== 'merge'), []);
  // Needs you names the measure and its value
  assert.match(w.team.selfCheckItems().find(i => i.id === 'selfcheck-host-pressure').text, /swap activity is 500 pages per second over 5 minutes \(limit 200\)/);
  // the tick's record of why claude is idle
  assert.match(JSON.stringify(r.holds.claude), /host pressure: swap activity is 500/);
  assert.doesNotMatch(JSON.stringify(r.holds.claude), /reviews only/);

  const v = await view(w);
  const reason = 'host pressure: swap activity is 500 pages per second over 5 minutes (limit 200)';
  const review = v.plan.find(a => a.type === 'review');
  assert.ok(review, 'the review is still planned');
  assert.equal(review.heldBy, reason);
  assert.equal(v.panels.next.find(n => n.type === 'review').why, reason, 'the dashboard Next card');
  assert.match(v.agents.find(a => a.name === 'claude').idleReason.text, new RegExp(`once the hold clears; held: ${reason.replace(/[()]/g, '\\$&')}`));
  assert.doesNotMatch(v.agents.find(a => a.name === 'claude').idleReason.text, /reviews only/);
  const queued = v.queues.claude.find(q => q.type === 'review' && q.ref === 10);
  assert.ok(queued.reason.includes(reason), queued.reason);
  assert.doesNotMatch(queued.reason, /reviews only|weekly 93%/);
  assert.equal(v.hostPressure.hold, true);
  assert.equal(v.hostPressure.measures.find(m => m.id === 'swap-activity').limit, 200);
  assert.equal(v.hostPressure.measures.find(m => m.id === 'swap-activity').value, 500);
  assert.equal(v.hostPressure.measures.find(m => m.id === 'memory').limit, 1024);

  const tools = createTools({ source: { get: async () => ({ view: v, ageMs: 0, stale: false }) }, readHost: () => ({}) });
  const protocol = createProtocol({ tools });
  const run = async (name, args = {}) => JSON.parse((await protocol.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }))).result.content[0].text);
  const status = await run('foreman_status');
  assert.equal(status.planned.find(p => p.type === 'review').why, reason);
  assert.match(status.agents.find(a => a.name === 'claude').idle, /held: host pressure: swap activity is 500/);
  assert.equal(status.hostPressure.hold, true);
  assert.equal(status.hostPressure.thresholds.swap_pages_per_second, 200);
  const plan = await run('foreman_plan');
  assert.equal(plan.plannedActions.find(p => p.type === 'review').heldBy, reason);
  const why = await run('foreman_why_blocked', { kind: 'pr', number: 10 });
  assert.ok(JSON.stringify(why).includes(reason), 'why_blocked names the host reason');
  assert.doesNotMatch(JSON.stringify(why.queue ?? why.queues ?? ''), /reviews only/);

  const html = renderRoute(v, { page: 'health', data: { now: w.clock.now(), warn: 85, alert: 95, disk: { status: 'none' }, recorder: { status: 'missing', samples: 0, hourly: [], days: [] }, hostPressure: v.hostPressure } }, { pathname: '/health' }).html;
  assert.match(html, /Host pressure hold/);
  assert.match(html, /data-pressure-measure="swap-activity" data-tripped="true"/);
  assert.match(html, /limit 200 pages\/s/);
});

test('low available memory holds the same way; recovery resumes starts', async t => {
  const w = world(t, { ...calm(), memory: { availableMb: 500, swapPercent: 10 } });
  const r = await w.team.tick();
  assert.match(r.held.reason, /^host pressure: available memory is 500 MB \(floor 1024 MB\)$/);
  assert.equal(w.calls.created.length, 0);
  w.host.memory = { availableMb: 4000, swapPercent: 10 };
  w.clock.t += MIN;
  const r2 = await w.team.tick();
  assert.equal(r2.held, undefined);
  assert.ok(w.calls.created.length > 0, 'a job started once memory recovered');
  assert.equal(w.team.s.hostPressure.hold, false);
});

test('a stale pressure record is not trusted by the views; the view shows thresholds without a record', () => {
  const rec = { at: NOW - 3600000, hold: true, reason: 'host pressure: x', measures: [], warnings: [] };
  assert.equal(hostPressureView({ hostPressure: rec }, {}, NOW).hold, false);
  assert.equal(hostPressureView({ hostPressure: { ...rec, at: NOW - MIN } }, {}, NOW).hold, true);
  assert.deepEqual(hostPressureView({}, { host_pressure: { min_available_mb: 2000 } }, NOW).thresholds.min_available_mb, 2000);
});
