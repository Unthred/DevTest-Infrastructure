// Issue #1164: the overseer's direct controls. Fake GitHub and jobs, a real inbox directory and a real Team; no model, no network.
// Covers: each action (valid, boundary, invalid), each restricted name refused, the audit record for every success and refusal, idempotence,
// the switch, undo, short and full job ids, and that the planner honours the queue edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as inbox from '../supervisor/inbox.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { readAudit, writeSwitch, requestUndo, readSwitch } from '../supervisor/directstore.mjs';
import { DIRECT, RESTRICTED, readValue, notDirectReason } from '../supervisor/directspec.mjs';
import { shape, applyDependsEdits } from '../supervisor/directqueue.mjs';
import { createToolset as createTools } from '../foreman-mcp/toolset.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const JOB = 'c3'.repeat(16), SHORT = JOB.slice(0, 8), PAUSED = 'd4'.repeat(16), DONE = 'e5'.repeat(16), HEAD = 'a1'.repeat(20);
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });
const cfg = dir => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });

function world(t, { limited = false } = {}) {
  const dir = tmp(t, 'dir-'), state = tmp(t, 'dirstate-'), calls = { labelled: [], unlabelled: [], stopped: [], resumed: [], paused: [], rearmed: [] };
  fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const issue = (number, labels = []) => ({ number, state: 'OPEN', title: `T${number}`, body: '', labels });
  const gh = { prs: [{ number: 41, headRefName: 'claude/issue-40-x', headRefOid: HEAD, isDraft: false, labels: [], mergeable: 'MERGEABLE' }],
    issues: [issue(21), issue(22), issue(23), issue(24), issue(30, ['parked']), issue(40), issue(50)],
    listPulls: async () => gh.prs, listIssues: async () => gh.issues, getPull: async () => null, board: async () => {}, listMergedPulls: async () => [],
    addLabelAsApp: async (n, l) => { calls.labelled.push([n, l]); const x = [...gh.prs, ...gh.issues].find(i => i.number === n); x.labels = [...x.labels, l]; },
    removeLabel: async (n, l) => { calls.unlabelled.push([n, l]); const x = [...gh.prs, ...gh.issues].find(i => i.number === n); x.labels = x.labels.filter(y => y !== l); } };
  const jobs = { states: { [JOB]: { id: JOB, status: 'running', provider: 'claude' }, [PAUSED]: { id: PAUSED, status: 'paused_manual', provider: 'claude' }, [DONE]: { id: DONE, status: 'completed', provider: 'claude' } },
    listActive: async () => [], get: async id => jobs.states[id] || null,
    stop: async id => { calls.stopped.push(id); jobs.states[id].status = 'stopped'; },
    pause: async id => { calls.paused.push(id); jobs.states[id].status = 'paused_manual'; },
    resume: async id => { calls.resumed.push(id); jobs.states[id].status = 'queued'; } };
  const team = new Team({ config: cfg(dir), root: stateRoot(state), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 5000 },
    providerModels: { claude: { aliases: ['opus'], pattern: '^claude-', efforts: ['low'] } }, limitedOf: () => ({ out: limited }) });
  team.s.jobs[JOB] = { kind: 'implement', agent: 'claude', issue: 22, ingested: false, at: 1 };
  team.s.jobs[PAUSED] = { kind: 'implement', agent: 'claude', issue: 22, ingested: true, at: 1 };
  team.s.jobs[DONE] = { kind: 'implement', agent: 'claude', issue: 24, ingested: true, at: 1 };
  team.delivered = new Set([50]);
  team.view = { issues: gh.issues, prs: gh.prs };   // what the planner reads the issues in no agent's list from
  return { dir, team, gh, jobs, calls, state, mcp: createInbox({ dir }) };
}
const control = (action, target, reason = 'discussed with the homeowner', value) => ({ kind: 'control', title: `${action} ${target}`, action, target: String(target), reason, ...(value === undefined ? {} : { value }) });
async function run(w, item) { const sent = w.mcp.propose(item); await w.team.processInbox(rep()); return inbox.statusOf(w.dir, sent.id); }
const audit = w => readAudit(w.dir, 200);
const queue = w => shape(w.team.s.directQueue, [21, 22, 23, 24, 30, 40, 50], null);

test('the spec: every direct control has a target kind, and the restricted names are all refused with who decides', () => {
  assert.deepEqual(Object.keys(DIRECT).sort(), ['assign', 'move_entry', 'park', 'pause_job', 'remove_entry', 'set_depends_on', 'set_notes', 'set_priority', 'set_rank', 'start_job', 'stop_job', 'unpark']);
  for (const name of ['merge', 'approve_review', 'override_verdict', 'clear_retry_cap', 'clear_upgrade_latch', 'close_issue', 'delete_issue', 'close_pr', 'delete_pr', 'set_limit',
    'edit_secret', 'resume_breaker', 'change_host_setting', 'restart', 'reboot', 'approve_prompt', 'approve_issue_draft', 'approve_proposal']) {
    assert.ok(Object.hasOwn(RESTRICTED, name), `${name} is listed as restricted`);
    assert.match(notDirectReason(name), /is not a direct control: /);
  }
  assert.equal(notDirectReason('park'), null);
  assert.match(notDirectReason('made_up'), /accepted: start_job/);
});

test('values: valid, boundary and invalid input for each action that takes one', () => {
  const ok = (a, v) => readValue(a, v).ok, bad = (a, v) => !readValue(a, v).ok;
  assert.ok(ok('set_rank', '1') && ok('set_rank', '9999')); assert.ok(bad('set_rank', '0') && bad('set_rank', '10000') && bad('set_rank', 'first') && bad('set_rank', undefined));
  assert.ok(ok('move_entry', 'before 22') && ok('move_entry', 'after 999999999')); assert.ok(bad('move_entry', 'beside 22') && bad('move_entry', 'before') && bad('move_entry', 'before 0'));
  assert.ok(ok('set_priority', 'high') && ok('set_priority', 'low')); assert.ok(bad('set_priority', 'urgent') && bad('set_priority', ''));
  assert.deepEqual(readValue('set_depends_on', '#12, #15').parsed, { dependsOn: [12, 15] }); assert.deepEqual(readValue('set_depends_on', 'none').parsed, { dependsOn: [] });
  assert.ok(bad('set_depends_on', '12') && bad('set_depends_on', '#12; #15') && bad('set_depends_on', `#1${', #2'.repeat(10)}`));
  assert.ok(ok('assign', 'codex') && ok('assign', 'none')); assert.ok(bad('assign', 'Codex!') && bad('assign', '../x'));
  assert.ok(ok('set_notes', 'x'.repeat(300))); assert.ok(bad('set_notes', 'x'.repeat(301)) && bad('set_notes', 'two\nlines'));
  assert.ok(bad('park', '5') && ok('park', undefined));   // an action without a value takes none
});

test('job ids: the short form and the full form both work; an unknown or ambiguous one is refused with the reason', async t => {
  const w = world(t);
  assert.equal((await run(w, control('pause_job', SHORT))).state, 'done');
  const already = await run(w, control('pause_job', PAUSED, 'full id')); assert.equal(already.state, 'done'); assert.match(already.result, /already paused/);   // the full id works
  const unknown = await run(w, control('pause_job', 'deadbeef')); assert.equal(unknown.state, 'refused'); assert.match(unknown.reason, /no job deadbeef/);
  const twin = 'c3c3c3c3' + 'ff'.repeat(12);
  w.team.s.jobs[twin] = { kind: 'implement', agent: 'claude', issue: 24, at: 1 }; w.jobs.states[twin] = { id: twin, status: 'running' };
  const ambiguous = await run(w, control('pause_job', SHORT)); assert.equal(ambiguous.state, 'refused'); assert.match(ambiguous.reason, /ambiguous; use the full id/);
  const full = await run(w, control('pause_job', twin)); assert.equal(full.state, 'done'); assert.deepEqual(w.calls.paused.at(-1), twin);
  assert.throws(() => w.mcp.propose(control('pause_job', 'abc')), /8-character job id/);
  assert.throws(() => w.mcp.propose(control('pause_job', 'c3'.repeat(14))), /8-character job id/);
});

test('start_job: resumes a paused job once, is idempotent on a running job, refuses an ended one and an agent out of allowance', async t => {
  const w = world(t);
  const st = await run(w, control('start_job', PAUSED.slice(0, 8)));
  assert.equal(st.state, 'done'); assert.deepEqual(w.calls.resumed, [PAUSED]); assert.deepEqual(st.control.before, { status: 'paused_manual' }); assert.deepEqual(st.control.after, { status: 'queued' });
  const again = await run(w, control('start_job', PAUSED.slice(0, 8))); assert.equal(again.state, 'done'); assert.match(again.result, /already queued to start/); assert.equal(w.calls.resumed.length, 1);
  const running = await run(w, control('start_job', SHORT)); assert.match(running.result, /already running/); assert.equal(running.control.changed, false);
  const ended = await run(w, control('start_job', DONE.slice(0, 8))); assert.equal(ended.state, 'refused'); assert.match(ended.reason, /is completed; only a paused/);
  const w2 = world(t, { limited: true });
  const out = await run(w2, control('start_job', PAUSED.slice(0, 8))); assert.equal(out.state, 'refused'); assert.match(out.reason, /out of allowance/); assert.deepEqual(w2.calls.resumed, []);
});

test('pause_job and stop_job: each changes the job once and reports the same state when repeated; an ended job cannot be paused', async t => {
  const w = world(t);
  const p = await run(w, control('pause_job', SHORT)); assert.equal(p.state, 'done'); assert.deepEqual(w.calls.paused, [JOB]); assert.equal(p.control.after.status, 'paused_manual');
  const p2 = await run(w, control('pause_job', SHORT)); assert.match(p2.result, /already paused/); assert.equal(w.calls.paused.length, 1);
  const s = await run(w, control('stop_job', PAUSED.slice(0, 8))); assert.equal(s.state, 'done'); assert.deepEqual(w.calls.stopped, [PAUSED]);
  const s2 = await run(w, control('stop_job', PAUSED.slice(0, 8))); assert.match(s2.result, /already ended \(stopped\)/); assert.equal(w.calls.stopped.length, 1);
  const bad = await run(w, control('pause_job', DONE.slice(0, 8))); assert.equal(bad.state, 'refused'); assert.match(bad.reason, /already ended \(completed\)/);
});

test('park and unpark: both direct and idempotent; the audit trail holds before and after', async t => {
  const w = world(t);
  const a = await run(w, control('park', 21)); assert.equal(a.state, 'done'); assert.deepEqual(w.calls.labelled, [[21, 'parked']]);
  const b = await run(w, control('park', 21)); assert.match(b.result, /already parked; nothing changed/);
  const c = await run(w, control('unpark', 30)); assert.equal(c.state, 'done'); assert.deepEqual(w.calls.unlabelled, [[30, 'parked']]);
  const d = await run(w, control('unpark', 30)); assert.match(d.result, /is not parked; nothing changed/); assert.equal(d.state, 'done');
  const e = await run(w, control('unpark', 9999)); assert.equal(e.state, 'refused'); assert.match(e.reason, /no open issue or pull request #9999/);
  const rows = audit(w); assert.equal(rows.length, 5);
  const first = rows.at(-1); assert.deepEqual([first.action, first.target, first.outcome, first.changed, first.by], ['park', '21', 'done', true, 'overseer']);
  assert.deepEqual(first.before, { parked: false }); assert.deepEqual(first.after, { parked: true }); assert.equal(first.reason, 'discussed with the homeowner');
});

test('set_rank and move_entry: the planner takes issues in the new order; a rank past the end goes last; same rank changes nothing', async t => {
  const w = world(t);
  const r = await run(w, control('set_rank', 24, 'urgent', '1'));
  assert.equal(r.state, 'done'); assert.deepEqual(r.control.after, { rank: 1, of: 7 }); assert.deepEqual(w.team.candidates('claude').slice(0, 2), [24, 21]);
  const same = await run(w, control('set_rank', 24, 'again', '1')); assert.equal(same.control.changed, false); assert.match(same.result, /already at rank 1 of 7/);
  const last = await run(w, control('set_rank', 24, 'to the end', '9999')); assert.equal(last.state, 'done'); assert.equal(w.team.candidates('claude').at(-1), 24);
  const m = await run(w, control('move_entry', 23, 'before 21', 'before 21')); assert.equal(m.state, 'done'); assert.ok(w.team.candidates('claude').indexOf(23) < w.team.candidates('claude').indexOf(21));
  const m2 = await run(w, control('move_entry', 21, 'after 23', 'after 23')); assert.equal(m2.state, 'done');
  const self = await run(w, control('move_entry', 21, 'x', 'before 21')); assert.equal(self.state, 'refused'); assert.match(self.reason, /cannot be placed/);
  const gone = await run(w, control('move_entry', 21, 'x', 'before 31337')); assert.equal(gone.state, 'refused');
  assert.throws(() => w.mcp.propose(control('set_rank', 21, 'x', '10000')), /set_rank needs a valid value/);
  assert.equal(inbox.validateItem(control('set_rank', 21, 'x', '10000')).ok, false);
});

test('queue edits refuse an entry that is not queued: a pull request, a parked, running, implemented or unknown issue', async t => {
  const w = world(t);
  const cases = [[41, /pull request, not a queued issue/], [30, /is parked, so it is not queued/], [22, /being worked on by job c3c3c3c3/], [40, /already has pull request #41/], [50, /already implemented/], [999, /no open issue #999/]];
  for (const [n, re] of cases) {
    const st = await run(w, control('set_priority', n, 'x', 'high')); assert.equal(st.state, 'refused', `#${n}`); assert.match(st.reason, re);
  }
  assert.equal(audit(w).filter(r => r.outcome === 'refused').length, cases.length); assert.deepEqual(w.team.s.directQueue.entries, {});
});

test('set_priority: high priority is taken first, low last, whatever the order; repeating changes nothing', async t => {
  const w = world(t);
  const hi = await run(w, control('set_priority', 24, 'x', 'high')); assert.equal(hi.state, 'done'); assert.equal(w.team.candidates('claude')[0], 24);
  const lo = await run(w, control('set_priority', 21, 'x', 'low')); assert.equal(lo.state, 'done'); assert.equal(w.team.candidates('claude').at(-1), 21);
  const again = await run(w, control('set_priority', 24, 'x', 'high')); assert.equal(again.control.changed, false); assert.match(again.result, /already has high priority/);
  const back = await run(w, control('set_priority', 24, 'x', 'normal')); assert.equal(back.state, 'done'); assert.deepEqual(w.team.s.directQueue.entries[24], undefined);
});

test('assign: an entry assigned to codex is offered to codex only; an unknown agent is refused; none clears it', async t => {
  const w = world(t);
  const st = await run(w, control('assign', 21, 'x', 'codex')); assert.equal(st.state, 'done');
  assert.ok(!w.team.candidates('claude').includes(21)); assert.ok(w.team.candidates('codex').includes(21));
  const bad = await run(w, control('assign', 22, 'x', 'gemini')); assert.equal(bad.state, 'refused');
  const w2 = world(t); const none = await run(w2, control('assign', 21, 'x', 'none')); assert.equal(none.control.changed, false);
  const clear = await run(w, control('assign', 21, 'x', 'none')); assert.equal(clear.state, 'done'); assert.ok(w.team.candidates('claude').includes(21));
});

test('set_depends_on: replaces the Depends on line for the dependency check only, refuses itself, and none clears it', async t => {
  const w = world(t);
  const st = await run(w, control('set_depends_on', 21, 'x', '#22, #23')); assert.equal(st.state, 'done'); assert.deepEqual(w.team.s.directQueue.entries[21].dependsOn, [22, 23]);
  const seen = applyDependsEdits(w.team.s.directQueue, [{ number: 21, body: 'Depends on: #99' }, { number: 22, body: 'Depends on: #98' }]);
  assert.equal(seen[0].body, 'Depends on: #22, #23'); assert.equal(seen[1].body, 'Depends on: #98');
  const again = await run(w, control('set_depends_on', 21, 'x', '#23,#22')); assert.equal(again.control.changed, false);
  const self = await run(w, control('set_depends_on', 21, 'x', '#21')); assert.equal(self.state, 'refused'); assert.match(self.reason, /cannot depend on itself/);
  const none = await run(w, control('set_depends_on', 21, 'x', 'none')); assert.equal(none.state, 'done');
  assert.equal(applyDependsEdits(w.team.s.directQueue, [{ number: 21, body: 'Depends on: #99' }])[0].body, '');
  const dep = await w.team.exclusion(21, new Map([[21, w.gh.issues[0]]]), []); assert.equal(dep, null);
});

test('set_notes and remove_entry: notes are kept; removing parks the issue without closing it and drops its place in the order', async t => {
  const w = world(t);
  const n = await run(w, control('set_notes', 23, 'x', 'wait for the schema change')); assert.equal(n.state, 'done'); assert.equal(w.team.s.directQueue.entries[23].notes, 'wait for the schema change');
  await run(w, control('set_rank', 23, 'x', '1'));
  const r = await run(w, control('remove_entry', 23, 'not this week')); assert.equal(r.state, 'done'); assert.deepEqual(w.calls.labelled, [[23, 'parked']]);
  assert.equal(w.gh.issues.find(i => i.number === 23).state, 'OPEN'); assert.ok(!w.team.s.directQueue.order.includes(23));
  const again = await run(w, control('remove_entry', 23, 'again')); assert.match(again.result, /already parked; nothing changed/);
  const running = await run(w, control('remove_entry', 22, 'x')); assert.equal(running.state, 'refused'); assert.match(running.reason, /being worked on/);
});

test('the number of edited entries is limited: past the limit the edit is refused with the reason', async t => {
  const w = world(t);
  for (let i = 1000; i < 1200; i++) w.team.s.directQueue.entries[i] = { priority: 'low' };
  const st = await run(w, control('set_priority', 21, 'x', 'high')); assert.equal(st.state, 'refused'); assert.match(st.reason, /200 entries already carry an edit/);
});

test('every restricted action is refused, nothing changes, and the refusal is in the audit trail', async t => {
  const w = world(t);
  for (const name of Object.keys(RESTRICTED)) {
    const st = await run(w, control(name, 22)); assert.equal(st.state, 'refused', name); assert.match(st.reason, new RegExp(`${name} is not a direct control`));
  }
  const rows = audit(w); assert.equal(rows.length, Object.keys(RESTRICTED).length);
  assert.ok(rows.every(r => r.outcome === 'refused' && r.changed === false && r.by === 'overseer'));
  assert.deepEqual(w.calls, { labelled: [], unlabelled: [], stopped: [], resumed: [], paused: [], rearmed: [] });
  // a proposal id is not a target, so the overseer cannot approve its own proposals through a direct control
  assert.throws(() => w.mcp.propose(control('park', 'a'.repeat(32))), /target must be an issue or pull request number/);
  assert.equal(inbox.validateItem(control('park', 'a'.repeat(32))).ok, false);
});

test('every success and every refusal leaves an audit record with who, what, target, reason and time', async t => {
  const w = world(t);
  await run(w, control('park', 21)); await run(w, control('park', 999)); await run(w, control('set_priority', 22, 'x', 'high')); await run(w, control('merge', 22));
  const rows = audit(w).reverse();
  assert.deepEqual(rows.map(r => [r.action, r.outcome]), [['park', 'done'], ['park', 'refused'], ['set_priority', 'refused'], ['merge', 'refused']]);
  for (const r of rows) { assert.equal(r.by, 'overseer'); assert.equal(r.at, 5000); assert.ok(r.text.length > 0); assert.ok(r.reason); }
  assert.equal(inbox.allStatuses(w.dir).find(x => x.control?.action === 'park' && x.state === 'done').control.by, 'overseer');
});

test('the switch: with direct control off every action is refused and audited; turning it on restores it; the default is on', async t => {
  const w = world(t);
  assert.equal(readSwitch(w.dir).enabled, true);
  writeSwitch(w.dir, false, 4000);
  for (const item of [control('park', 21), control('unpark', 30), control('stop_job', SHORT), control('start_job', PAUSED.slice(0, 8)), control('pause_job', SHORT), control('remove_entry', 21),
    control('set_rank', 21, 'x', '1'), control('move_entry', 21, 'x', 'after 23'), control('set_priority', 21, 'x', 'high'), control('set_depends_on', 21, 'x', 'none'),
    control('assign', 21, 'x', 'codex'), control('set_notes', 21, 'x', 'n')]) {
    const st = await run(w, item); assert.equal(st.state, 'refused', item.action); assert.match(st.reason, /direct control is turned off/);
  }
  assert.deepEqual(w.calls, { labelled: [], unlabelled: [], stopped: [], resumed: [], paused: [], rearmed: [] }); assert.deepEqual(w.team.s.directQueue.entries, {});
  const refused = audit(w).filter(r => r.outcome === 'refused'); assert.equal(refused.length, 12);
  writeSwitch(w.dir, true, 4500);
  assert.equal((await run(w, control('park', 21))).state, 'done');
  assert.deepEqual(audit(w).filter(r => r.action.startsWith('switch')).map(r => r.action).reverse(), ['switch_off', 'switch_on']);
});

test('undo: park and queue edits and job steps are reversed once; a later edit blocks the reverse; an unchanged action has nothing to undo', async t => {
  const w = world(t);
  await run(w, control('park', 21)); await run(w, control('set_priority', 24, 'x', 'high')); await run(w, control('pause_job', SHORT)); await run(w, control('stop_job', PAUSED.slice(0, 8)));
  const [stop, pause, prio, park] = audit(w);
  const undo = async rec => { const r = requestUndo(w.dir, rec.id, 6000); if (r.ok) await w.team.processInbox(rep()); return r; };
  assert.equal((await undo(park)).ok, true); assert.deepEqual(w.calls.unlabelled, [[21, 'parked']]);
  assert.equal((await undo(prio)).ok, true); assert.equal(w.team.s.directQueue.entries[24], undefined);
  assert.equal((await undo(pause)).ok, true); assert.deepEqual(w.calls.resumed.includes(JOB), true);
  assert.equal((await undo(stop)).ok, true); assert.ok(w.calls.resumed.includes(PAUSED));
  const second = await undo(park); assert.equal(second.ok, false); assert.match(second.reason, /already undone/);
  assert.equal(audit(w).filter(r => r.action === 'undo' && r.by === 'homeowner' && r.outcome === 'done').length, 4);
  assert.ok(audit(w).filter(r => r.action !== 'undo' && r.outcome === 'done').every(r => r.undone));
  const none = await run(w, control('park', 30)); assert.equal(none.control.changed, false);
  assert.equal(requestUndo(w.dir, audit(w)[0].id, 7000).ok, false);   // the unchanged park has nothing to undo
  assert.equal(requestUndo(w.dir, 'f'.repeat(16), 7000).ok, false);
  await run(w, control('set_priority', 23, 'x', 'high')); const edit = audit(w)[0];
  await run(w, control('set_notes', 23, 'x', 'later note'));
  await run(w, control('set_priority', 23, 'x', 'low'));
  assert.equal((await undo(edit)).ok, true);   // requested, but the pass refuses: the entry was edited since
  const refused = audit(w)[0]; assert.equal(refused.action, 'undo'); assert.equal(refused.outcome, 'refused'); assert.match(refused.text, /edited since/);
});

test('undo of a queue order change restores the earlier order only while nothing has moved it since', async t => {
  const w = world(t);
  await run(w, control('set_rank', 24, 'x', '1')); const [first] = audit(w);
  await run(w, control('set_rank', 23, 'x', '1'));
  assert.equal(requestUndo(w.dir, first.id, 6000).ok, true); await w.team.processInbox(rep());
  assert.match(audit(w)[0].text, /queue order has changed since/); assert.equal(w.team.candidates('claude')[0], 23);
  const [, second] = audit(w).filter(r => r.action === 'set_rank'); assert.ok(second);
});

test('the MCP tools: one tool per control, each needing a reason, waiting for and returning the result; the audit trail reads back', async t => {
  const w = world(t);
  const view = () => ({ direct: { enabled: true, switchedAt: null, audit: audit(w) } });
  const tools = createTools({ source: { get: async () => ({ view: view(), ageMs: 0 }) }, readHost: () => ({}), inbox: w.mcp, controlWaitMs: 5000 });
  const names = tools.list().map(x => x.name);
  for (const n of ['start_job', 'pause_job', 'stop_job', 'park', 'unpark', 'remove_entry', 'set_rank', 'move_entry', 'set_priority', 'set_depends_on', 'assign', 'set_notes']) assert.ok(names.includes(`foreman_${n}`), n);
  assert.ok(names.includes('foreman_direct_log')); assert.ok(!names.some(n => /merge|approve|close|delete|limit|restart|reboot/.test(n)), 'no restricted tool');
  for (const tool of tools.list().filter(x => x.name.startsWith('foreman_') && x.annotations?.readOnlyHint === false && x.name !== 'foreman_propose')) assert.ok(tool.inputSchema.required.includes('reason'), tool.name);
  const noReason = await tools.call('foreman_set_priority', { number: 21, priority: 'high' }); assert.equal(noReason.isError, true);
  const bad = await tools.call('foreman_set_priority', { number: 21, priority: 'urgent', reason: 'x' }); assert.equal(bad.isError, true); assert.match(bad.text, /needs a valid value/);
  const call = tools.call('foreman_set_priority', { number: 24, priority: 'high', reason: 'the homeowner wants it first' });
  await new Promise(r => setTimeout(r, 50)); await w.team.processInbox(rep());
  const out = JSON.parse((await call).text); assert.equal(out.state, 'done'); assert.deepEqual(out.resulting.after, { priority: 'high' }); assert.deepEqual(out.resulting.before, { priority: 'normal' });
  const log = JSON.parse((await tools.call('foreman_direct_log', { limit: 5 })).text);
  assert.equal(log.available, true); assert.equal(log.enabled, true); assert.equal(log.entries[0].action, 'set_priority'); assert.equal(log.entries[0].reason, 'the homeowner wants it first');
  const missing = JSON.parse((await createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}) }).call('foreman_direct_log', {})).text);
  assert.equal(missing.available, false);
});

test('the MCP mirror of the spec agrees with the supervisor spec: same names, same target kinds, same accepted and refused values', async () => {
  const mirror = await import('../foreman-mcp/directspec.mjs');
  assert.deepEqual(Object.keys(mirror.TARGETS).sort(), Object.keys(DIRECT).sort());
  for (const [name, spec] of Object.entries(DIRECT)) assert.equal(mirror.TARGETS[name], spec.target, name);
  const samples = { set_rank: ['1', '9999', '0', '10000', 'x'], move_entry: ['before 3', 'after 3', 'beside 3', 'before'], set_priority: ['high', 'normal', 'low', 'urgent'],
    set_depends_on: ['none', '#1', '#1, #2', '#1,#2', '1', '#1 #2'], assign: ['none', 'codex', 'Codex', '1x'], set_notes: ['a note', 'x'.repeat(301), 'a\nb'] };
  for (const [name, values] of Object.entries(samples)) for (const v of values) assert.equal(mirror.VALUES[name].test(v), readValue(name, v).ok, `${name} ${JSON.stringify(v).slice(0, 20)}`);
});

test('the real pause and stop of a job on disk (the steps the supervisor uses): paused is recorded after the worker is asked to wind down; an ended job is refused', async () => {
  const { overseerPause, overseerStop } = await import('../supervisor/stopjob.mjs');
  const { readJob, saveJob } = await import('../supervisor/core.mjs');
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pause-'));
  try {
    const clock = { now: () => 5000 }, procs = { processStart: () => null, childAlive: () => false };
    const job = { id: 'b'.repeat(32), status: 'running', autoRestart: true, autoResume: true, usage: {} };
    saveJob(root, job, clock, true);
    overseerPause(root, readJob(root, job.id), procs);
    assert.equal(readJob(root, job.id).status, 'paused_manual'); assert.equal(readJob(root, job.id).lastEvent, 'manual_pause');
    overseerStop(root, readJob(root, job.id), 'manual_stop', procs);
    assert.equal(readJob(root, job.id).status, 'stopped');
    assert.throws(() => overseerPause(root, readJob(root, job.id), procs), /terminal job cannot be paused/);
    assert.throws(() => overseerStop(root, readJob(root, job.id), 'manual_stop', procs), /terminal job cannot be stopped/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
