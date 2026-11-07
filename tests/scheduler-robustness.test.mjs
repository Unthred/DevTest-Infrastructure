// Issue #995: liveness timeout, rebase precheck, same-cause retry cap, honest inbox status and recovery re-arm. No network, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import * as robust from '../supervisor/robust.mjs';
import { robustnessView } from '../supervisor/dashboard.mjs';

const NOW0 = 1_800_000_000_000, MIN = 60000;
const cfg = (limits = {}) => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, ...limits },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
function world(t, { limits, jobsExtra = {}, git = {}, gh = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rob-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { t: NOW0, now: () => clock.t };
  const records = {}, stopped = [];
  const jobs = { listActive: async () => Object.values(records).filter(r => r.status === 'running').map(r => ({ id: r.id, status: r.status, provider: 'claude' })),
    get: async id => records[id] || null, stop: async (id, reason) => { stopped.push({ id, reason }); records[id].status = 'stopped'; records[id].lastEvent = reason; },
    transcriptMtime: async id => records[id]?.mtime ?? null, ...jobsExtra };
  const team = new Team({ config: cfg(limits), root: stateRoot(path.join(dir, 'state')), gh: { getPull: async () => null, ...gh }, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null, ...git }, register: '', clock });
  return { dir, clock, records, stopped, team, root: stateRoot(path.join(dir, 'state')) };
}
const H = n => String(n).repeat(40).slice(0, 40);

// 1. liveness
test('idleJobs: only a job past the limit with a known activity time is returned', () => {
  const r = robust.idleJobs({ running: [{ id: 'a', lastActivityAt: NOW0 - 46 * MIN }, { id: 'b', lastActivityAt: NOW0 - 44 * MIN }, { id: 'c', lastActivityAt: null }], now: NOW0, limitMs: 45 * MIN });
  assert.deepEqual(r.map(x => x.id), ['a']);
});
test('lastActivityAt takes the newest of progress, update, creation and transcript growth', () => {
  assert.equal(robust.lastActivityAt({ lastProgress: 5, updatedAt: 9, createdAt: 1 }, 20), 20);
  assert.equal(robust.lastActivityAt({}, null), null);
});
test('a running job with no activity past the limit is cancelled through stop, the reason is recorded and shown; an active one is left alone', async t => {
  const w = world(t, { limits: { job_idle_minutes: 30 } });
  w.records.idle1 = { id: 'idle1', status: 'running', kind: 'implement', createdAt: NOW0 - 3 * 3600000, updatedAt: NOW0 - 2 * 3600000, mtime: NOW0 - 2 * 3600000 };
  w.records.busy1 = { id: 'busy1', status: 'running', kind: 'implement', createdAt: NOW0 - 3 * 3600000, updatedAt: NOW0 - 2 * 3600000, mtime: NOW0 - 5 * MIN };   // the transcript grew 5 minutes ago
  w.team.s.jobs.idle1 = { kind: 'rebase', pr: 7, head: H(1) };
  const report = {}; await w.team.livenessSweep(report);
  assert.deepEqual(w.stopped, [{ id: 'idle1', reason: 'idle_timeout' }]);
  assert.match(report.liveness[0].reason, /no activity for 120 minutes \(limit 30\); cancelled and requeued/);
  assert.equal(w.team.s.jobs.idle1.idleCancelled.idleMs, 2 * 3600000);
  assert.equal(w.team.s.liveness.running.busy1.lastActivityAt, NOW0 - 5 * MIN);
  const v = robustnessView(w.team.s, w.team, [w.records.busy1], NOW0);
  assert.equal(v.limitMinutes, 30); assert.equal(v.running[0].idleMs, 5 * MIN); assert.equal(v.cancelled.length, 1);
  assert.equal(w.team.s.sameCause['rebase:7'].cause, 'idle_timeout', 'the cancel counts as one failed attempt');
});
test('a failing stop is reported and nothing is recorded as cancelled', async t => {
  const w = world(t, { limits: { job_idle_minutes: 30 }, jobsExtra: { stop: async () => { throw new Error('cannot stop'); } } });
  w.records.x = { id: 'x', status: 'running', createdAt: NOW0 - 3600000, updatedAt: NOW0 - 3600000 };
  const report = {}; await w.team.livenessSweep(report);
  assert.match(report.skipped[0].reason, /cannot stop/); assert.deepEqual(w.team.s.liveness.cancelled, []);
});
test('job_idle_minutes and max_same_cause_attempts are validated', () => {
  assert.doesNotThrow(() => validateTeamConfig(cfg({ job_idle_minutes: 20, max_same_cause_attempts: 2 })));
  for (const bad of [{ job_idle_minutes: 0 }, { job_idle_minutes: 'x' }, { max_same_cause_attempts: 0 }, { max_same_cause_attempts: 1.5 }]) assert.throws(() => validateTeamConfig(cfg(bad)), /invalid team limit/);
});

// 2. rebase precheck
test('rebaseNeeded: only a clean dry-run plus a mergeable, not-behind PR needs no agent; unknowns fail open', () => {
  const ok = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  assert.equal(robust.rebaseNeeded({ probe: { conflicts: false }, pull: ok }).needed, false);
  assert.equal(robust.rebaseNeeded({ probe: { conflicts: true }, pull: ok }).needed, true);
  assert.equal(robust.rebaseNeeded({ probe: { conflicts: false }, pull: { ...ok, mergeStateStatus: 'BEHIND' } }).needed, true);
  assert.equal(robust.rebaseNeeded({ probe: { conflicts: false }, pull: { ...ok, mergeable: 'CONFLICTING' } }).needed, true);
  assert.equal(robust.rebaseNeeded({ probe: null, pull: ok }).needed, true);
  assert.equal(robust.rebaseNeeded({ probe: { conflicts: false }, pull: null }).needed, true);
});
const act = { type: 'rebase', pr: 7, head: H(1), base: 'main', branch: 'claude/issue-1-a', key: `7:${H(1)}`, agent: 'claude' };
test('no rebase agent starts when the cheap check shows nothing to do, and no attempt is counted', async t => {
  const w = world(t, { git: { mergeProbe: async () => ({ conflicts: false }) }, gh: { getPull: async () => ({ headRefOid: H(1), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }) } });
  const report = {}; assert.equal(await w.team.rebaseSkippable(act, report), true);
  assert.match(report.skipped[0].reason, /no agent started/); assert.ok(w.team.s.rebaseSkipped[act.key]);
  assert.equal(w.team.s.rebaseAttempts[act.key] || 0, 0);
});
test('the rebase agent is still needed on a real conflict, a probe failure, or a moved head', async t => {
  const pull = { headRefOid: H(1), mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  let w = world(t, { git: { mergeProbe: async () => ({ conflicts: true }) }, gh: { getPull: async () => pull } });
  assert.equal(await w.team.rebaseSkippable(act, {}), false);
  w = world(t, { git: { mergeProbe: async () => { throw new Error('boom'); } }, gh: { getPull: async () => pull } });
  assert.equal(await w.team.rebaseSkippable(act, {}), false);
  w = world(t, { git: { mergeProbe: async () => ({ conflicts: false }) }, gh: { getPull: async () => ({ ...pull, headRefOid: H(2) }) } });
  assert.equal(await w.team.rebaseSkippable(act, {}), false);
  w = world(t); assert.equal(await w.team.rebaseSkippable(act, {}), false, 'no probe available: the agent runs');
});

// 3. retry cap
test('the same cause twice on the same head stops the item; a different cause, a new head or a success starts again', () => {
  const s = {}, k = { type: 'rebase', subject: 7, head: H(1) };
  robust.noteFailure(s, { ...k, cause: 'postcondition_not_met' }, NOW0);
  assert.equal(robust.capped(s, k, 2), false);
  robust.noteFailure(s, { ...k, cause: 'postcondition_not_met' }, NOW0);
  assert.equal(robust.capped(s, k, 2), true);
  assert.equal(robust.capped(s, { ...k, head: H(2) }, 2), false, 'a new head is progress');
  assert.equal(robust.capped(s, { ...k, type: 'fix' }, 2), false, 'per job type');
  robust.noteFailure(s, { ...k, cause: 'crash' }, NOW0); assert.equal(robust.capped(s, k, 2), false, 'a different cause restarts the count');
  robust.noteFailure(s, { ...k, cause: 'crash' }, NOW0); assert.equal(robust.capped(s, k, 2), true);
  robust.noteSuccessFor(s, k); assert.equal(robust.capped(s, k, 2), false);
});
test('a capped item is dropped from the plan, held, and listed as a Needs you item; other PRs and merges pass', async t => {
  const w = world(t);
  for (let i = 0; i < 2; i++) robust.noteFailure(w.team.s, { type: 'rebase', subject: 7, cause: 'postcondition_not_met', head: H(1) }, NOW0);
  const actions = [act, { ...act, pr: 8, key: `8:${H(1)}` }, { type: 'merge', pr: 7, head: H(1) }];
  const report = {}, kept = w.team.applyRetryCap(actions, report);
  assert.deepEqual(kept.map(a => `${a.type}:${a.pr}`), ['rebase:8', 'merge:7']);
  assert.equal(report.retryCapped[0].cause, 'postcondition_not_met');
  const items = w.team.retryCapItems(); assert.equal(items.length, 1); assert.equal(items[0].attempts, 2);
});
test('ingest counts a failed job by its cause; two in a row cap the item, a homeowner stop does not count', async t => {
  const w = world(t);
  const finish = (id, status, extra, rec) => { w.records[id] = { id, status, ...extra }; w.team.s.jobs[id] = { kind: 'rebase', pr: 7, head: H(1), agent: 'claude', key: act.key, ...rec }; };
  finish('a', 'blocked', { lastEvent: 'incomplete', incompleteReason: { cause: 'postcondition_not_met' } });
  finish('b', 'blocked', { lastEvent: 'incomplete', incompleteReason: { cause: 'postcondition_not_met' } });
  finish('c', 'stopped', { lastEvent: 'manual_stop' });
  for (const id of ['a', 'b', 'c']) await w.team.ingestOneInner(id, w.team.s.jobs[id], { ingested: [] }).catch(() => {});
  assert.equal(w.team.s.sameCause['rebase:7'].count, 2);
  assert.equal(w.team.retryCapItems().length, 1);
});

// 4. honest status
test('inboxOutcome: an explicit failure, nothing-changed status or a "nothing changed" summary is not done', () => {
  assert.equal(robust.inboxOutcome('STATUS: done\nAdded the file.').ok, true);
  assert.equal(robust.inboxOutcome('Added the file and opened a PR.').ok, true);
  assert.equal(robust.inboxOutcome('STATUS: nothing_changed\nThe file already existed.').ok, false);
  assert.equal(robust.inboxOutcome('STATUS: failed\nTests broke.').ok, false);
  assert.equal(robust.inboxOutcome('Nothing was changed because the target is gone.').ok, false);
  assert.equal(robust.inboxOutcome('   ').ok, false);
});
test('a finished inbox prompt that changed nothing ends failed with its summary in the Inbox; a real result ends done', async t => {
  const w = world(t);
  const inboxDir = path.join(w.dir, 'inbox'); fs.mkdirSync(path.join(inboxDir, 'status'), { recursive: true }); fs.mkdirSync(path.join(inboxDir, 'items'), { recursive: true }); w.team.inboxDir = () => inboxDir;
  const store = await import('../supervisor/inbox.mjs');
  const cases = [['a'.repeat(32), 'STATUS: nothing_changed\nThe change was already on main.', 'failed'], ['b'.repeat(32), 'STATUS: done\nAdded the file.', 'done']];
  for (const [id, text, want] of cases) {
    const ticket = 't-' + want; fs.mkdirSync(path.join(w.team.dir, 'inbox', ticket), { recursive: true });
    fs.writeFileSync(path.join(w.team.dir, 'inbox', ticket, 'inbox-result.txt'), text);
    w.team.ingestInbox(id, { inboxId: id, ticket }, { status: 'completed', updatedAt: NOW0 });
    const st = store.statusOf(inboxDir, id);
    assert.equal(st.state, want);
    if (want === 'failed') { assert.match(st.result, /changed nothing/); assert.match(st.result, /Agent summary: STATUS: nothing_changed/); assert.match(st.reason, /changed nothing/); }
    else assert.match(st.result, /Added the file/);
  }
  // a job that did not complete is failed too
  w.team.ingestInbox('c'.repeat(32), { inboxId: 'c'.repeat(32), ticket: 'none' }, { status: 'blocked', updatedAt: NOW0 });
  assert.equal(store.statusOf(inboxDir, 'c'.repeat(32)).state, 'failed');
});

// 5. re-arm
test('rearmUpgradeState clears the fetch backoff, the install retry wait and an environmental pre-check wait once per marker', () => {
  const s = { fetchRetryAt: NOW0 + 3600000, fetchFailures: 4, install: { result: 'transient', sha: 'abc', nextAttemptAt: NOW0 + 3600000, attempts: 3 }, prechecked: { abc: { at: NOW0, environmental: true, attempts: 3 }, def: NOW0 } };
  const done = robust.rearmUpgradeState(s, { at: NOW0 }, NOW0);
  assert.deepEqual(done.sort(), ['GitHub fetch backoff', 'install pre-check wait', 'install retry']);
  assert.equal(s.fetchRetryAt, undefined); assert.equal(s.install.nextAttemptAt, NOW0); assert.deepEqual(Object.keys(s.prechecked), ['def']);
  s.install.nextAttemptAt = NOW0 + 99; assert.deepEqual(robust.rearmUpgradeState(s, { at: NOW0 }, NOW0 + 5), [], 'the same marker applies once');
  assert.deepEqual(robust.rearmUpgradeState({}, null, NOW0), []);
});
test('a halt that clears writes the re-arm marker once and is visible in state; a halt still held does not', async t => {
  const w = world(t);
  w.team.s.breaker.halts = { context_too_large: { since: NOW0, types: ['rebase'], prs: [7] } };
  const report = {}; w.team.rearmOnRecovery(report); assert.equal(robust.readRearm(w.root), null, 'still held: no re-arm');
  w.team.s.breaker.halts = {};
  w.team.rearmOnRecovery(report);
  assert.deepEqual(robust.readRearm(w.root).scopes, ['context_too_large']);
  assert.deepEqual(w.team.s.rearm.scopes, ['context_too_large']); assert.equal(report.rearmed.length, 1);
  const again = {}; w.team.rearmOnRecovery(again); assert.equal(again.rearmed, undefined, 'nothing new cleared');
});
