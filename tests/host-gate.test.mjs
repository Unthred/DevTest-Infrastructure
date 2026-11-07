// Issue #972: hold new starts while Tower is overloaded. Starts only; running jobs are never touched. Hysteresis so it does not flap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { normalizeHostGate, stepGate, stepLevel, hostRefusal, readHostFigures, hostView, DEFAULT_HOST_GATE } from '../supervisor/hostgate.mjs';
import { readHost, containerMemory, topProcesses } from '../foreman-mcp/source.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const CFG = normalizeHostGate(undefined);
const fig = (o = {}) => ({ cores: 20, swapPercent: 10, memoryAvailableMb: 20000, loadPerCore: 0.5, swapUsedMb: 1600, swapTotalMb: 16000, memoryTotalMb: 32000, ...o });

test('quiet host: nothing is held at either level', () => {
  const g = stepGate(undefined, fig(), CFG, 1000);
  assert.equal(g.start.held, false); assert.equal(g.hard.held, false);
  assert.equal(hostRefusal(g, 'implement'), null); assert.equal(hostRefusal(g, 'review'), null);
});

test('swap above 85% holds implement with the reason, but not reviews, fixes or inbox (one level above)', () => {
  const g = stepGate(undefined, fig({ swapPercent: 94.5 }), CFG, 1000);
  assert.equal(hostRefusal(g, 'implement'), 'held: swap 95% ≥ 85%');
  for (const t of ['review', 'fix', 'cifix', 'rebase', 'inbox']) assert.equal(hostRefusal(g, t), null, t);
  assert.equal(hostRefusal(g, 'merge'), null);
});

test('past the hard threshold everything that starts is held, including reviews and inbox', () => {
  const g = stepGate(undefined, fig({ swapPercent: 97 }), CFG, 1000);
  for (const t of ['implement', 'continue', 'review', 'fix', 'cifix', 'rebase', 'inbox']) assert.match(hostRefusal(g, t), /swap 97% ≥ 95%/, t);
});

test('each figure holds on its own: low memory and high load per core', () => {
  assert.match(hostRefusal(stepGate(undefined, fig({ memoryAvailableMb: 3000 }), CFG, 1), 'implement'), /memory 2\.9 GB available < 4 GB/);
  assert.match(hostRefusal(stepGate(undefined, fig({ loadPerCore: 1.9 }), CFG, 1), 'implement'), /load 1\.9\/core > 1\.5/);
  assert.equal(hostRefusal(stepGate(undefined, fig({ loadPerCore: 1.5 }), CFG, 1), 'implement'), null);   // exactly at the limit is not over it
});

test('hysteresis: stays held between the hold and resume thresholds, releases below resume, and records when it began', () => {
  let g = stepGate(undefined, fig({ swapPercent: 90 }), CFG, 1000);
  assert.equal(g.start.held, true); assert.equal(g.start.since, 1000);
  g = stepGate(g, fig({ swapPercent: 80 }), CFG, 2000);   // below 85 but not below the 75 resume threshold
  assert.equal(g.start.held, true); assert.equal(g.start.since, 1000); assert.match(g.start.reason, /swap 80%, resumes below 75%/);
  g = stepGate(g, fig({ swapPercent: 74 }), CFG, 3000);
  assert.equal(g.start.held, false); assert.equal(g.start.since, null);
  g = stepGate(g, fig({ swapPercent: 80 }), CFG, 4000);   // not held, and 80 is below the hold threshold: does not flap back on
  assert.equal(g.start.held, false);
});

test('an unreadable figure never holds anything, and a disabled gate never holds', () => {
  assert.equal(stepGate(undefined, { cores: null, swapPercent: null, memoryAvailableMb: null, loadPerCore: null }, CFG, 1).start.held, false);
  const off = stepGate(undefined, fig({ swapPercent: 99 }), { ...CFG, enabled: false }, 1);
  assert.equal(hostRefusal(off, 'implement'), null);
});

test('configuration is validated: unknown keys, bad numbers and thresholds that could never release', () => {
  assert.throws(() => normalizeHostGate({ colour: 1 }), /unknown key/);
  assert.throws(() => normalizeHostGate({ hold: { swap_percent: 120 } }), /at most 100/);
  assert.throws(() => normalizeHostGate({ hold: { swap_percent: -1 } }), /positive number/);
  assert.throws(() => normalizeHostGate({ resume: { swap_percent: 90 } }), /resume.swap_percent must not be above/);
  assert.throws(() => normalizeHostGate({ resume: { memory_available_mb: 1000 } }), /resume.memory_available_mb must not be below/);
  assert.throws(() => normalizeHostGate({ hard_hold: { swap_percent: 80 }, hard_resume: { swap_percent: 70 } }), /hard_hold must be no stricter/);
  assert.throws(() => normalizeHostGate('yes'), /must be an object/);
  assert.deepEqual(normalizeHostGate({ hold: { swap_percent: 80 }, resume: { swap_percent: 70 } }).hold, { ...DEFAULT_HOST_GATE.hold, swap_percent: 80 });
});

test('readHostFigures reads cores, load per core, memory and swap from /proc files', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'loadavg'), '30.0 20.0 10.0 1/2 3\n');
  fs.writeFileSync(path.join(dir, 'meminfo'), 'MemTotal: 32000000 kB\nMemAvailable: 5000000 kB\nSwapTotal: 16000000 kB\nSwapFree: 1000000 kB\n');
  fs.writeFileSync(path.join(dir, 'cpuinfo'), 'processor\t: 0\nprocessor\t: 1\nprocessor\t: 2\nprocessor\t: 3\nprocessor\t: 4\n');
  const f = readHostFigures({ proc: dir });
  assert.equal(f.cores, 5); assert.equal(f.loadPerCore, 4); assert.equal(f.swapPercent, 93.8); assert.equal(f.memoryAvailableMb, 4883);
});

// ---- the planner ----
const H = n => String(n).repeat(40).slice(0, 40);
const cfg = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const pull = { number: 50, title: 't', headRefName: 'codex/issue-2-a', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green, reviewDecision: '', labels: [], closingIssuesReferences: [] };
function world(t, { hostSample, pulls = [], issues = [], active = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hostgate-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => issues, listMergedPulls: async () => [] };
  const stops = [];
  const jobs = { listActive: async () => active, get: async () => null, stop: async id => stops.push(id) };
  let now = 1000;
  const team = new Team({ config: cfg(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { worktreeFor: async () => null }, register: '', clock: { now: () => now }, hostSample });
  return { team, stops, setNow: n => { now = n; } };
}
const issue23 = { number: 23, title: 'Do the thing here', state: 'OPEN', body: '', labels: [] };

test('planner: with swap over the threshold no implement job starts and the held reason names swap; below resume it starts again', async t => {
  let swapPercent = 94;
  const w = world(t, { hostSample: () => fig({ swapPercent }), issues: [issue23] });
  let plan = await w.team.plan();
  assert.equal(plan.filter(a => a.type === 'implement').length, 0);
  assert.match(w.team.held.claude.implement, /held: swap 94% ≥ 85%/);
  swapPercent = 80; w.setNow(61000);
  plan = await w.team.plan();
  assert.equal(plan.filter(a => a.type === 'implement').length, 0, 'between hold and resume the hold stays');
  assert.match(w.team.held.claude.implement, /resumes below 75%/);
  swapPercent = 60; w.setNow(121000);
  plan = await w.team.plan();
  assert.equal(plan.filter(a => a.type === 'implement').length, 1);
  assert.equal(w.team.s.hostGate.start.held, false);
});

test('planner: a review is still planned while only the start level is held, and not past the hard level', async t => {
  let swapPercent = 90;
  const w = world(t, { hostSample: () => fig({ swapPercent }), pulls: [pull] });
  assert.equal((await w.team.plan()).filter(a => a.type === 'review').length, 1);
  swapPercent = 97; w.setNow(2000);
  assert.equal((await w.team.plan()).filter(a => a.type === 'review').length, 0);
  assert.match(w.team.held.claude.review, /swap 97% ≥ 95%/);
});

test('planner: a running job is never stopped for host load', async t => {
  const w = world(t, { hostSample: () => fig({ swapPercent: 99, loadPerCore: 4 }), issues: [issue23], active: [{ id: 'abc', provider: 'claude', status: 'running' }] });
  await w.team.plan();
  assert.deepEqual(w.stops, []);
  assert.equal(w.team.s.hostGate.hard.held, true);
});

test('planner: no host sampler (tests, dry runs elsewhere) means no host hold; a throwing sampler keeps the last latch', async t => {
  const w = world(t, { hostSample: null, issues: [issue23] });
  assert.equal((await w.team.plan()).filter(a => a.type === 'implement').length, 1);
  let calls = 0;
  const w2 = world(t, { hostSample: () => { if (calls++) throw new Error('proc unreadable'); return fig({ swapPercent: 96 }); }, issues: [issue23] });
  await w2.team.plan(); await w2.team.plan();
  assert.equal(w2.team.s.hostGate.start.held, true);
});

test('config: host_gate is validated with the team config and a local override merges over the shipped thresholds', () => {
  const base = cfg();
  assert.throws(() => validateTeamConfig({ ...base, host_gate: { hold: { swap_percent: 'x' } } }), /host_gate/);
  assert.equal(validateTeamConfig({ ...base, host_gate: { hold: { swap_percent: 70 }, resume: { swap_percent: 60 } } }).host_gate.hold.swap_percent, 70);
});

test('dashboard view: figures carry status colours and the time held', () => {
  const g = stepGate(undefined, fig({ swapPercent: 94.5, loadPerCore: 1.0 }), CFG, 1000);
  const v = hostView(g, CFG, 1000 + 12 * 60000);
  assert.equal(v.figures.find(f => f.key === 'swap').sev, 'warning');   // past the start threshold, below the hard one
  assert.equal(v.figures.find(f => f.key === 'load').sev, 'ok');
  assert.equal(v.start.heldMs, 12 * 60000); assert.match(v.start.reason, /swap/); assert.equal(v.hard.held, false);
  assert.equal(hostView(undefined, CFG, 1), null);
  assert.equal(hostView(stepGate(undefined, fig({ swapPercent: 97 }), CFG, 1), CFG, 2).figures[0].sev, 'action');
});

// ---- MCP ----
test('foreman_host returns the core count, per-container memory and the swap holders', async () => {
  const files = { '/p/loadavg': '1 2 3 1/1 1', '/p/meminfo': 'MemTotal: 1024 kB\n', '/p/cpuinfo': 'processor: 0\nprocessor: 1\n' };
  const host = readHost({ proc: '/p', fsRead: f => { if (f in files) return files[f]; throw new Error('ENOENT'); } });
  assert.equal(host.cores, 2);
  const id = 'a'.repeat(64), id2 = 'b'.repeat(64);
  const cg = { [`/cg/docker/${id}/memory.current`]: String(300 * 1048576), [`/cg/docker/${id}/memory.swap.current`]: String(900 * 1048576), [`/cg/docker/${id}/cgroup.procs`]: '77\n', '/fakeproc/77/comm': 'emby\n',
    [`/cg/docker/${id2}/memory.current`]: String(500 * 1048576), [`/cg/docker/${id2}/memory.swap.current`]: '0\n' };
  const c = containerMemory({ cgroupRoot: '/cg', proc: '/fakeproc', readDir: () => [id, id2, 'not-a-container'], fsRead: f => { if (f in cg) return cg[f]; throw new Error('ENOENT'); } });
  assert.deepEqual(c.top.map(r => [r.container, r.memoryMb, r.swapMb, r.mainProcess]), [['aaaaaaaaaaaa', 300, 900, 'emby'], ['bbbbbbbbbbbb', 500, 0, null]]);
  assert.equal(containerMemory({ cgroupRoot: '/cg', readDir: () => { throw new Error('ENOENT'); } }), null);
  const tools = createTools({ source: {}, readHost: () => host, readActivity: async () => ({}), readContainers: () => c, now: () => 0 });
  const res = await tools.call('foreman_host'); assert.equal(res.isError, false); const out = JSON.parse(res.text);
  assert.equal(out.cores, 2); assert.equal(out.containers.count, 2);
});

test('swap holders: processes sorted by swap with their container, from /proc only', () => {
  const cid = 'c'.repeat(64);
  const files = { '/pr/1/status': 'Name:\tbig\nVmRSS:\t2048 kB\nVmSwap:\t102400 kB\n', '/pr/2/status': 'Name:\tsmall\nVmRSS:\t4096 kB\nVmSwap:\t1024 kB\n', '/pr/3/status': 'Name:\tnone\nVmRSS:\t1024 kB\nVmSwap:\t0 kB\n', '/pr/1/cgroup': `0::/docker/${cid}\n` };
  const r = topProcesses({ proc: '/pr', readDir: () => ['1', '2', '3'], fsRead: f => { if (f in files) return files[f]; throw new Error('ENOENT'); } });
  assert.deepEqual(r.topSwapHolders.map(h => [h.name, h.swapMb, h.container]), [['big', 100, 'cccccccccccc'], ['small', 1, null]]);
});
