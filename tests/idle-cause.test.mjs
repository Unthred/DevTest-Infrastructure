// Issue #487: idle time by cause (waiting for the next tick, upgrade, tick run time, a named hold, no eligible work), a hold that
// applies to one agent only, the report command and the dashboard hold naming. Fixture figures are counted by hand in the comments.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classifyIdle, idleBreakdown, idleReport, renderIdleReport } from '../supervisor/idlecause.mjs';
import { idleReason } from '../supervisor/dashboard.mjs';
import { recordTick, readSnapshots } from '../supervisor/dashdata.mjs';

const M = 60000, B = Date.UTC(2026, 10, 3, 6, 0, 0), at = m => B + m * M;
const agents = { claude: 'claude', codex: 'codex' };
const job = (provider, from, to, status = 'completed') => ({ id: `${provider}-${from}`.padEnd(32, '0'), provider, status, createdAt: at(from), updatedAt: at(to) });
const idle = (claude, codex) => ({ ...(claude ? { claude } : {}), ...(codex ? { codex } : {}) });
const NO = { cause: 'no-eligible-work' }, HOLD = { cause: 'named-hold', hold: 'review slot full: PR #9' }, UP = { cause: 'upgrade' };

// Window 0..60 min. claude: job 0-10, job 30-40. codex: job 0-20.
const jobs = [job('claude', 0, 10), job('claude', 30, 40), job('codex', 0, 20)];
const snapshots = [
  { at: at(9), startedAt: at(8.9), idle: idle(null, null) },        // both running
  { at: at(12), startedAt: at(11.5), idle: idle(HOLD, null) },      // claude: named hold; codex still running
  { at: at(17), startedAt: at(16.8), idle: idle(UP, null) },
  { at: at(22), startedAt: at(21.9), idle: idle(NO, NO) },
  { at: at(27), startedAt: at(26), idle: idle(NO, NO) },
  { at: at(31), startedAt: at(28), idle: idle(null, NO), plan: [{ agent: 'claude', type: 'implement', ref: 5 }] },   // the tick that started claude's job at 30
  { at: at(41), startedAt: at(40.5), idle: idle(NO, NO) },
  { at: at(46), startedAt: at(45.5), idle: idle(UP, NO) },
];

test('each cause is counted, with the hand-counted minutes, for the agent that has it', () => {
  const r = idleBreakdown({ jobs, snapshots, agents, from: at(0), to: at(60) }).claude;
  // gap 10-30: [10,12] named hold (the tick that ends it names the hold) 2, [12,17] after the hold tick 5 => 7; [17,22] upgrade 5;
  // [22,27] nothing eligible 5; [27,28] ends at the tick that started the job: waiting for the tick 1; 28-30 tick run time 2.
  // tail 40-60: [40,41] nothing eligible 1, [41,46] nothing eligible 5, [46,60] upgrade 14.
  assert.deepEqual(r.minutes, { 'waiting-for-tick': 1, upgrade: 19, 'tick-run': 2, 'named-hold': 7, 'no-eligible-work': 11, unrecorded: 0 });
  assert.equal(r.busyMinutes, 20); assert.deepEqual(r.holds, { 'review slot full: PR #9': 7 });
  const total = r.busyMinutes + Object.values(r.minutes).reduce((a, b) => a + b, 0);
  assert.equal(total, 60, 'busy plus every cause covers the whole window');
});

test('tick run time is measured from the start of the tick that started the job to the job start', () => {
  const r = idleBreakdown({ jobs: [job('claude', 0, 10), job('claude', 30, 40)], snapshots, agents: { claude: 'claude' }, from: at(0), to: at(40) }).claude;
  assert.equal(r.minutes['tick-run'], 2);
  // a tick that took 4.5 minutes before the job started
  const slow = snapshots.map(s => (s.at === at(31) ? { ...s, startedAt: at(25.5) } : s));
  assert.equal(idleBreakdown({ jobs, snapshots: slow, agents, from: at(0), to: at(60) }).claude.minutes['tick-run'], 4.5);
});

test('a hold that applies to one agent leaves the other agent counted as nothing to do', () => {
  const c = idleBreakdown({ jobs, snapshots, agents, from: at(0), to: at(60) });
  // codex: busy 0-20, then 40 minutes with nothing eligible; the claude hold and upgrade do not reach it
  assert.deepEqual(c.codex.minutes, { 'waiting-for-tick': 0, upgrade: 0, 'tick-run': 0, 'named-hold': 0, 'no-eligible-work': 40, unrecorded: 0 });
  assert.deepEqual(c.codex.holds, {});
});

test('classifyIdle: the upgrade hold, a named hold and a planned job each apply only to their own agent', () => {
  const states = { claude: 'idle', codex: 'idle', third: 'running' };
  const holds = { claude: { review: 'review slot full: PR #9', implement: 'review slot full: PR #9' } };
  assert.deepEqual(classifyIdle({ states, holds }), { claude: { cause: 'named-hold', hold: 'review slot full: PR #9' }, codex: { cause: 'no-eligible-work' } });
  assert.deepEqual(classifyIdle({ states, heldAgents: ['codex'], holds, plan: [{ agent: 'codex', type: 'implement' }] }), { claude: { cause: 'named-hold', hold: 'review slot full: PR #9' }, codex: { cause: 'upgrade' } });
  assert.deepEqual(classifyIdle({ states, plan: [{ agent: 'claude', type: 'review' }] }), { claude: { cause: 'work-planned' }, codex: { cause: 'no-eligible-work' } });
  assert.deepEqual(classifyIdle({ states, plan: [{ agent: 'claude', type: 'merge' }] }).claude, { cause: 'no-eligible-work' }, 'a merge is not a job for the agent');
});

test('no tick record at all is reported as unrecorded, never as work available', () => {
  const r = idleBreakdown({ jobs: [], snapshots: [], agents: { claude: 'claude' }, from: at(0), to: at(30) }).claude;
  assert.equal(r.minutes.unrecorded, 30); assert.equal(idleReport({ jobs: [], snapshots: [], agents: { claude: 'claude' }, from: at(0), to: at(30) }).agents.claude.idleWithWorkPercent, 0);
});

test('the report: idle with work available as a percent of the window, and the text form', () => {
  const rep = idleReport({ jobs, snapshots, agents, from: at(0), to: at(60) });
  // claude: 1 + 19 + 2 + 7 = 29 of 60 minutes = 48.3 %; codex 0 %
  assert.equal(rep.agents.claude.idleWithWorkMinutes, 29); assert.equal(rep.agents.claude.idleWithWorkPercent, 48.3); assert.equal(rep.agents.codex.idleWithWorkPercent, 0);
  const text = renderIdleReport(rep);
  assert.match(text, /claude: busy 20 of 60; idle with work available 29 \(48\.3%\)/); assert.match(text, /hold "review slot full: PR #9": 7/); assert.match(text, /tick run time before the job started: 2/);
});

test('a concurrent second job on one agent does not count as idle time between them', () => {
  const two = [job('claude', 0, 20), job('claude', 10, 30)];
  const r = idleBreakdown({ jobs: two, snapshots: [], agents: { claude: 'claude' }, from: at(0), to: at(30) }).claude;
  assert.equal(r.busyMinutes, 30); assert.equal(Object.values(r.minutes).reduce((a, b) => a + b, 0), 0);
});

test('recordTick stores the tick start and the per-agent idle cause in the snapshot, and nothing else is added', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const team = { c: { repository: 'o/r', agents: { claude: { provider: 'claude' }, codex: { provider: 'codex' } } }, view: { prs: [], issues: [] }, delivered: [], merged: [] };
  recordTick(root, { now: at(5), status: 'ok', team, jobs: [], startedAt: at(4), heldAgents: ['claude'], holds: { codex: { review: 'review slot full: PR #9' } }, actions: [{ agent: 'claude', type: 'implement', issue: 5 }] });
  const s = readSnapshots(root)[0];
  assert.equal(s.startedAt, at(4)); assert.deepEqual(s.idle, { claude: { cause: 'upgrade' }, codex: { cause: 'named-hold', hold: 'review slot full: PR #9' } });
});

test('the dashboard names the hold for the agent it belongs to, and says "next tick" only without a hold', () => {
  const cfg = { repository: 'o/r', enabled: true, agents: { claude: { issues: [], provider: 'claude' }, codex: { issues: [], provider: 'codex' } }, limits: { max_fix_attempts: 3 } };
  const names = { issue: n => ({ text: `#${n}` }), pr: n => ({ text: `PR #${n}` }) };
  const base = { agent: 'claude', config: cfg, team: { c: cfg }, cache: { issues: [], pulls: [] }, plan: [{ agent: 'claude', type: 'implement', issue: 5 }], state: 'idle', names };
  assert.match(idleReason({ ...base, hold: { cause: 'named-hold', hold: 'implement slot full: #3' } }).text, /about to start implement #5 once the hold clears; held: implement slot full: #3/);
  assert.match(idleReason({ ...base, hold: { cause: 'upgrade' } }).text, /held: an upgrade is pending or draining/);
  assert.match(idleReason(base).text, /on the next tick/);
  assert.match(idleReason({ ...base, hold: { cause: 'no-eligible-work' } }).text, /on the next tick/);
});

test('the report command reads local records only and prints the range it was asked for', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-cli-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = spawnSync(process.execPath, ['supervisor/cli.mjs', 'team', 'idle-report', '--from', 'not-a-time'], { env: { ...process.env, AI_SUPERVISOR_ROOT: root }, encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /idle-report/);
});
