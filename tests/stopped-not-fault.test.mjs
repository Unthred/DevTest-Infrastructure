// Issue #1179: a job stopped on purpose is not an infrastructure fault and never parks the agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as faults from '../supervisor/faults.mjs';
import { FaultFlow, withParking } from '../supervisor/faultflow.mjs';
import { unavailableStart } from '../supervisor/slotaccounting.mjs';
import { releaseAgentApproved } from '../supervisor/releaseagent.mjs';
import { validateItem } from '../supervisor/inbox.mjs';
import { checkProposal } from '../foreman-mcp/inbox.mjs';
import { controlTools } from '../foreman-mcp/controltools.mjs';

const T0 = Date.UTC(2026, 10, 12, 5, 43, 43);
const flowOf = (state = {}) => { let now = T0; const f = new FaultFlow({ state: () => state, now: () => now, save() {} }); f.tick = ms => { now += ms; }; return f; };
const stoppedThenOverwritten = { status: 'blocked', lastEvent: 'crash', usage: {}, stop: { by: 'overseer', reason: 'manual_stop', at: T0 } };

test('a stop marker wins over the status a dying worker wrote afterwards', () => {
  const c = faults.classifyEnd(stoppedThenOverwritten);
  assert.deepEqual([c.kind, c.cause, c.by], ['none', 'manual_stop', 'overseer']);
  assert.equal(faults.countsAsAttempt(c), false);
  assert.equal(faults.classifyEnd({ status: 'failed', lastEvent: 'something', usage: {}, stop: { by: 'homeowner', reason: 'close_job' } }).cause, 'close_job');
});

test('without a stop marker the same record is still an infrastructure fault', () => {
  const { stop, ...noStop } = stoppedThenOverwritten;
  assert.deepEqual([faults.classifyEnd(noStop).kind, faults.classifyEnd(noStop).cause], ['infra', 'other_infra']);
  assert.equal(faults.classifyEnd({ ...noStop, stop: 'junk' }).kind, 'infra');
});

test('onEnd: a stopped job leaves no fault record, no count and no park', () => {
  const state = {}, f = flowOf(state), report = {};
  f.onEnd('a888b4fb1111', { kind: 'review', agent: 'claude', pr: 1174 }, stoppedThenOverwritten, report);
  assert.equal(f.parked('claude'), null);
  assert.deepEqual(f.infra.counts, {});
  assert.deepEqual(f.infra.recent, []);
  assert.equal(report.infraFaults, undefined);
});

test('onEnd: a real infrastructure fault still parks, and the hold text names cause, job, time and next probe', () => {
  const f = flowOf(), report = {};
  f.onEnd('a888b4fb1111', { kind: 'review', agent: 'claude', pr: 1174 }, { status: 'failed', lastEvent: 'network_error', usage: {} }, report);
  const rec = f.parked('claude');
  assert.equal(rec.job, 'a888b4fb');
  const limit = withParking(() => null, f)('claude');
  assert.equal(limit.parked, true);
  const hold = unavailableStart('claude', { type: 'review' }, limit);
  assert.match(hold, /parked after an infrastructure fault: network failure, job a888b4fb, at 2026-11-12 05:43 UTC; next probe 2026-11-12 05:48 UTC/);
  assert.doesNotMatch(hold, /out of allowance/);
  assert.match(unavailableStart('codex', { type: 'review' }, { out: true, reason: 'weekly window' }), /out of allowance/);
});

test('summary lists the parked entry with cause, job, time and probe schedule', () => {
  const f = flowOf();
  f.onEnd('a888b4fb1111', { kind: 'review', agent: 'claude', pr: 1174 }, { status: 'failed', lastEvent: 'network_error', usage: {} }, {});
  const [p] = f.summary().parked;
  assert.deepEqual([p.agent, p.cause, p.job, p.since, p.nextProbeAt], ['claude', 'network', 'a888b4fb', T0, T0 + 300000]);
  assert.match(p.probeSchedule, /5, 15, 30, 60 minutes, then hourly/);
  assert.match(p.text, /job a888b4fb/);
});

test('release action clears the park; a second release and an unknown agent are refused', () => {
  const f = flowOf();
  f.onEnd('a888b4fb1111', { kind: 'review', agent: 'claude', pr: 1174 }, { status: 'failed', lastEvent: 'network_error', usage: {} }, {});
  assert.match(releaseAgentApproved('claude', f), /claude released from its park \(network, job a888b4fb/);
  assert.equal(f.parked('claude'), null);
  assert.throws(() => releaseAgentApproved('claude', f), /not parked/);
  assert.throws(() => releaseAgentApproved('nobody', f), /not parked/);
});

test('release_agent is an approved action in both validators, never a control item', () => {
  const item = { kind: 'action', title: 'release claude', action: 'release_agent', target: 'claude', reason: 'the stop was deliberate' };
  assert.equal(validateItem(item).ok, true);
  assert.equal(validateItem({ ...item, target: 'Claude; rm' }).ok, false);
  assert.equal(validateItem({ ...item, kind: 'control' }).ok, false);
  assert.equal(checkProposal(item).ok, true);
  assert.equal(checkProposal({ ...item, kind: 'control' }).ok, true, 'the MCP lets a control name through; Foreman refuses and audits it');
  assert.equal(checkProposal({ ...item, target: '12' }).ok, false);
});

test('foreman_release_agent proposes an action item', async () => {
  const sent = [];
  const tools = controlTools({ inbox: { propose: item => { sent.push(item); return { ok: true }; } } });
  const tool = tools.find(t => t.name === 'foreman_release_agent');
  await tool.run({ agent: 'claude', reason: 'benign' });
  assert.deepEqual([sent[0].kind, sent[0].action, sent[0].target], ['action', 'release_agent', 'claude']);
});

test('a park record written before this change still yields a hold text', () => {
  assert.match(faults.parkedHoldText('codex', { cause: 'provider_outage' }), /provider outage, an unnamed job, at an unknown time; next probe an unknown time/);
});

test('a work stop reason on the marker stays a work outcome', () => {
  const c = faults.classifyEnd({ status: 'stopped', lastEvent: 'idle_timeout', stop: { by: 'overseer', reason: 'idle_timeout' }, usage: { inputTokens: 5, outputTokens: 1 } });
  assert.equal(c.kind, 'work');
});

// The real stop path: the stop command writes the record from another process while the worker runs; the worker's exit save must keep it.
test('a stop written during a run survives the worker exit save and classifies as no fault', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { saveJob, readJob, stateRoot } = await import('../supervisor/core.mjs');
  const { runProcess } = await import('../supervisor/process.mjs');
  const { stopJob } = await import('../supervisor/stopjob.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stop1179-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const root = stateRoot(path.join(dir, 'state')), id = 'c'.repeat(32), clock = { now: () => Date.now(), sleep: async () => {} };
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });
  const job = { id, kind: 'review', worktree: dir, attempts: 1, status: 'running', lastEvent: 'started', provider: 'claude', role: 'devtest', scope: 's', allowedActions: ['read'], prompt: 'p', autoRestart: true };
  saveJob(root, job, clock);
  const adapter = { command: () => [process.execPath, '-e', 'setTimeout(()=>{}, 700)'], observe: () => ({}), preflight: () => true };
  const running = runProcess(root, job, { manifest: { launch: { env_allowlist: ['PATH'] } } }, adapter, clock, {});
  await new Promise(r => setTimeout(r, 250));
  stopJob(root, readJob(root, id), { by: 'homeowner', why: 'duplicate review being closed', clock });
  await running;
  const disk = readJob(root, id);
  assert.equal(disk.status, 'stopped');
  assert.deepEqual([disk.stop.by, disk.stop.why, disk.lastEvent, disk.autoRestart], ['homeowner', 'duplicate review being closed', 'manual_stop', false]);
  const c = faults.classifyEnd(disk);
  assert.deepEqual([c.kind, c.by, c.why], ['none', 'homeowner', 'duplicate review being closed']);
  const rec = { kind: 'review', agent: 'claude', pr: 1174 }, f = flowOf();
  f.onEnd(id, rec, disk, {});
  assert.equal(f.parked('claude'), null);
  assert.deepEqual(f.infra.counts, {});
  assert.deepEqual([rec.stoppedBy.by, rec.stoppedBy.why], ['homeowner', 'duplicate review being closed']);
});

test('a stopped record from before the fix (status stopped, last event started, no marker) is not a fault', () => {
  const c = faults.classifyEnd({ status: 'stopped', lastEvent: 'started', usage: {} });
  assert.deepEqual([c.kind, c.cause], ['none', 'manual_stop']);
});
