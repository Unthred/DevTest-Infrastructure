// Issue #338: a finished job's slot is refilled within the same tick (bounded chained passes), through every existing gate.
// Fake GitHub, fake jobs, fake clock and sleep: no model call, no network, no real repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig, tickLock } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n';
const issue = n => ({ number: n, title: `Issue ${n} title here`, state: 'OPEN', body: '', labels: [] });
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const pr = (n, branch, head) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green });
const manifest = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: ['big', 'mid'], efforts: ['low', 'medium', 'high'] } };
const config = (limits = {}, extra = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, chain_seconds: 240, chain_passes: 3, ...limits },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } }, codex: { implement: { model: 'big', effort: 'high' }, review: { model: 'mid', effort: 'medium' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5, 6, 7] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...extra });

// A world whose clock only moves when the tick sleeps; endAt maps a job id to the second at which it finishes.
function world(t, { cfg = config(), pulls = [], issues = [issue(5), issue(6), issue(7)], endAt = {}, out = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chain-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = { now: 1_800_000_000_000, started: [], created: [], listPulls: 0, sleeps: [] };
  const states = {};
  const gh = { listPulls: async () => { w.listPulls++; return pulls; }, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => issues, listMergedPulls: async () => [],
    comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { active: [], seq: 0, listActive: async () => jobs.active.filter(j => states[j.id].status === 'running'), get: async id => states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); w.created.push({ spec, at: w.now }); states[id] = { id, status: 'running', provider: spec.provider }; jobs.active.push({ id }); return { id }; } };
  const clock = { now: () => w.now };
  const sleep = async ms => { w.sleeps.push(ms); w.now += ms; for (const [id, sec] of Object.entries(endAt)) if (states[id] && states[id].status === 'running' && w.now - w.t0 >= sec * 1000) states[id].status = 'completed'; };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock, sleep,
    limitedOf: a => (out[a] ? { out: true, reason: 'limit' } : { out: false }), providerModels: manifest });
  w.passes = 0; const tp = team.tickPass.bind(team); team.tickPass = async o => { w.passes++; return tp(o); };
  w.t0 = w.now; w.team = team; w.states = states; w.jobs = jobs; w.root = stateRoot(path.join(dir, 'state')); w.gh = gh;
  // A job started by an earlier tick and still running.
  w.running = (id, kind, agent, extra = {}) => { states[id] = { id, status: 'running', provider: 'claude' }; jobs.active.push({ id }); team.s.jobs[id] = { kind, agent, key: String(extra.issue ?? extra.pr), ingested: false, ...extra }; };
  return w;
}
const startedIssues = w => w.created.map(c => c.spec.issue);

test('a finished implement job refills its slot within one minute, inside the same tick', async t => {
  const w = world(t, { endAt: { aaaa: 25 } });
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  w.gh.listIssues = async () => [{ ...issue(5), state: 'CLOSED' }, issue(6), issue(7)];
  const report = await w.team.tick();
  assert.deepEqual(startedIssues(w), [6]);
  assert.ok(w.created[0].at - w.t0 <= 60000, `started after ${(w.created[0].at - w.t0) / 1000}s`);
  assert.equal(report.chained.length, 1);
  assert.equal(report.actions.length, 1);   // the chained pass's action is in the tick report
});

test('negative: a tick with nothing running and nothing plannable does not loop or sleep', async t => {
  const w = world(t, { issues: [] });
  const report = await w.team.tick();
  assert.equal(w.passes, 1);
  assert.deepEqual(w.sleeps, []);
  assert.equal(report.chained, undefined);
});

test('negative: running jobs that never end stop at the window with no extra pass', async t => {
  const w = world(t, { cfg: config({ chain_seconds: 60 }) });
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  await w.team.tick();
  assert.equal(w.passes, 1);
  assert.equal(w.created.length, 0);
  assert.ok(w.sleeps.reduce((a, b) => a + b, 0) <= 60000);
});

test('the number of chained passes is bounded by chain_passes', async t => {
  const w = world(t, { cfg: config({ chain_passes: 1, roles: { implementer: 1, reviewer: 1 } }), endAt: { aaaa: 5, '00000000000000000000000000000001': 10 } });
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  w.gh.listIssues = async () => [{ ...issue(5), state: 'CLOSED' }, issue(6), issue(7)];
  await w.team.tick();
  assert.equal(w.created.length, 1);   // issue 6 started in the single chained pass; its end does not start issue 7 in this tick
  assert.equal(w.passes, 2);
});

test('chaining is off when chain_seconds is absent: an old config behaves exactly as before', async t => {
  const cfg = config(); delete cfg.limits.chain_seconds;
  const w = world(t, { cfg, endAt: { aaaa: 25 } });
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  await w.team.tick();
  assert.equal(w.passes, 1); assert.deepEqual(w.sleeps, []);
});

test('invalid chain limits are rejected', () => {
  for (const bad of [{ chain_seconds: -1 }, { chain_seconds: 'x' }, { chain_passes: 9 }, { chain_passes: 1.5 }, { chain_poll_seconds: 0 }])
    assert.throws(() => validateTeamConfig(config(bad)), /invalid team limit/);
  validateTeamConfig(config({ chain_seconds: 0, chain_passes: 0 }));
});

// ---- no gate bypass: each refusal still holds on the early (chained) path
test('gate: the tick lock stays held for the whole chained tick, so a second tick cannot start', async t => {
  const w = world(t, { endAt: { aaaa: 25 } });
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  const unlock = tickLock(w.root); assert.ok(unlock);
  const seen = []; const orig = w.team.sleep; w.team.sleep = async ms => { seen.push(tickLock(w.root)); await orig(ms); };
  await w.team.tick();
  assert.ok(seen.length > 0 && seen.every(x => x === null));
  unlock();
});

test('gate: a pending self-upgrade hold starts no job in a chained pass', async t => {
  const w = world(t, { endAt: { aaaa: 25 } });
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  w.gh.listIssues = async () => [{ ...issue(5), state: 'CLOSED' }, issue(6)];
  const report = await w.team.tick({ hold: { to: 'abc1234' } });
  assert.equal(w.created.length, 0);
  assert.ok(report.held);
});

test('gate: the role slot stays refused when another implementer job still holds it', async t => {
  const w = world(t, { cfg: config({ overall: 3 }), endAt: { rrrr: 25 } });
  w.running('bbbb', 'implement', 'claude', { issue: 5 });
  w.running('rrrr', 'review', 'claude', { pr: 90, head: 'a'.repeat(40) });
  await w.team.tick();
  assert.deepEqual(startedIssues(w).filter(Boolean), []);   // issue 6 must not start: the implementer slot is still taken
});

test('gate: the overall cap holds after a job ends while others still run', async t => {
  const w = world(t, { cfg: config({ roles: { implementer: 2, reviewer: 2 }, overall: 2 }), endAt: { aaaa: 25 } });
  w.running('aaaa', 'review', 'claude', { pr: 91, head: 'b'.repeat(40) });
  w.running('bbbb', 'implement', 'claude', { issue: 5 });
  w.running('cccc', 'implement', 'claude', { issue: 6 });   // three running with overall 2 is already over the cap
  await w.team.tick();
  assert.equal(w.created.length, 0);
});

test('gate: the open-PR cap refuses a chained implement start', async t => {
  const w = world(t, { cfg: config({ max_open_prs: 1 }), pulls: [pr(80, 'claude/issue-9-x', 'c'.repeat(40))], endAt: { aaaa: 25 } });
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  w.gh.listIssues = async () => [{ ...issue(5), state: 'CLOSED' }, issue(6)];
  await w.team.tick();
  assert.deepEqual(w.created.filter(c => c.spec.kind === 'implement'), []);
});

test('gate: an agent out of allowance starts nothing on the chained pass', async t => {
  const w = world(t, { endAt: { aaaa: 25 }, out: { claude: 'weekly limit' } });
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  w.gh.listIssues = async () => [{ ...issue(5), state: 'CLOSED' }, issue(6)];
  await w.team.tick();
  assert.equal(w.created.length, 0);
});

test('gate: review independence (D-024) still refuses the only agent reviewing its own pull request', async t => {
  const cfg = config(); cfg.models.agents.claude.review = { model: 'sonnet', effort: 'low' };   // same model as the writer
  const w = world(t, { cfg, pulls: [pr(77, 'claude/issue-72-x', 'd'.repeat(40))], endAt: { aaaa: 25 }, issues: [], out: { codex: 'limit' } });
  w.team.s.jobs.w0 = { kind: 'implement', agent: 'claude', key: '72', model: 'sonnet', branch: 'claude/issue-72-x', ingested: true, at: 1 };
  w.running('aaaa', 'implement', 'claude', { issue: 5 });
  await w.team.tick();
  assert.deepEqual(w.created.filter(c => c.spec.kind === 'review'), []);
});
