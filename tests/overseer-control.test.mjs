// Issue #1115: park, stop_job and unpark through the MCP. Fake GitHub and jobs, a real inbox directory and a real Team; no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeLater } from './_tmp-leaks.mjs';
import * as inbox from '../supervisor/inbox.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { controlRecords } from '../supervisor/controlactions.mjs';
import { createToolset as createTools } from '../foreman-mcp/toolset.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';
import { controlsFor } from '../foreman-mcp/controlview.mjs';

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const JOB = 'c3'.repeat(16), SHORT = JOB.slice(0, 8), HEAD = 'a1'.repeat(20);
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });
const cfg = dir => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });

function world(t, { jobStatus = 'running' } = {}) {
  const dir = tmp(t, 'ctl-'), state = tmp(t, 'ctlstate-'), calls = { labelled: [], unlabelled: [], stopped: [] };
  fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const gh = { prs: [{ number: 5, headRefName: 'claude/issue-5-x', headRefOid: HEAD, isDraft: false, labels: [], mergeable: 'CONFLICTING' }, { number: 6, headRefName: 'claude/issue-6-x', headRefOid: HEAD, isDraft: false, labels: ['parked'] }],
    issues: [{ number: 23, state: 'OPEN', title: 'T', body: '', labels: [] }],
    listPulls: async () => gh.prs, listIssues: async () => gh.issues, getPull: async () => null, board: async () => {}, listMergedPulls: async () => [],
    addLabelAsApp: async (n, l) => gh.park(n, l), park: async (n, l) => { calls.labelled.push([n, l]); const x = [...gh.prs, ...gh.issues].find(i => i.number === n); x.labels = [...x.labels, l]; },
    removeLabel: async (n, l) => { calls.unlabelled.push([n, l]); const x = [...gh.prs, ...gh.issues].find(i => i.number === n); x.labels = x.labels.filter(y => y !== l); } };
  const jobs = { states: { [JOB]: { id: JOB, status: jobStatus, provider: 'claude' } }, listActive: async () => [], get: async id => jobs.states[id] || null,
    stop: async id => { calls.stopped.push(id); jobs.states[id].status = 'stopped'; jobs.states[id].autoRestart = false; } };
  const team = new Team({ config: cfg(dir), root: stateRoot(state), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 5000 },
    providerModels: { claude: { aliases: ['opus'], pattern: '^claude-', efforts: ['low'] } } });
  team.s.jobs[JOB] = { kind: 'implement', agent: 'claude', issue: 23, ingested: false, at: 1 };
  return { dir, team, gh, jobs, calls, mcp: createInbox({ dir }) };
}
const control = (action, target, reason = 'it is burning allowance') => ({ kind: 'control', title: `${action} ${target}`, action, target: String(target), reason });
// A proposal as the MCP account writes it, picked up and run by one tick.
async function run(w, item) { const sent = w.mcp.propose(item); await w.team.processInbox(rep()); return inbox.statusOf(w.dir, sent.id); }

test('park: labels the issue as the App identity, runs without a click, records who and why, and the planner then skips it', async t => {
  const w = world(t);
  const before = (await w.team.plan()).filter(a => a.pr === 5 || a.issue === 23);
  assert.ok(before.some(a => a.pr === 5 && a.type === 'rebase'), 'the conflicting pull request is planned for a rebase before it is parked');
  const st = await run(w, control('park', 5));
  assert.equal(st.state, 'done'); assert.match(st.result, /pull request #5 is parked/); assert.deepEqual(w.calls.labelled, [[5, 'parked']]);
  assert.equal(st.control.by, 'overseer'); assert.equal(st.control.reason, 'it is burning allowance'); assert.equal(st.control.changed, true);
  assert.ok(!(await w.team.plan()).some(a => a.pr === 5), 'a parked pull request is planned for nothing');
  const issue = await run(w, control('park', 23)); assert.equal(issue.state, 'done'); assert.deepEqual(w.calls.labelled[1], [23, 'parked']);
});
test('park: an item with a running job does not stop it, and says so', async t => {
  const w = world(t); const st = await run(w, control('park', 23));
  assert.match(st.result, new RegExp(`${SHORT}.*not stopped`)); assert.deepEqual(w.calls.stopped, []); assert.equal(w.jobs.states[JOB].status, 'running');
});
test('park: an already parked item changes nothing and says so; an unknown number and a missing reason are refused', async t => {
  const w = world(t);
  const again = await run(w, control('park', 6)); assert.equal(again.state, 'done'); assert.match(again.result, /already parked; nothing changed/); assert.equal(again.control.changed, false); assert.deepEqual(w.calls.labelled, []);
  const unknown = await run(w, control('park', 999)); assert.equal(unknown.state, 'refused'); assert.match(unknown.reason, /no open issue or pull request #999/);
  assert.throws(() => w.mcp.propose({ ...control('park', 5), reason: undefined }), /reason must be a non-empty string/);
  assert.throws(() => w.mcp.propose({ ...control('park', 5), reason: '  ' }), /reason must be a non-empty string/);
});
test('stop_job: ends the job, leaves it unable to restart, and a second stop reports that it already ended', async t => {
  const w = world(t); const st = await run(w, control('stop_job', SHORT));
  assert.equal(st.state, 'done'); assert.deepEqual(w.calls.stopped, [JOB]); assert.equal(w.jobs.states[JOB].status, 'stopped'); assert.equal(w.jobs.states[JOB].autoRestart, false);
  const again = await run(w, control('stop_job', SHORT)); assert.equal(again.state, 'done'); assert.match(again.result, /already ended \(stopped\)/); assert.equal(w.calls.stopped.length, 1);
  const unknown = await run(w, control('stop_job', 'deadbeef')); assert.equal(unknown.state, 'refused'); assert.match(unknown.reason, /no job deadbeef/);
});
test('unpark: creates an Inbox item that waits for approval; nothing is released until the homeowner approves', async t => {
  const w = world(t);
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), inbox: w.mcp, controlWaitMs: 0 });
  const out = JSON.parse((await tools.call('foreman_unpark', { number: 6, reason: 'the blocker is fixed' })).text);
  assert.equal(out.state, 'submitted'); await w.team.processInbox(rep());
  assert.equal(inbox.statusOf(w.dir, out.id).state, 'pending'); assert.deepEqual(w.calls.unlabelled, []);
  assert.equal(inbox.decide(w.dir, out.id, 'approve', 2).ok, true); await w.team.processInbox(rep());
  const st = inbox.statusOf(w.dir, out.id); assert.equal(st.state, 'done'); assert.deepEqual(w.calls.unlabelled, [[6, 'parked']]);
  const w2 = world(t); const id = w2.mcp.propose({ kind: 'action', title: 'unpark 5', action: 'unpark', target: '5', reason: 'x' }).id;
  await w2.team.processInbox(rep()); inbox.decide(w2.dir, id, 'approve', 2); await w2.team.processInbox(rep());
  assert.equal(inbox.statusOf(w2.dir, id).state, 'failed'); assert.match(inbox.statusOf(w2.dir, id).reason, /not parked/);
});
test('the control kind cannot be used for anything else: no release, merge or approval, and no state or extra field', t => {
  for (const action of ['unpark', 'merge', 'approve', 'reopen', 'resume_job']) assert.equal(inbox.validateItem(control(action, 5)).ok, false, action);
  assert.throws(() => createInbox({ dir: tmp(t, 'x-') }).propose(control('unpark', 5)), /action must be one of: park, stop_job/);
  assert.equal(inbox.validateItem({ ...control('park', 5), state: 'done' }).ok, false);
  assert.equal(inbox.validateItem(control('park', '5; rm')).ok, false);
  assert.equal(inbox.validateItem(control('stop_job', 7)).ok, false);
});
test('a full approval queue does not hold back a control item', async t => {
  const w = world(t);
  for (let i = 0; i < 3; i++) w.mcp.propose({ kind: 'prompt', title: `t${i}`, prompt: 'do a thing' });
  inbox.scan(w.dir, 1, { maxPending: 3 });
  const sent = w.mcp.propose(control('park', 23)); inbox.scan(w.dir, 2, { maxPending: 3 });
  assert.equal(inbox.statusOf(w.dir, sent.id).state, 'approved');
});
test('records: who, when, why and result are readable through foreman_why_blocked and foreman_jobs', async t => {
  const w = world(t); await run(w, control('park', 23, 'wrong order')); await run(w, control('stop_job', SHORT, 'runaway rebase'));
  const controls = controlRecords(w.dir, inbox);
  const view = { controls, jobs: [{ fullId: JOB, kind: 'implement', ref: 23, status: 'stopped' }], attention: [], queues: {}, issues: [{ number: 23, title: 'T', state: 'OPEN', labels: ['parked'] }], prs: [], excluded: [], panels: {}, display: {} };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0 }) }, readHost: () => ({}), inbox: w.mcp, controlWaitMs: 0 });
  const why = JSON.parse((await tools.call('foreman_why_blocked', { kind: 'issue', number: 23 })).text);
  assert.equal(why.controls.length, 1); assert.equal(why.controls[0].by, 'overseer'); assert.equal(why.controls[0].reason, 'wrong order'); assert.match(why.controls[0].result, /parked/); assert.ok(why.controls[0].at);
  const jobs = JSON.parse((await tools.call('foreman_jobs', {})).text);
  assert.equal(jobs.jobs[0].controls[0].reason, 'runaway rebase'); assert.match(jobs.jobs[0].controls[0].result, /stopped/);
  assert.deepEqual(controlsFor(undefined, { number: 1 }), []);
});
test('control records and MCP augmentation redact and bound free text', async () => {
  const raw = ['token', '=', 'test-', 'value-', 'assembled-', 'at-', 'runtime-', 'only'].join('');
  const long = Array.from({ length: 200 }, () => 'x').join(' ');
  const store = { allStatuses: () => [{
    id: 'a'.repeat(32),
    kind: 'control',
    control: { action: 'park', target: '23', reason: raw, changed: true },
    state: 'done',
    result: long,
    createdAt: 1
  }] };
  const controls = controlRecords('', store);
  assert.equal(controls[0].reason, 'token=[secret]');
  assert.equal(controls[0].result.length, 300);
  const view = {
    controls: [{ ...controls[0], reason: raw }],
    attention: [],
    queues: {},
    issues: [{ number: 23, title: 'T', state: 'OPEN', labels: [] }],
    prs: [],
    excluded: [],
    panels: {},
    display: {}
  };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0 }) }, readHost: () => ({}) });
  const out = await tools.call('foreman_why_blocked', { kind: 'issue', number: 23 });
  assert.doesNotMatch(out.text, new RegExp(raw));
  assert.match(out.text, /token=\[redacted\]/);
});
test('a refusal is recorded with its reason, and the tools wait for and return the result', async t => {
  const w = world(t);
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), inbox: w.mcp, controlWaitMs: 5000 });
  const list = tools.list().map(x => x.name); for (const n of ['foreman_park', 'foreman_stop_job', 'foreman_unpark']) assert.ok(list.includes(n), n);
  assert.ok(!list.some(n => /merge|approve/.test(n)), 'no merge or approve tool');
  const call = tools.call('foreman_park', { number: 999, reason: 'typo' });
  await new Promise(r => setTimeout(r, 50)); await w.team.processInbox(rep());
  const out = JSON.parse((await call).text);
  assert.equal(out.state, 'refused'); assert.match(out.reason, /no open issue or pull request #999/);
  const bad = await tools.call('foreman_park', { number: 5 }); assert.equal(bad.isError, true); assert.match(bad.text, /reason must be a non-empty string/);
});
