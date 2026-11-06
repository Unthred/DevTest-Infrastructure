// Issue #259: the read-only stalled-PR check and its Needs you items. Fake GitHub, fake jobs, fake clock; no network, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const HOUR = 3600000, NOW0 = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = (limits = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...limits },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `Exact title ${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], ...extra });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-024 — y\n- Status: homeowner-approved\n';

function world(t, { pulls, limits, active = [], stateDir } = {}) {
  const dir = stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'stall-')); if (!stateDir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW0, now: () => clock.t };
  const gh = { pulls, listPulls: async () => gh.pulls, listIssues: async () => [], listMergedPulls: async () => [], getPull: async () => null };
  const jobs = { active, listActive: async () => jobs.active, get: async () => null };
  const mk = () => new Team({ config: config(limits), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock });
  return { dir, clock, gh, jobs, mk, team: mk() };
}
const tick = async w => { const r = await w.team.tick(); return r; };
const view = (w, extra = {}) => buildView({ config: config(), root: w.dir, jobs: [], events: [], state: { ...w.team.s, ...extra }, register: REGISTER,
  cache: { tick: { at: w.clock.t - 60000, status: 'ok', error: null, lastOkAt: w.clock.t - 60000 }, pulls: w.gh.pulls, issues: [] }, snapshots: [], now: w.clock.t });
// A stall only asks the homeowner when a reason names them; every other stall is a notice (overseer job 211f3615).
const v0 = v => v.panels.needsYou.filter(a => /^stall/.test(a.id));
const stalled = v => [...v.panels.needsYou, ...v.panels.warnings].filter(a => /^stall/.test(a.id));

test('no progress past the limit raises one item with the required facts; just inside the limit raises none', async t => {
  const w = world(t, { pulls: [pr(7, 'claude/issue-1-a', H(1), { statusCheckRollup: [{ status: 'IN_PROGRESS' }] })] });
  await tick(w);                                   // first seen: the timer starts now
  w.clock.t += 3 * HOUR;                           // exactly at the limit: still inside
  await tick(w); assert.equal(stalled(await view(w)).length, 0);
  w.clock.t += 60000;
  const r = await tick(w); assert.deepEqual(r.stalled, [7]);
  const items = stalled(await view(w)); assert.equal(items.length, 1);
  const [it] = items;
  assert.match(it.text, /PR #7/); assert.match(it.text, /head 1111111/); assert.match(it.text, /no progress for 3h 1m/); assert.match(it.text, /last: first seen/);
  assert.match(it.tried, /CI has not finished/); assert.equal(it.severity, 'info', 'Foreman waits for CI itself: a notice, not Needs you'); assert.equal(v0(await view(w)).length, 0);
});

test('a running job holds off the item; a job that ends without a new head or verdict does not reset the timer', async t => {
  const w = world(t, { pulls: [pr(7, 'claude/issue-1-a', H(1))] });
  await tick(w);
  w.team.s.jobs.j1 = { kind: 'fix', agent: 'claude', pr: 7, at: w.clock.t + HOUR, ingested: true };
  w.jobs.active = [{ id: 'j1' }];
  w.clock.t += 4 * HOUR; await tick(w);
  assert.equal(stalled(await view(w)).length, 0, 'running job: nothing raised');
  w.jobs.active = [];                                // the job failed; the head is unchanged
  w.clock.t += 5 * 60000; await tick(w);
  const items = stalled(await view(w)); assert.equal(items.length, 1, 'timer was not reset by the job');
  assert.match(items[0].text, /then a fix job ended without a new head or review verdict/);
});

test('a new head or a review verdict resets the timer and clears the item', async t => {
  const w = world(t, { pulls: [pr(7, 'claude/issue-1-a', H(1)), pr(8, 'claude/issue-2-b', H(2))] });
  await tick(w); w.clock.t += 4 * HOUR; await tick(w);
  assert.equal(stalled(await view(w)).length, 2);   // one item per PR
  w.gh.pulls = [pr(7, 'claude/issue-1-a', H(3)), pr(8, 'claude/issue-2-b', H(2))];
  w.team.s.verdicts[`8:${H(2)}`] = { verdict: 'CHANGES', reviewer: 'codex', at: w.clock.t, head: H(2), pr: 8, findings: [] };
  await tick(w); const v = await view(w);
  assert.equal(stalled(v).length, 0);
  assert.match(w.team.s.progress[7].last, /new head 3333333/); assert.match(w.team.s.progress[8].last, /review verdict CHANGES/);
});

test('the timer survives a restart', async t => {
  const w = world(t, { pulls: [pr(7, 'claude/issue-1-a', H(1))] });
  await tick(w);
  w.clock.t += 4 * HOUR;
  const again = w.mk(); w.team = again;              // a new Team reads state.json
  assert.equal(again.s.progress[7].at, NOW0);
  await tick(w); assert.equal(stalled(await view(w)).length, 1);
});

test('a homeowner/* PR gets the waiting-for-you wording', async t => {
  const w = world(t, { pulls: [pr(9, 'homeowner/fix', H(4))] });
  await tick(w); w.clock.t += 4 * HOUR; await tick(w);
  const [it] = stalled(await view(w));
  assert.match(it.tried, /waiting for the homeowner to merge or decide/); assert.match(it.decision, /Merge it, or decide/);
});

test('PRs with the same reasons share one item; different reasons get another; a PR with its own item gets none', async t => {
  const red = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
  const w = world(t, { pulls: [pr(1, 'homeowner/a', H(1)), pr(2, 'homeowner/b', H(2)), pr(3, 'claude/issue-3-c', H(3), { labels: ['needs-homeowner'] }), pr(4, 'claude/issue-4-d', H(4), { statusCheckRollup: red })] });
  await tick(w); w.clock.t += 4 * HOUR; await tick(w);
  const v = await view(w);
  const own = v.panels.needsYou.filter(a => a.ref?.n === 3 && !/^stall/.test(a.id)); assert.equal(own.length, 1, 'PR 3 has its own homeowner item');
  const items = stalled(v);
  assert.ok(['stalled-1', 'stalled-2'].every(id => items.some(i => i.id === id && i.severity === 'action')), 'PRs 1 and 2 each have their own homeowner item');
  assert.ok(!items.some(i => /PR #3 /.test(i.text)), 'PR 3 gets no second item');
  assert.equal(items.length, 2); assert.ok(!items.some(i => /PR #4 /.test(i.text)), 'PR 4 already has its CI item');
});

test('a PR with no known reason says so plainly', async t => {
  const w = world(t, { pulls: [pr(7, 'claude/issue-1-a', H(1))] });
  w.team.stallReasons = () => [];
  await tick(w); w.clock.t += 4 * HOUR; await tick(w);
  const [it] = stalled(await view(w)); assert.match(it.tried, /knows no reason/); assert.match(it.tried, /bug/);
});

test('closed, merged or draft PRs drop out and clear the item', async t => {
  const w = world(t, { pulls: [pr(7, 'homeowner/a', H(1))] });
  await tick(w); w.clock.t += 4 * HOUR; await tick(w);
  assert.equal(stalled(await view(w)).length, 1);
  w.gh.pulls = []; await tick(w);
  assert.equal(stalled(await view(w)).length, 0); assert.deepEqual(w.team.s.progress, {});
});

test('the check is read-only: it dispatches and merges nothing', async t => {
  const w = world(t, { pulls: [pr(7, 'homeowner/a', H(1))] });
  await tick(w); w.clock.t += 4 * HOUR; const r = await tick(w);
  assert.deepEqual(r.actions, []);
});

test('a forced error leaves the tick running and is reported as its own item', async t => {
  const w = world(t, { pulls: [pr(7, 'homeowner/a', H(1))] });
  w.team.stallReasons = () => { throw new Error('boom in the check'); };
  await tick(w); w.clock.t += 4 * HOUR;
  const r = await tick(w);
  assert.ok(Array.isArray(r.actions)); assert.ok(r.skipped.some(s => s.what === 'stall check' && /boom/.test(s.reason)));
  const v = await view(w); const it = v.panels.needsYou.find(a => a.id === 'stall-check-error');
  assert.ok(it); assert.match(it.text, /boom in the check/);
});

test('stall_hours is configurable and validated', async t => {
  const w = world(t, { pulls: [pr(7, 'homeowner/a', H(1))], limits: { stall_hours: 1 } });
  await tick(w); w.clock.t += 61 * 60000; await tick(w);
  assert.equal(stalled(await view(w)).length, 1);
  assert.throws(() => validateTeamConfig(config({ stall_hours: 0 })), /stall_hours/);
  assert.throws(() => validateTeamConfig(config({ stall_hours: 'x' })), /stall_hours/);
});
