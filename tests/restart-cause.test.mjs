// Issue #1423: a rebase that ended on a recorded refusal or agent stop is never resumed by the transient rule, and every restart of a job
// records its cause. Real Team resume pass with a fake job store, real recover() for the event, real listing of the code's restart callers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot, recover, saveJob } from '../supervisor/core.mjs';
import { jobOutcome } from '../supervisor/joboutcome.mjs';
import { normalizeCause } from '../supervisor/restartcause.mjs';

const HEAD = '1'.repeat(40), NOW = 1_800_000_000_000, JOB = '46c5d55f' + '0'.repeat(24);
const SOURCE = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'supervisor');
const green = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z' }];
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const tmp = t => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'restart-cause-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

function world(t) {
  const dir = tmp(t), calls = { resumed: [] };
  const pulls = [{ number: 1324, title: 't', headRefName: 'codex/issue-2-x', headRefOid: HEAD, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [] }];
  const gh = { listPulls: async () => pulls, listIssues: async () => [], getPull: async n => pulls.find(p => p.number === n) || null, addLabel: async () => {}, comment: async () => {},
    hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {}, listMergedPulls: async () => [], prComments: async () => [], getComment: async () => null };
  const jobs = { states: {}, listActive: async () => [], get: async id => jobs.states[id] || null, resume: async (id, cause) => { calls.resumed.push({ id, cause }); } };
  const clock = { t: NOW, now: () => clock.t };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null },
    register: '## D-020 — x\n- Status: homeowner-approved\n', clock, alert: async () => {} });
  return { team, jobs, calls };
}
const pass = w => w.team.resumeTransient({ actions: [], notified: [], ingested: [], skipped: [] });
const record = (w, job, extra = {}) => {
  w.jobs.states[JOB] = { id: JOB, status: 'blocked', lastEvent: 'incomplete', provider: 'claude', kind: 'rebase', updatedAt: 0, ...job };
  w.team.s.jobs[JOB] = { kind: 'rebase', agent: 'claude', pr: 1324, head: HEAD, ingested: true, at: NOW - 1000, ...extra };
};

test('job 46c5d55f on PR #1324 (rebase, agent stop recorded) is not resumed and is marked never to resume with the reason', async t => {
  const w = world(t);
  record(w, { rebaseRefused: 'agent-stop' });
  await pass(w);
  assert.deepEqual(w.calls.resumed, []);
  assert.match(w.team.s.unblock.noResume[JOB].why, /agent stop.*a retry gives the same result/);
  assert.equal(w.team.s.unblock.resumed[JOB], undefined);
});

test('a refused rebase is not resumed even when its unblock allowance is free', async t => {
  const w = world(t);
  record(w, { rebaseRefused: 'lost-changes' });
  assert.equal(w.team.unblockRoom(1324), null, 'the allowance is free');
  await pass(w);
  assert.deepEqual(w.calls.resumed, []);
  assert.match(w.team.s.unblock.noResume[JOB].why, /refusal \(lost-changes\)/);
  assert.equal(w.team.willResume(JOB, w.jobs.states[JOB], w.team.s.jobs[JOB]), false);
});

test('a rebase that ended incomplete with no recorded refusal is resumed once, naming the transient rule', async t => {
  const w = world(t);
  record(w, {});
  await pass(w);
  assert.deepEqual(w.calls.resumed, [{ id: JOB, cause: { who: 'Foreman rule', which: 'resumeTransient' } }]);
  await pass(w);
  assert.equal(w.calls.resumed.length, 1, 'only once');
});

test('a job stopped by a rate limit event is resumed once', async t => {
  const w = world(t);
  record(w, { lastEvent: 'transient_rate_limit', kind: 'review' }, { kind: 'review' });
  await pass(w);
  assert.equal(w.calls.resumed.length, 1);
  assert.equal(w.calls.resumed[0].cause.which, 'resumeTransient');
});

function realRestart(t, cause) {
  const root = stateRoot(path.join(tmp(t), 'state'));
  saveJob(root, { id: JOB, status: 'blocked', kind: 'rebase', leases: [], capabilities: {} }, undefined, true);
  if (cause === undefined) recover(root, JOB, false); else recover(root, JOB, false, cause);
  return { root, events: fs.readFileSync(path.join(root, 'events', `${JOB}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l)) };
}

test('recover stores who and which: a homeowner command records the command name', t => {
  const { root, events } = realRestart(t, { who: 'homeowner command', which: 'resume' });
  assert.deepEqual(events.find(e => e.kind === 'recovered').detail.cause, { who: 'homeowner command', which: 'resume' });
  const outcome = jobOutcome(root, JOB);
  assert.deepEqual(outcome.events.find(e => e.kind === 'recovered').cause, { who: 'homeowner command', which: 'resume' });
});

test('a restart call with no cause is recorded as cause not given', t => {
  for (const given of [undefined, null, {}, { who: 'someone', which: 'x' }, { who: 'Foreman rule', which: '  ' }]) {
    const { events } = realRestart(t, given);
    assert.deepEqual(events.find(e => e.kind === 'recovered').detail.cause, { who: 'cause not given', which: 'cause not given' });
  }
  assert.deepEqual(normalizeCause({ who: 'Inbox action', which: 'resume_job' }), { who: 'Inbox action', which: 'resume_job' });
});

// The listing: every call that restarts a job (recover, jobs.resume) in the supervisor passes a cause. A new caller without one fails here.
const callersIn = (name, text) => {
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(export\s+)?(async\s+)?function recover\b/.test(line) || /^\s*resume: async/.test(line)) return;   // the definitions
    for (const m of line.matchAll(/(?<![\w.])recover\(([^)]*)\)|\bjobs\.resume\(([^)]*)\)/g)) out.push({ at: `${name}:${i + 1}`, args: m[1] ?? m[2] });
  });
  return out;
};
const withoutCause = callers => callers.filter(c => !/who:\s*'|CAUSE\.\w+|,\s*cause\s*$/.test(c.args)).map(c => c.at);

test('every caller in the code that restarts a job passes a cause', () => {
  const callers = fs.readdirSync(SOURCE).filter(n => n.endsWith('.mjs') && n !== 'upgrade.mjs').flatMap(n => callersIn(n, fs.readFileSync(path.join(SOURCE, n), 'utf8')));
  assert.ok(callers.length >= 5, `found the restart callers (${callers.length})`);
  assert.deepEqual(withoutCause(callers), [], 'callers without a cause');
});

test('the listing check fails for a caller that passes no cause', () => {
  const bad = callersIn('x.mjs', "recover(root, id, false);\nawait this.jobs.resume(id);\nawait this.jobs.resume(id, { who: 'Inbox action', which: 'a' });");
  assert.deepEqual(withoutCause(bad), ['x.mjs:1', 'x.mjs:2']);
});
