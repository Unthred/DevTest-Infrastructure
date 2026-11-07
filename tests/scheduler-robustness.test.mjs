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
  const report = {}; await w.team.rearmOnRecovery(report); assert.equal(robust.readRearm(w.root), null, 'still held: no re-arm');
  w.team.s.breaker.halts = {};
  await w.team.rearmOnRecovery(report);
  assert.deepEqual(robust.readRearm(w.root).scopes, ['context_too_large']);
  assert.deepEqual(w.team.s.rearm.scopes, ['context_too_large']); assert.equal(report.rearmed.length, 1);
  const again = {}; await w.team.rearmOnRecovery(again); assert.equal(again.rearmed, undefined, 'nothing new cleared');
});

// owner comment 1 and the review round
const stoppedImplement = (w, id, lastEvent, extra = {}) => { w.records[id] = { id, status: 'stopped', lastEvent, worktree: '/p/wt5' }; w.team.s.jobs[id] = { kind: 'implement', issue: 5, agent: 'claude', branch: 'claude/issue-5-x', ...extra }; w.team.s.implemented[5] = NOW0; };
const cleanGit = (calls, over = {}) => ({ saveWork: async (wt, o) => { calls.push(['save', wt, o.branch]); return { ref: 'saved/abc-x' }; }, isClean: async () => true, unpushedCommits: async () => 0, removeWorktree: async o => calls.push(['remove', o.worktree, o.branch]), ...over });
test('an idle-cancelled or hand-stopped implement job is backed up, cleaned up and requeueable', async t => {
  for (const ev of ['idle_timeout', 'manual_stop']) {
    const calls = [], w = world(t, { git: cleanGit(calls) });
    stoppedImplement(w, 'i1', ev);
    await w.team.ingestOneInner('i1', w.team.s.jobs.i1, { ingested: [] });
    assert.deepEqual(calls.map(c => c[0]), ['save', 'remove'], 'saved before removed');
    assert.equal(w.team.s.implemented[5], undefined, 'the stale mark is gone');
    assert.match(w.team.s.jobs.i1.stopCleanup.saved, /saved\/abc-x/);
  }
});
test('stop cleanup keeps the worktree and the mark when the work cannot be proven saved, and waits while the process lives', async t => {
  const calls = [], w = world(t, { git: cleanGit(calls, { saveWork: async () => { throw new Error('secret-shaped text'); } }) });
  stoppedImplement(w, 'i1', 'manual_stop'); const report = { ingested: [] };
  await w.team.ingestOneInner('i1', w.team.s.jobs.i1, report);
  assert.ok(w.team.s.implemented[5], 'mark kept'); assert.equal(calls.length, 0); assert.match(report.skipped[0].reason, /secret/);
  const w2 = world(t, { git: cleanGit([]), jobsExtra: { alive: async () => true } });
  stoppedImplement(w2, 'i2', 'idle_timeout'); await w2.team.ingestOneInner('i2', w2.team.s.jobs.i2, { ingested: [] });
  assert.ok(w2.team.s.implemented[5], 'a live process is not cleaned up yet');
});
test('findSessionWriter reads a quiet git commit from the named session log only', async t => {
  const { findSessionWriter } = await import('../supervisor/writerevidence.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-')); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'projects', 'p'); fs.mkdirSync(dir, { recursive: true });
  const row = (cmd, branch) => JSON.stringify({ type: 'assistant', gitBranch: branch, message: { model: 'claude-opus-x', content: [{ type: 'tool_use', id: 't', input: { command: cmd } }] } });
  fs.writeFileSync(path.join(dir, 'abcdef123456.jsonl'), row('git commit -q -m x', 'claude/issue-9-a') + '\n');
  const f = findSessionWriter({ session: 'abcdef123456', branch: 'claude/issue-9-a', home });
  assert.equal(findSessionWriter({ session: 'abcdef123456', branch: 'claude/issue-9-a', home, since: 1000 }), null);   // no timestamp: not shown to be after the head
  const keep = fs.readFileSync(path.join(dir, 'abcdef123456.jsonl'), 'utf8');
  fs.writeFileSync(path.join(dir, 'abcdef123456.jsonl'), JSON.stringify({ ...JSON.parse(row('git push -q', 'claude/issue-9-a')), timestamp: new Date(5000).toISOString() }) + '\n');
  assert.ok(findSessionWriter({ session: 'abcdef123456', branch: 'claude/issue-9-a', home, since: 4000 }));
  assert.equal(findSessionWriter({ session: 'abcdef123456', branch: 'claude/issue-9-a', home, since: 6000 }), null);   // wrote an earlier head only
  fs.writeFileSync(path.join(dir, 'abcdef123456.jsonl'), keep);
  assert.deepEqual(f.models, ['claude-opus-x']); assert.equal(f.sessions[0], 'abcdef12');
  assert.equal(findSessionWriter({ session: 'abcdef123456', branch: 'claude/other', home }), null);
  assert.equal(findSessionWriter({ session: '../../etc', branch: 'claude/issue-9-a', home }), null);
});
test('record-writer binds the session writer to the current head of a configured agent branch', async t => {
  const w = world(t, { gh: { getPull: async () => ({ number: 9, headRefName: 'claude/issue-9-a', headRefOid: H(3) }), commitTime: async () => 5000 } });
  let seenSince = null;
  w.team.sessionWriterOf = ({ session, since }) => (seenSince = since, session === 'good12345') ? { provider: 'claude', models: ['m1'], sessions: ['good1234'] } : null;
  const r = await w.team.recordSessionWriter(9, 'good12345');
  assert.equal(r.head, H(3)); assert.deepEqual(w.team.s.headWriters[`9:${H(3)}`].models, ['m1']);
  assert.equal(seenSince, 5000);
  await assert.rejects(() => w.team.recordSessionWriter(9, 'unknown123'), /nothing is recorded/);
  w.team.s.headWriters[`9:${H(3)}`] = { provider: 'claude', models: ['m0'], sessions: [], at: 1, source: 'session-log' };   // an existing record is merged, never replaced
  const r2 = await w.team.recordSessionWriter(9, 'good12345');
  assert.deepEqual(r2.models, ['m0', 'm1']); assert.equal(w.team.s.headWriters[`9:${H(3)}`].source, 'session-log');
  w.team.gh.commitTime = async () => { throw new Error('x'); };
  await assert.rejects(() => w.team.recordSessionWriter(9, 'good12345'), /could not be read/);
});
test('a recovery re-arms queued job backoff and a blocked install', async t => {
  const moved = [], w = world(t, { jobsExtra: { listActive: async () => [{ id: 'q1abcdefgh', status: 'queued' }, { id: 'r1', status: 'running' }], rearm: async id => { moved.push(id); return true; } } });
  w.team.s.breaker.halts = { c: { since: NOW0, types: ['rebase'], prs: [7] } }; await w.team.rearmOnRecovery({});
  w.team.s.breaker.halts = {}; await w.team.rearmOnRecovery({});
  assert.deepEqual(moved, ['q1abcdefgh']); assert.ok(w.team.s.rearm.items.includes('job q1abcdef'));
  const s = { install: { result: 'blocked', sha: 'abc', reason: 'disk full' }, prechecked: { abc: NOW0 } };
  assert.deepEqual(robust.rearmUpgradeState(s, { at: NOW0 }, NOW0), ['blocked install']);
  assert.equal(s.install.nextAttemptAt, NOW0); assert.deepEqual(s.prechecked, {});
});
