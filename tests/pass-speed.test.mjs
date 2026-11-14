// Issue #985: a pass is short (no chain wait by default), records where its time went, shows it with the wake state, and a new inbox
// proposal is validated while a pass runs. Fake GitHub and jobs: no model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { recordTick, readCache } from '../supervisor/dashdata.mjs';
import { wakePassLock, scanInboxNow, wakeView, requestWake, dirLock } from '../supervisor/wake.mjs';
import { scan, statusOf } from '../supervisor/inbox.mjs';
import { lastPassOf } from '../supervisor/diagnostics.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pass985-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n';
const manifest = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: ['big', 'mid'], efforts: ['low', 'medium', 'high'] } };

test('the shipped team configuration does not hold a pass open to wait for a job to end', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.equal(shipped.limits.chain_seconds, 0);   // job ends wake a pass (#406); a 240 s wait held the pass lock and the tick lock
});

test('a pass records the time of each phase, including github reads and plan', async t => {
  const dir = tmp(t), root = stateRoot(path.join(dir, 'state'));
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } }, codex: { implement: { model: 'big', effort: 'high' }, review: { model: 'mid', effort: 'medium' } } } },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const gh = { listPulls: async () => [], getPull: async () => null, listIssues: async () => [], listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'x' }) };
  const team = new Team({ config: cfg, root, gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => Date.now() }, sleep: async () => {}, limitedOf: () => ({ out: false }), providerModels: manifest });
  const report = await team.tick();
  assert.ok(report.phases && Number.isFinite(report.phases.total));
  for (const k of ['github reads', 'plan']) assert.ok(Number.isFinite(report.phases[k]), `phase ${k} recorded`);
  assert.equal(report.chained, undefined);   // no chain wait
});

test('the tick record keeps pass duration and phases; hostile phase names and values are dropped', t => {
  const root = stateRoot(path.join(tmp(t), 'state'));
  recordTick(root, { now: 5000, status: 'ok', jobs: [], durationMs: 41234.6, phases: { plan: 1200.4, 'github reads': 30000, 'bad<name>': 5, neg: -1, nan: NaN } });
  const tick = readCache(root).tick;
  assert.equal(tick.durationMs, 41235);
  assert.deepEqual(tick.phases, { plan: 1200, 'github reads': 30000 });
  recordTick(root, { now: 6000, status: 'ok', jobs: [] });   // an older caller sends nothing: no fields, no failure
  assert.equal(readCache(root).tick.durationMs, undefined);
  assert.deepEqual(lastPassOf([{ at: 1, durationMs: 90000, phases: { plan: 1000, total: 90000, 'github reads': 60000 }, trigger: 'inbox' }]), { at: 1, trigger: 'inbox', seconds: 90, phases: [['github reads', 60], ['plan', 1]] });
  assert.equal(lastPassOf([{ at: 1 }]), null);
});

test('wakeView shows the cap use, the waiting reasons with their age and how long the pass has run', t => {
  const root = stateRoot(path.join(tmp(t), 'state')), now = Date.now();
  assert.equal(wakeView(root, now).pending, null);
  requestWake({ root, reason: 'approve', now: now - 20000, spawnPass: () => {} });
  requestWake({ root, reason: 'job-end', now: now - 5000, spawnPass: () => {} });
  const release = wakePassLock(root, now - 7000);
  t.after(() => release?.());
  const v = wakeView(root, now);
  assert.equal(v.acceptedLastHour, 0, 'an approve is never counted and the job end merged'); assert.equal(v.mergedLastHour, 1); assert.equal(v.cap, 40);
  assert.deepEqual(v.pending.reasons, ['approve', 'job-end']);
  assert.equal(v.pending.ageSeconds, 20);
  assert.equal(v.passRunningSeconds, 7);
});

test('a new proposal becomes pending while a pass holds the pass lock', t => {
  const dir = tmp(t), root = stateRoot(path.join(dir, 'state')), inbox = path.join(dir, 'inbox');
  fs.mkdirSync(path.join(inbox, 'items'), { recursive: true });
  const id = 'a'.repeat(32);
  fs.writeFileSync(path.join(inbox, 'items', `${id}.json`), JSON.stringify({ kind: 'prompt', title: 'Change a setting', prompt: 'Edit the config file as described.', why: 'test' }));
  const release = wakePassLock(root);   // a pass is running
  t.after(() => release?.());
  const out = scanInboxNow({ root, inboxDir: inbox, scan, maxPending: 30 });
  assert.equal(out.scanned, true);
  assert.equal(statusOf(inbox, id).state, 'pending');
});

test('negative: a scan that finds another scan running does nothing, and a refused item stays refused', t => {
  const dir = tmp(t), root = stateRoot(path.join(dir, 'state')), inbox = path.join(dir, 'inbox');
  fs.mkdirSync(path.join(inbox, 'items'), { recursive: true });
  const id = 'b'.repeat(32);
  fs.writeFileSync(path.join(inbox, 'items', `${id}.json`), '{not json');
  const other = dirLock(root, 'inbox-scan.lock');
  assert.deepEqual(scanInboxNow({ root, inboxDir: inbox, scan, maxPending: 30 }), { scanned: false });
  assert.equal(statusOf(inbox, id), null);
  other();
  assert.equal(scanInboxNow({ root, inboxDir: inbox, scan, maxPending: 30 }).scanned, true);
  assert.equal(statusOf(inbox, id).state, 'refused');
});

test('foreman_status carries the last pass timing and the wake state', async () => {
  const view = { health: 'ok', tick: { at: 1, durationMs: 41200, phases: { plan: 1500, 'github reads': 30000 } }, wakes: { cap: 40, acceptedLastHour: 3, pending: null }, slots: [], agents: [], jobs: [], plan: [] };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 1000 }) }, readHost: async () => ({}) });
  const res = await tools.call('foreman_status', {});
  const body = JSON.parse(res.text);
  assert.equal(body.lastPass.durationSeconds, 41.2);
  assert.equal(body.lastPass.phasesSeconds['github reads'], 30);
  assert.equal(body.wakes.acceptedLastHour, 3);
});

// ---- the fast lane for an approved prompt (issue #985)
import { decide } from '../supervisor/inbox.mjs';
import { cleanPhases, addPassPhases } from '../supervisor/dashdata.mjs';
import { laneArgs, spawnDetachedLane } from '../supervisor/wake.mjs';

function laneWorld(t, { active = [], limits = {}, pulls = [], register = REGISTER } = {}) {
  const dir = tmp(t), inbox = path.join(dir, 'inbox'), root = stateRoot(path.join(dir, 'state'));
  fs.mkdirSync(path.join(inbox, 'items'), { recursive: true });
  const id = 'c'.repeat(32);
  fs.writeFileSync(path.join(inbox, 'items', `${id}.json`), JSON.stringify({ kind: 'prompt', title: 'Change a setting', prompt: 'Edit the config file as described.', why: 'test' }));
  scan(inbox, 1000); assert.equal(decide(inbox, id, 'approve', 2000).ok, true);
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inbox },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...limits }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const created = [];
  const gh = { listPulls: async () => pulls, getPull: async () => null, listIssues: async () => [], listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { listActive: async () => active, get: async () => null, create: async spec => { created.push(spec); return { id: 'f'.repeat(32) }; } };
  const mk = () => new Team({ config: cfg, root, gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register, clock: { now: () => 5000 }, sleep: async () => {}, limitedOf: () => ({ out: false }),
    providerModels: { claude: { aliases: ['opus', 'sonnet', 'haiku'], pattern: '^claude-', efforts: ['low', 'medium', 'high'] } } });
  return { inbox, root, id, created, mk, jobs, cfg, gh };
}

// The PR #1126 fixture: 1M capacity, two open claude PRs, 100k review and fix medians. Inside the last day of the window only the planner and
// this lane enforce the reserve; earlier the high-water rule makes the agent reviews only instead.
async function reserveLane(t, hoursToReset) {
  const NOW = 5000, RESET = NOW + hoursToReset * 3600000;
  const done = (kind, i) => ({ id: String(i).repeat(32), provider: 'claude', kind, status: 'completed', createdAt: NOW - i * 1000, usage: { inputTokens: 100000, outputTokens: 0 } });
  const window = { type: 'seven_day', windowMinutes: 10080, utilization: 0.8, resetsAt: RESET, status: 'allowed' };
  const allowance = { claude: { provider: 'claude', status: 'allowed', observedAt: NOW, billing: {}, windows: [window] } };
  const pr = n => ({ number: n, title: 't', headRefName: `claude/issue-${n}-x`, headRefOid: String(n).repeat(40), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [] });
  const w = laneWorld(t, { pulls: [pr(1), pr(2)] });
  const team = new Team({ config: { ...w.cfg, budget: { starting_capacity: { claude: 1e6 } } }, root: w.root, gh: w.gh, jobs: w.jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null },
    register: REGISTER, clock: { now: () => NOW }, sleep: async () => {}, limitedOf: () => ({ out: false }), usage: { allowance, jobs: [done('review', 1), done('fix', 2)], snapshots: [] } });
  return { out: await team.startApprovedNow({}), created: w.created };
}

test('the fast lane judges the allowance reserve with the open pull requests counted (#1116, #1348)', async t => {
  const { out, created } = await reserveLane(t, 10);
  assert.equal(out.started, false, 'two open PRs reserve 250k of 1M (a fix round each plus the margin); 200k is left, so no implement starts');
  assert.match(out.why, /^allowance: remaining capacity is at or below the reserve/);
  assert.equal(created.length, 0);
});

test('negative: a reviews only refusal is shown with the allowance prefix and the word reserve is not added (#1348)', async t => {
  const { out, created } = await reserveLane(t, 72);
  assert.equal(out.started, false);
  assert.match(out.why, /^allowance: reviews only: /);
  assert.doesNotMatch(out.why, /^allowance reserve/);
  assert.equal(created.length, 0);
});

test('an approved prompt starts in the fast lane while a pass holds its locks, without touching the team state', async t => {
  const w = laneWorld(t);
  const passLock = wakePassLock(w.root); t.after(() => passLock?.());   // a pass is running
  const out = await w.mk().startApprovedNow({});
  assert.equal(out.started, true); assert.equal(w.created.length, 1);
  assert.equal(statusOf(w.inbox, w.id).state, 'running');
  assert.equal(fs.existsSync(path.join(w.root, 'team', 'state.json')), false, 'the lane wrote no team state');
  assert.equal(w.mk().inboxNext(), null);
  // the next pass adopts the job record once, and never starts a second job
  const pass = w.mk(); await pass.processInbox({ ingested: [], notified: [], actions: [], skipped: [] });
  assert.equal(pass.s.jobs['f'.repeat(32)]?.inboxId, w.id);
  assert.equal(statusOf(w.inbox, w.id).adopt, null);
  await pass.processInbox({ ingested: [], notified: [], actions: [], skipped: [] });
  assert.equal(w.created.length, 1);
});

test('negative: the fast lane waits only for the host check; busy implementer slots and a full overall cap do not hold it (issue #971)', async t => {
  const busy = [{ id: 'a'.repeat(32), provider: 'claude', status: 'running' }];
  const w = laneWorld(t, { active: busy });
  assert.equal((await w.mk().startApprovedNow({})).started, true, 'implementer slot full: the inbox lane starts anyway');
  assert.equal(statusOf(w.inbox, w.id).state, 'running');
  const w2 = laneWorld(t, { active: busy, limits: { roles: { implementer: 3, reviewer: 1 }, overall: 1 } });
  assert.equal((await w2.mk().startApprovedNow({})).started, true, 'overall cap full: the inbox lane is outside it');
  const w3 = laneWorld(t);
  assert.deepEqual(await w3.mk().startApprovedNow({}, { admit: () => ({ ok: false, why: 'host load is high' }) }), { started: false, why: 'host load is high' });
  assert.equal(w3.created.length, 0);
});

test('negative: a second approved prompt waits while the first fast-lane job is live but not yet adopted (roles.inbox 1)', async t => {
  const w = laneWorld(t); const live = [];
  w.jobs.listActive = async () => live; w.jobs.get = async id => live.find(j => j.id === id) || null;
  w.jobs.create = async spec => { w.created.push(spec); const j = { id: String(w.created.length).repeat(32), provider: 'claude', status: 'running' }; live.push(j); return j; };
  assert.equal((await w.mk().startApprovedNow({})).started, true);
  const id2 = 'd'.repeat(32);
  fs.writeFileSync(path.join(w.inbox, 'items', `${id2}.json`), JSON.stringify({ kind: 'prompt', title: 'Another change', prompt: 'Edit another file as described.', why: 'test' }));
  scan(w.inbox, 3000); assert.equal(decide(w.inbox, id2, 'approve', 4000).ok, true);
  assert.deepEqual(await w.mk().startApprovedNow({}), { started: false, why: 'no free inbox slot' });
  assert.equal(w.created.length, 1);
});

test('negative: a lane and a pass racing for the same approval start one job', async t => {
  const w = laneWorld(t);
  const [a, b] = await Promise.all([w.mk().startApprovedNow({}), (async () => { const x = w.mk(); return x.runAction({ type: 'inbox', agent: 'claude', key: w.id, inboxId: w.id, title: 't' }, { skipped: [] }); })()]);
  assert.equal(w.created.length, 1);
  void a; void b;
});

test('the phase record keeps the total and fixed phases when many step names crowd the cap, and cleans hostile names', t => {
  const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`step ${String.fromCharCode(97 + (i % 26))}${'x'.repeat(i < 26 ? 0 : 1)}`, 10]));
  const kept = cleanPhases({ ...many, plan: 5, 'job launches': 7, total: 999 });
  assert.equal(Object.keys(kept).length, 20);
  assert.equal(kept.total, 999); assert.equal(kept.plan, 5); assert.equal(kept['job launches'], 7);
});

test('work after the record (installs, reports) adds its time to the tick and the newest snapshot', t => {
  const root = stateRoot(path.join(tmp(t), 'state'));
  recordTick(root, { now: 7000, status: 'ok', jobs: [], durationMs: 1000, phases: { plan: 400, total: 900 } });
  addPassPhases(root, { reports: 2500, installs: 500 });
  const tick = readCache(root).tick;
  assert.equal(tick.durationMs, 4000); assert.equal(tick.phases.reports, 2500); assert.equal(tick.phases.installs, 500); assert.equal(tick.phases.total, 3900);
  addPassPhases(root, { 'bad<name>': 5 });   // dropped: nothing changes
  assert.equal(readCache(root).tick.durationMs, 4000);
});

test('the lane command runs the installed code with the state root', () => {
  assert.deepEqual(laneArgs({ target: '/x/cli.mjs', root: '/s', registry: null }), ['/x/cli.mjs', 'team', 'start-approved', '--state-root', '/s']);
  let seen; spawnDetachedLane({ root: '/nonexistent-root', self: '/self/cli.mjs', spawnFn: (cmd, args, o) => { seen = { args, detached: o.detached }; return { unref() {}, on() {} }; } });
  assert.equal(seen.args[0], '/self/cli.mjs'); assert.equal(seen.detached, true);
});

test('negative: the fast lane keeps the D-020 gate that the pass enforces, and ignores the open-PR pause like the inbox lane', async t => {
  const w = laneWorld(t, { register: REGISTER.replace(/homeowner-approved/g, 'agent-proposal') });
  const out = await w.mk().startApprovedNow({});
  assert.equal(out.started, false); assert.match(out.why, /D-020 is not homeowner-approved/);
  assert.equal(w.created.length, 0); assert.equal(statusOf(w.inbox, w.id).state, 'approved');
  const pr = n => ({ number: n, headRefName: `claude/issue-${n}-x`, title: 't', state: 'OPEN', labels: [], isDraft: false });
  const w2 = laneWorld(t, { limits: { max_open_prs: 2 }, pulls: [pr(1), pr(2)] });
  const out2 = await w2.mk().startApprovedNow({});
  assert.equal(out2.started, true, 'the open-PR cap pauses implement work, not the inbox lane'); assert.equal(w2.created.length, 1);
});

test('the fast lane honours limits.roles.inbox: a prompt started during a pass fills the slot, a second waits, a raised count lets it start (issue #971)', async t => {
  const w = laneWorld(t);
  const run = { id: 'f'.repeat(32), provider: 'claude', status: 'running' };
  w.jobs.get = async id => (id === run.id ? run : null);
  assert.equal((await w.mk().startApprovedNow({})).started, true);   // job f..: held only in the item's status until a pass adopts it
  const id2 = 'd'.repeat(32);
  fs.writeFileSync(path.join(w.inbox, 'items', `${id2}.json`), JSON.stringify({ kind: 'prompt', title: 'Second', prompt: 'Another small edit.', why: 'test' }));
  scan(w.inbox, 3000); assert.equal(decide(w.inbox, id2, 'approve', 4000).ok, true);
  const second = await w.mk().startApprovedNow({});
  assert.deepEqual(second, { started: false, why: 'no free inbox slot' }); assert.equal(w.created.length, 1);
  assert.equal(statusOf(w.inbox, id2).state, 'approved');
});

test('the order guard holds implement picks for a prompt the fast lane started during a pass, before any pass adopted it (issue #971)', async t => {
  const w = laneWorld(t);
  assert.equal((await w.mk().startApprovedNow({})).started, true);
  assert.match(w.mk().orderGuard() || '', /running inbox prompt/, 'the unadopted fast-path job holds');
  const pass = w.mk(); await pass.processInbox({ ingested: [], notified: [], actions: [], skipped: [] });
  assert.match(pass.orderGuard() || '', /running inbox prompt/, 'after adoption it still holds');
});

test('a pass reads the open PR and issue lists once; a write, or the end of the window, reads GitHub again', async () => {
  const { cachedGithub } = await import('../supervisor/ghchange.mjs');
  let pulls = 0, writes = 0;
  const raw = { listPulls: async () => { pulls++; return [{ number: pulls }]; }, listIssues: async () => [], comment: async () => { writes++; } };
  const w = cachedGithub(raw, { mode: 'memo', cache: null });
  await w.gh.listPulls(); await w.gh.listPulls(); await w.gh.listPulls();
  assert.equal(pulls, 1); assert.equal(w.stats.recentHits, 2);
  await w.gh.comment(1, 'x');
  assert.deepEqual(await w.gh.listPulls(), [{ number: 2 }]);   // a write forces a fresh read
  w.endReplay(); await w.gh.listPulls(); assert.equal(pulls, 3);
});

test('negative: the fast lane keeps the circuit breaker halt that the pass enforces', async t => {
  const w = laneWorld(t);
  const team = w.mk();
  team.s.breaker.global = { since: 1, trippedBy: 'cost', cost: 99, causes: ['x'] };
  const out = await team.startApprovedNow({});
  assert.equal(out.started, false); assert.match(out.why, /circuit breaker/);
  assert.equal(w.created.length, 0); assert.equal(statusOf(w.inbox, w.id).state, 'approved');
});
