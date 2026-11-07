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
  assert.equal(v.acceptedLastHour, 2); assert.equal(v.cap, 40);
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

function laneWorld(t, { active = [], limits = {} } = {}) {
  const dir = tmp(t), inbox = path.join(dir, 'inbox'), root = stateRoot(path.join(dir, 'state'));
  fs.mkdirSync(path.join(inbox, 'items'), { recursive: true });
  const id = 'c'.repeat(32);
  fs.writeFileSync(path.join(inbox, 'items', `${id}.json`), JSON.stringify({ kind: 'prompt', title: 'Change a setting', prompt: 'Edit the config file as described.', why: 'test' }));
  scan(inbox, 1000); assert.equal(decide(inbox, id, 'approve', 2000).ok, true);
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inbox },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...limits }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const created = [];
  const gh = { listPulls: async () => [], getPull: async () => null, listIssues: async () => [], listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {} };
  const jobs = { listActive: async () => active, get: async () => null, create: async spec => { created.push(spec); return { id: 'f'.repeat(32) }; } };
  const mk = () => new Team({ config: cfg, root, gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 5000 }, sleep: async () => {}, limitedOf: () => ({ out: false }),
    providerModels: { claude: { aliases: ['opus', 'sonnet', 'haiku'], pattern: '^claude-', efforts: ['low', 'medium', 'high'] } } });
  return { inbox, root, id, created, mk };
}

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

test('negative: the fast lane starts nothing with the implementer slot or the overall cap full, or the host check refusing', async t => {
  const busy = [{ id: 'a'.repeat(32), provider: 'claude', status: 'running' }];
  const w = laneWorld(t, { active: busy });
  assert.deepEqual(await w.mk().startApprovedNow({}), { started: false, why: 'no free implementer slot' });
  assert.equal(statusOf(w.inbox, w.id).state, 'approved');
  const w2 = laneWorld(t, { active: busy, limits: { roles: { implementer: 3, reviewer: 1 }, overall: 1 } });
  assert.match((await w2.mk().startApprovedNow({})).why, /overall cap/);
  const w3 = laneWorld(t);
  assert.deepEqual(await w3.mk().startApprovedNow({}, { admit: () => ({ ok: false, why: 'host load is high' }) }), { started: false, why: 'host load is high' });
  assert.equal(w3.created.length, 0);
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
