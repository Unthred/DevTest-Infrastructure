// Issue #1238: no hold may freeze the queue. Fake GitHub, jobs and clock; every case drives the real tick entry point (Team.tickPass).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as inbox from '../supervisor/inbox.mjs';
import * as breaker from '../supervisor/breaker.mjs';
import { Team, orderSensitive } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { findCycle, breakCycles } from '../supervisor/holdgraph.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const MIN = 60000, T0 = 10 * 60 * MIN;
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const PROMPT = { kind: 'prompt', title: 'Put issue 9 before issue 5', prompt: 'Reorder the issue list in team.json so issue 9 comes first.' };

function world(t) {
  const dir = tmp(t, 'inbox-'), state = tmp(t, 'state-');
  fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const created = [], clock = { t: T0 };
  const gh = { listPulls: async () => [], getPull: async () => null, listIssues: async () => [{ number: 5, title: 'five', state: 'OPEN', body: '', labels: [] }], board: async () => {}, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {} };
  const jobs = { seq: 0, states: {}, listActive: async () => [], get: async id => jobs.states[id] || null, create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const team = new Team({ config, root: stateRoot(state), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => clock.t },
    providerModels: { claude: { aliases: ['opus', 'sonnet', 'haiku'], pattern: '^claude-', efforts: ['low', 'medium', 'high'] } } });
  return { dir, team, created, clock };
}
function approve(w, item) {
  const id = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
  fs.writeFileSync(path.join(w.dir, 'items', `${id}.json`), JSON.stringify(item));
  inbox.scan(w.dir, w.clock.t);
  assert.equal(inbox.decide(w.dir, id, 'approve', w.clock.t).ok, true);
  return id;
}
// A halt as the breaker records it: the cause, the job types it stops and the issue or PR subjects whose success clears it.
const halt = (w, types, subjects = ['issue:77']) => { w.team.s.breaker.halts['postcondition_not_met'] = { cause: 'postcondition_not_met', since: w.clock.t - MIN, trippedBy: 'count', jobs: 3, tokens: 0, cost: 1, prs: [], issues: [77], types, subjects }; };
const startedKinds = w => w.created.map(s => s.kind);

test('breaker: a halt of implement jobs does not block an approved prompt; the global halt and a halt of the prompt type do', () => {
  const s = breaker.normalize({}), L = { enabled: true };
  s.halts.x = { cause: 'x', since: 1, types: ['implement'], subjects: ['none'] };
  assert.equal(breaker.blocks(s, L, { type: 'inbox', issue: null }), null, 'implement halt, prompt runs');
  assert.ok(breaker.blocks(s, L, { type: 'implement', issue: 5 }), 'implement is still halted');
  assert.ok(breaker.blocks(s, L, { type: 'inbox', implement: true, issue: null }), 'a prompt that is itself an implement job is halted');
  s.halts.x.types = ['inbox'];
  assert.ok(breaker.blocks(s, L, { type: 'inbox', issue: null }), 'a halt caused by prompts stops prompts');
  const g = breaker.normalize({}); g.global = { since: 1 };
  assert.ok(breaker.blocks(g, L, { type: 'inbox', issue: null }), 'global halt stops everything');
});

test('orderSensitive: a prompt declared read_only or report_only never sets the mark; the validator refuses other values', () => {
  assert.equal(orderSensitive({ ...PROMPT }), true);
  assert.equal(orderSensitive({ ...PROMPT, effect: 'read_only' }), false);
  assert.equal(orderSensitive({ ...PROMPT, effect: 'report_only' }), false);
  assert.equal(inbox.validateItem({ ...PROMPT, effect: 'read_only' }).ok, true);
  assert.match(inbox.validateItem({ ...PROMPT, effect: 'harmless' }).reason, /effect must be one of/);
});

test('tick: a read only prompt never holds implement picks, and the job it starts carries no order mark', async t => {
  const w = world(t); approve(w, { ...PROMPT, title: 'Report the queue', prompt: 'List the open issues.', effect: 'read_only' });
  await w.team.tickPass();
  assert.ok(startedKinds(w).includes('implement'), 'implement started');
  assert.ok(startedKinds(w).includes('inbox'), 'the prompt started too');
  assert.ok(!Object.values(w.team.s.jobs).some(j => j.kind === 'inbox' && j.orderSensitive), 'no order sensitive mark');
});

test('guard: an order sensitive prompt still holds implement picks, and the hold says what it waits for and what ends it', async t => {
  const w = world(t); approve(w, PROMPT);
  w.team.c.limits.roles.inbox = 0;   // no free inbox slot: the prompt waits, the guard must still be bounded
  const guard = w.team.orderGuard();
  assert.match(guard, /approved inbox prompt "Put issue 9 before issue 5" that changes queue order or config/);
  assert.match(guard, /rejected or undone, or 30 minutes after it was approved/);
});

test('guard: a prompt older than twice the inbox time cap is ignored by the order guard', async t => {
  const w = world(t); w.team.c.limits.inbox_max_minutes = 15; approve(w, PROMPT);
  assert.match(w.team.orderGuard() || '', /approved inbox prompt/, 'fresh: holds');
  w.clock.t += 29 * MIN; assert.match(w.team.orderGuard() || '', /approved inbox prompt/, 'under twice the cap: holds');
  w.clock.t += 2 * MIN; assert.equal(w.team.orderGuard(), null, 'older than twice the cap: ignored');
});

test('tick: replay of 12 Nov: implement halted, an order sensitive prompt unstarted and blocked, implement work available -> implement starts', async t => {
  const w = world(t); approve(w, PROMPT);
  halt(w, ['implement', 'inbox']);   // the cause stops the prompt type as well; issue 77 is not the issue being started
  assert.equal(w.team.orderGuard(), null, 'a prompt that cannot start does not hold implement picks');
  const report = await w.team.tickPass();
  assert.deepEqual(startedKinds(w), ['implement'], 'implement started, the blocked prompt did not');
  assert.ok(report.holdCycles?.length, 'the cycle between the order guard and the breaker halt was found');
});

test('tick: an implement halt does not stop the prompt, so no cycle forms and the prompt runs', async t => {
  const w = world(t); approve(w, PROMPT); halt(w, ['implement']);
  await w.team.tickPass();
  assert.ok(startedKinds(w).includes('inbox'), 'prompt started under an implement halt');
  assert.ok(!w.team.s.holdDrops || !Object.keys(w.team.s.holdDrops).length, 'no cycle recorded');
});

test('tick: a two hold cycle is detected, broken at the lowest priority hold, and raises an action item naming both holds', async t => {
  const w = world(t); const id = approve(w, PROMPT);
  halt(w, ['implement', 'inbox']);
  const report = await w.team.tickPass();
  assert.equal(report.holdCycles.length, 1);
  assert.equal(report.holdCycles[0].dropped, `order-guard:${id}`, 'the order guard hold is the lowest priority one');
  const [item] = w.team.holdItems().filter(i => i.id.startsWith('hold-cycle-'));
  assert.equal(item.severity, 'action');
  assert.match(item.text, /new implement picks wait for the approved prompt/);
  assert.match(item.text, /waits for the circuit breaker halted/);
  // once the prompt is gone the item goes with it
  assert.equal(inbox.undo(w.dir, id, w.clock.t).ok, true);
  await w.team.tickPass();
  assert.deepEqual(w.team.holdItems().filter(i => i.id.startsWith('hold-cycle-')), []);
});

test('holdgraph: findCycle and breakCycles on plain data', () => {
  const h = (id, waiter, waitsFor, priority) => ({ id, waiter, waitsFor, priority });
  assert.equal(findCycle([h('a', 'x', 'y', 1), h('b', 'y', 'z', 1)]), null);
  const two = [h('a', 'x', 'y', 2), h('b', 'y', 'x', 1)];
  assert.equal(findCycle(two).length, 2);
  const { dropped } = breakCycles(two);
  assert.deepEqual(dropped.map(d => d.id), ['b']);
  assert.equal(breakCycles([h('a', 'x', 'x', 1)]).dropped.length, 1, 'a hold that waits for itself');
});

test('a hold that lasts over 30 minutes shows its owner and its control (cap raised so the guard still holds, checked through the tick)', async t => {
  const w = world(t); w.team.c.limits.inbox_max_minutes = 60; w.team.c.limits.roles.inbox = 0; approve(w, PROMPT);
  await w.team.tickPass();
  assert.deepEqual(w.team.holdItems().filter(i => i.id.startsWith('stalled-hold')), [], 'young: no item');
  w.clock.t += 31 * MIN;
  await w.team.tickPass();
  const [item] = w.team.holdItems().filter(i => i.id.startsWith('stalled-hold'));
  assert.match(item.text, /Owner: overseer/);
  assert.match(item.action, /reject or undo the prompt/);
});

test('a prompt blocked by a usage limit has its own owner and control, and no order guard hold is reported for it', async t => {
  const w = world(t); w.team.c.limits.inbox_max_minutes = 60; approve(w, PROMPT);
  w.team.limitedOf = () => ({ out: true });
  await w.team.tickPass();
  w.clock.t += 31 * MIN;
  await w.team.tickPass();
  const items = w.team.holdItems().filter(i => i.id.startsWith('stalled-hold'));
  assert.equal(items.length, 1, 'only the limit hold');
  assert.match(items[0].text, /every agent is at a usage limit/);
  assert.match(items[0].text, /usage limit resets/);
  assert.doesNotMatch(items[0].action + items[0].text, /Breaker|breaker|new implement picks wait/);
});

test('tick: replay of 12 Nov with the halt of implement jobs only: the prompt itself starts', async t => {
  const w = world(t); approve(w, PROMPT); halt(w, ['implement']);
  await w.team.tickPass();
  assert.deepEqual(startedKinds(w), ['inbox'], 'the prompt starts under an implement halt');
});

test('foreman_propose accepts effect for a prompt, refuses other values and other kinds, and the approval card shows it', async t => {
  const { checkProposal } = await import('../foreman-mcp/inbox.mjs');
  const ok = checkProposal({ kind: 'prompt', title: 'Diagnose', prompt: 'List open issues.', effect: 'read_only' });
  assert.equal(ok.ok, true); assert.equal(ok.item.effect, 'read_only');
  assert.equal(checkProposal({ kind: 'prompt', title: 'Diagnose', prompt: 'List open issues.' }).ok, true, 'effect stays optional');
  assert.match(checkProposal({ kind: 'prompt', title: 'D', prompt: 'x', effect: 'harmless' }).error, /effect must be one of/);
  assert.match(checkProposal({ kind: 'issue_draft', title: 'D', body: 'x', effect: 'read_only' }).error, /unknown argument: effect/);
  // the item the proposer wrote passes the supervisor's own validation, and the card tells the homeowner about the exemption
  assert.equal(inbox.validateItem(ok.item).ok, true);
  const w = world(t), id = 'c'.repeat(32);
  fs.writeFileSync(path.join(w.dir, 'items', `${id}.json`), JSON.stringify(ok.item));
  inbox.scan(w.dir, w.clock.t);
  const [card] = inbox.pendingCards(w.dir);
  assert.match(card.will, /declares it read only: it does not hold new implement work back/);
});
