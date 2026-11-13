// Issue #1171 (D-040): a parked pull request or issue holds the cancelled-CI watch, the one transient resume and the owner re-review.
// Each case runs the real Team method against a fake GitHub and fake jobs, once parked and once not parked, and checks both outcomes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { isParked, jobTargetParked } from '../supervisor/parkhold.mjs';

const HEAD = '1'.repeat(40), NOW = 1_800_000_000_000;
const RUN = { detailsUrl: 'https://github.com/o/r/actions/runs/777/job/1' };
const cancelled = [{ status: 'COMPLETED', conclusion: 'CANCELLED', name: 'test', workflowName: 'CI', startedAt: '2026-11-01T10:00:00Z', ...RUN }];
const green = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z' }];
const config = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';
const pr = (labels, extra = {}) => ({ number: 10, title: 't', headRefName: 'codex/issue-2-x', headRefOid: HEAD, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',
  statusCheckRollup: green, labels, ...extra });

function world(t, { pulls, issues = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-holds-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { reruns: [], resumed: [], comments: [], labels: [] };
  const gh = { pulls, issues, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues,
    rerunRun: async r => calls.reruns.push(r), comment: async (n, b) => calls.comments.push([n, b]), addLabel: async (n, l) => calls.labels.push([n, l]),
    hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {}, listMergedPulls: async () => [],
    prComments: async () => Object.values(gh.cmts), getComment: async id => gh.cmts[id] || null, cmts: {} };
  const jobs = { states: {}, listActive: async () => [], get: async id => jobs.states[id] || null, resume: async id => { calls.resumed.push(id); } };
  const clock = { t: NOW, now: () => clock.t };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null },
    register: REGISTER, clock, alert: async () => {} });
  return { gh, jobs, team, calls, clock };
}

test('isParked and jobTargetParked: parked and not parked, pull request and issue, nothing found', async () => {
  assert.equal(isParked({ labels: ['parked'] }), true); assert.equal(isParked({ labels: ['x'] }), false);
  assert.equal(isParked({}), false); assert.equal(isParked(undefined), false);
  const gh = { listPulls: async () => [pr(['parked'])], listIssues: async () => [{ number: 3, labels: ['parked'] }, { number: 4, labels: [] }] };
  assert.equal(await jobTargetParked({ pr: 10 }, {}, gh), true);
  assert.equal(await jobTargetParked({ pr: 11 }, {}, gh), false, 'a PR that is not listed');
  assert.equal(await jobTargetParked({ issue: 3 }, {}, gh), true);
  assert.equal(await jobTargetParked({ issue: 4 }, {}, gh), false);
  assert.equal(await jobTargetParked({}, {}, gh), false);
});

for (const parked of [false, true]) {
  test(`watchCancelled: a lone cancelled run on a ${parked ? 'parked' : 'not parked'} PR is ${parked ? 'neither rerun nor noticed, and the watch is kept' : 'rerun once'}`, async t => {
    const w = world(t, { pulls: [pr(parked ? ['parked'] : [], { statusCheckRollup: cancelled })] });
    await w.team.watchCancelled({}); w.clock.t += 10 * 60000; await w.team.watchCancelled({});
    if (parked) {
      assert.deepEqual(w.calls.reruns, []);
      assert.equal(w.team.s.cancelWatch[`10:${HEAD}`], undefined, 'no watch was begun');
    } else assert.deepEqual(w.calls.reruns, ['777']);
    // The watch started before the PR was parked is kept (not pruned) and still makes no rerun.
    if (parked) {
      w.team.s.cancelWatch[`10:${HEAD}`] = { since: NOW };
      w.clock.t += 10 * 60000; await w.team.watchCancelled({});
      assert.deepEqual(w.calls.reruns, []); assert.ok(w.team.s.cancelWatch[`10:${HEAD}`], 'kept while parked');
      w.gh.pulls[0].labels = []; await w.team.watchCancelled({});
      assert.deepEqual(w.calls.reruns, ['777'], 'released: the rerun is made');
    }
  });
}

for (const [targetKind, parked] of [['pr', false], ['pr', true], ['issue', false], ['issue', true]]) {
  test(`resumeTransient: a transient stop on a job for a ${parked ? 'parked' : 'not parked'} ${targetKind} is ${parked ? 'not resumed and the one resume is kept' : 'resumed once'}`, async t => {
    const labels = parked ? ['parked'] : [];
    const w = world(t, { pulls: targetKind === 'pr' ? [pr(labels)] : [], issues: targetKind === 'issue' ? [{ number: 23, state: 'OPEN', title: 'i', body: '', labels }] : [] });
    w.jobs.states.j1 = { id: 'j1', status: 'blocked', lastEvent: 'crash', provider: 'claude', kind: 'review', updatedAt: 0 };
    w.team.s.jobs.j1 = { kind: 'review', agent: 'claude', ...(targetKind === 'pr' ? { pr: 10 } : { issue: 23 }), ingested: true, at: NOW - 1000 };
    await w.team.resumeTransient({ actions: [], notified: [], ingested: [], skipped: [] });
    if (parked) {
      assert.deepEqual(w.calls.resumed, []); assert.equal(w.team.s.unblock.resumed.j1, undefined); assert.equal(w.team.s.unblock.noResume.j1, undefined, 'not marked stale');
      (targetKind === 'pr' ? w.gh.pulls[0] : w.gh.issues[0]).labels = [];
      await w.team.resumeTransient({ actions: [], notified: [], ingested: [], skipped: [] });
    }
    assert.deepEqual(w.calls.resumed, ['j1'], parked ? 'resumed after release' : 'resumed');
  });
}

const D1 = 'https://github.com/o/r/pull/10#issuecomment-111';
const stuck = w => {
  w.team.s.verdicts[`10:${HEAD}`] = { verdict: 'CHANGES', reviewer: 'claude', job: 'j0', findings: [{ kind: 'blocking', text: 'old' }], at: 5 };
  w.team.s.fixAttempts[`10:${'0'.repeat(40)}`] = 2; w.team.s.unblock.escalated[10] = { head: HEAD };
  w.team.s.notified['fixlimit:10'] = 1; w.team.s.notified['fixlimit-alert:10'] = 1; w.team.save();
};
for (const parked of [false, true]) {
  test(`re-review: a decision on a ${parked ? 'parked' : 'not parked'} PR ${parked ? 'is refused and records nothing' : 'requests the re-review'}`, async t => {
    const w = world(t, { pulls: [pr(parked ? ['parked'] : [])] }); stuck(w);
    w.gh.cmts[111] = { login: 'o', createdAt: new Date(NOW).toISOString(), url: D1 };
    if (parked) {
      await assert.rejects(() => w.team.requestReReview(10, D1), /is parked/);
      assert.equal(w.team.s.reReviews[10], undefined, 'no state left behind');
      assert.equal(w.team.s.verdicts[`10:${HEAD}`].verdict, 'CHANGES', 'the verdict is not set aside');
    } else {
      await w.team.requestReReview(10, D1);
      assert.equal(w.team.reReviewOf(10, HEAD).status, 'pending');
    }
  });

  test(`re-review by owner comment: a ${parked ? 'parked' : 'not parked'} PR ${parked ? 'is skipped and the comment is not used up' : 'gets the request from the comment'}`, async t => {
    const w = world(t, { pulls: [pr(parked ? ['parked'] : [])] }); stuck(w);
    w.team.c.owner_comment_review = { enabled: true };
    w.gh.cmts[111] = { login: 'o', createdAt: new Date(NOW).toISOString(), url: D1 };
    const report = { notified: [], skipped: [] };
    await w.team.scanOwnerComments(report);
    if (parked) {
      assert.equal(w.team.s.reReviews[10], undefined); assert.deepEqual(report.notified, []); assert.deepEqual(w.calls.comments, []);
      w.gh.pulls[0].labels = []; await w.team.scanOwnerComments(report);
    }
    assert.equal(w.team.reReviewOf(10, HEAD)?.decision, D1, parked ? 'the same comment counts once released' : 'requested');
  });
}
