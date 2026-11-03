// Foreman re-review after a homeowner decision (issue #366): fake GitHub, fake jobs, fake clock. No model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z' }];
const D1 = 'https://github.com/o/r/issues/38#issuecomment-111', D2 = 'https://github.com/o/r/issues/38#issuecomment-222';
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { fix: { model: 'sonnet' }, strong: { model: 'opus' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 're-review-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [], removed: [], merges: [], created: [] };
  const gh = {
    pulls: [{ number: 38, title: 't', headRefName: 'claude/issue-23-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green }],
    listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [{ number: 23, title: 'Issue 23', state: 'CLOSED', body: '', labels: [] }],
    comment: async (n, body) => calls.comments.push([n, body]), addLabel: async (n, l) => calls.labels.push([n, l]), removeLabel: async (n, l) => calls.removed.push([n, l]),
    hasComment: async (n, text) => calls.comments.some(c => c[0] === n && c[1].includes(text)), findIssueByMarker: async () => null, createIssue: async () => 1,
    merge: async (n, head) => { calls.merges.push([n, head]); }, board: async () => {}, listMergedPulls: async () => []
  };
  const jobs = { states: {}, seq: 0, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const root = stateRoot(path.join(dir, 'state')), clock = { t: 1_000_000, now: () => clock.t };
  const make = () => new Team({ config: config(), root, gh, jobs, git, register: REGISTER, clock, alert: async () => {} });
  return { gh, jobs, calls, clock, root, make, team: make() };
}
// The fix limit is reached on a CHANGES verdict that was already announced to the homeowner (label and notice).
function stuck(w) {
  w.team.s.verdicts[`38:${H(1)}`] = { verdict: 'CHANGES', reviewer: 'codex', job: 'j0', findings: [{ kind: 'blocking', text: 'old problem' }], at: 5 };
  w.team.s.fixAttempts[`38:${H(0)}`] = 2;
  w.team.s.unblock.escalated[38] = { head: H(1) };
  w.team.s.notified['fixlimit:38'] = 1; w.team.s.notified['fixlimit-alert:38'] = 1;
  w.team.save();
}
const finish = async (w, verdict, findings = []) => {
  const [id, rec] = Object.entries(w.team.s.jobs).at(-1);
  const d = path.join(w.team.dir, 'inbox', rec.ticket); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify({ pr: rec.pr, headSha: rec.head, verdict, findings, commandsRun: ['node --test'] }));
  w.jobs.states[id].status = 'completed'; await w.team.ingest({ ingested: [] });
};
const needsHomeowner = w => w.calls.labels.filter(l => l[1] === 'needs-homeowner').length + w.calls.comments.filter(c => /Needs the homeowner/.test(c[1])).length;

test('request: sets the old verdict aside, runs one review of the same head with the decision linked, and adds no needs-homeowner', async t => {
  const w = world(t); stuck(w);
  assert.equal((await w.team.plan()).some(a => a.type === 'review'), false, 'no review of a rejected head');
  await w.team.requestReReview(38, D1);
  assert.equal(w.team.s.verdicts[`38:${H(1)}`], undefined, 'not a pass: the verdict is gone, not replaced');
  assert.match(w.calls.comments.at(-1)[1], /not a pass/);
  await w.team.tick();
  const spec = w.calls.created.find(s => s.kind === 'review');
  assert.ok(spec, 'a review job starts'); assert.match(spec.prompt, new RegExp(D1.replace(/[.#]/g, '\\$&'))); assert.match(spec.prompt, /this same head/);
  assert.equal(spec.agent === 'codex' || spec.provider === 'codex', true, 'an independent reviewer, not the author');
  const [, rec] = Object.entries(w.team.s.jobs).at(-1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.team.dir, 'inbox', rec.ticket, 'homeowner-decision.json'), 'utf8')).decision, D1);
  assert.equal(w.team.stallReasons(w.gh.pulls[0]).some(r => r.code === 're-review-requested'), true);
  assert.deepEqual(w.calls.merges, []); assert.equal(needsHomeowner(w), 0);
});

test('verdicts: a PASS goes through the usual merge gates; a CHANGES stays a rejection and raises nothing new', async t => {
  const pass = world(t); stuck(pass); await pass.team.requestReReview(38, D1); await pass.team.tick(); await finish(pass, 'PASS');
  assert.equal(pass.team.s.verdicts[`38:${H(1)}`].verdict, 'PASS'); assert.equal(pass.team.reReviewOf(38, H(1)).status, 'done');
  assert.equal(needsHomeowner(pass), 0);

  const bad = world(t); stuck(bad); await bad.team.requestReReview(38, D1); await bad.team.tick(); await finish(bad, 'CHANGES', [{ kind: 'blocking', text: 'still wrong' }]);
  const n = bad.calls.created.length;
  await bad.team.tick(); await bad.team.tick();
  assert.equal(bad.team.s.verdicts[`38:${H(1)}`].verdict, 'CHANGES');
  assert.equal(bad.calls.created.length, n, 'no further fix or review job');
  assert.equal(needsHomeowner(bad), 0, 'needs-homeowner is not added again');
  assert.equal(bad.team.stallReasons(bad.gh.pulls[0]).some(r => r.code === 're-review-changes'), true);
  assert.deepEqual(bad.calls.merges, []);
});

test('repeats: refused without a new decision, allowed once with one, never while pending', async t => {
  const w = world(t); stuck(w);
  await w.team.requestReReview(38, D1);
  await assert.rejects(() => w.team.requestReReview(38, D2), /already requested/, 'pending');
  await w.team.tick(); await finish(w, 'CHANGES', [{ kind: 'blocking', text: 'still wrong' }]);
  await assert.rejects(() => w.team.requestReReview(38, D1), /already used/, 'same decision');
  await w.team.requestReReview(38, D2);   // a new decision
  assert.equal(w.team.s.reReviews[38].requests.length, 2);
  await w.team.tick(); await finish(w, 'CHANGES', [{ kind: 'blocking', text: 'again' }]);
  await assert.rejects(() => w.team.requestReReview(38, D2), /already used/);
});

test('refusals: not CHANGES, rounds left, unreadable link, another repository, unknown PR, draft', async t => {
  const w = world(t);
  await assert.rejects(() => w.team.requestReReview(38, D1), /no CHANGES verdict/);
  stuck(w); w.team.s.fixAttempts[`38:${H(0)}`] = 1; w.team.save();
  await assert.rejects(() => w.team.requestReReview(38, D1), /fix rounds left/);
  w.team.s.fixAttempts[`38:${H(0)}`] = 2;
  for (const bad of ['', 'trust me', 'https://github.com/other/repo/issues/1#issuecomment-1', 'https://evil.example/o/r/issues/1', `${D1} && rm -rf`]) await assert.rejects(() => w.team.requestReReview(38, bad), /decision must be a link/);
  await assert.rejects(() => w.team.requestReReview(99, D1), /not open/);
  w.gh.pulls[0].isDraft = true; await assert.rejects(() => w.team.requestReReview(38, D1), /draft/);
  assert.ok(w.team.s.verdicts[`38:${H(1)}`], 'a refused request changes nothing');
  w.gh.pulls[0].isDraft = false; w.team.s.verdicts[`38:${H(1)}`].verdict = 'PASS';
  await assert.rejects(() => w.team.requestReReview(38, D1), /\(it is PASS\)/);
});

test('restart: a pending request, a finished one and the used decisions survive a new Team on the same state', async t => {
  const w = world(t); stuck(w); await w.team.requestReReview(38, D1);
  let again = w.make();
  assert.equal(again.reReviewOf(38, H(1)).status, 'pending'); assert.equal(again.s.verdicts[`38:${H(1)}`], undefined);
  await assert.rejects(() => again.requestReReview(38, D2), /already requested/);
  await again.tick(); assert.equal(w.calls.created.filter(s => s.kind === 'review').length, 1);
  await again.tick(); assert.equal(w.calls.created.filter(s => s.kind === 'review').length, 1, 'one review, not one per tick');
  Object.assign(w.team, { s: again.s, dir: again.dir }); await finish(w, 'CHANGES', [{ kind: 'blocking', text: 'x' }]);
  again = w.make();
  assert.equal(again.reReviewOf(38, H(1)).status, 'done');
  await assert.rejects(() => again.requestReReview(38, D1), /already used/);
  const before = needsHomeowner(w); await again.tick(); assert.equal(needsHomeowner(w), before);
});

test('stall reasons (the dashboard waiting text): pending, then still rejected after the re-review', async t => {
  const w = world(t); stuck(w); await w.team.requestReReview(38, D1);
  const codes = () => w.team.stallReasons(w.gh.pulls[0]).map(r => r.code);
  assert.ok(codes().includes('re-review-requested')); assert.ok(!codes().includes('changes'));
  await w.team.tick(); await finish(w, 'CHANGES', [{ kind: 'blocking', text: 'x' }]);
  assert.ok(codes().includes('re-review-changes')); assert.ok(!codes().includes('re-review-requested'));
  assert.match(w.team.stallReasons(w.gh.pulls[0]).find(r => r.code === 're-review-changes').text, /needs the homeowner/);
});
