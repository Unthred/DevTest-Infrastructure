// Issue #1419: a fix round review is given the change since the reviewed head and carries the untouched requirement rows.
// Real data: PR #1367 (merged 14 Nov 2026 after five reviews). Fake GitHub, fake jobs, fake git, no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { markRow, markRows, countMarks, buildScope, carriedRowError, filesNamedIn } from '../supervisor/reviewscope.mjs';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/review-scope-pr1367.json', import.meta.url), 'utf8'));
const OLD = FIX.reviewedHead, NEW = FIX.fixHead;
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: agent-proposal\n';
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });

// A Team pass whose pull request head is NEW, an earlier CHANGES verdict on OLD, and a completed fix job.
function world(t, { earlier = FIX.requirements, changed = FIX.fixFiles, withIssue = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-scope-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], created: [] };
  const pull = { number: 10, title: 't10', headRefName: 'codex/issue-2-x', headRefOid: NEW, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green };
  const gh = { pulls: [pull], listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [],
    listMergedPulls: async () => [], comment: async (n, body) => calls.comments.push([n, body]), addLabel: async () => {}, hasComment: async () => false,
    findIssueByMarker: async () => null, board: async () => {}, createIssue: async () => 200 };
  if (withIssue) { gh.getIssue = async () => ({ number: 2, title: 'Carry', body: 'Wanted: ALPHA', authorAssociation: 'OWNER' }); gh.issueComments = async () => []; }
  const jobs = { active: [], states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null, changedFiles: async (a, b) => { calls.diff = [a, b]; return changed; } };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 1000 } });
  team.s.verdicts[`10:${OLD}`] = { verdict: 'CHANGES', reviewer: 'claude', at: 1, findings: FIX.blocking, ...(earlier ? { requirements: earlier } : {}) };
  team.s.jobs.fix1 = { kind: 'fix', pr: 10, head: OLD, at: 2 };
  jobs.states.fix1 = { status: 'completed' };
  return { team, calls, jobs, git };
}
const launch = async w => {
  await w.team.execute((await w.team.plan())[0]);
  const spec = w.calls.created.at(-1), inbox = path.join(w.team.dir, 'inbox', spec.postcondition.ticket);
  const scopeFile = path.join(inbox, 'review-scope.json');
  return { spec, inbox, scope: fs.existsSync(scopeFile) ? JSON.parse(fs.readFileSync(scopeFile, 'utf8')) : null, rec: Object.values(w.team.s.jobs).at(-1) };
};
const finish = async (w, rec, v) => {
  const [id] = Object.entries(w.team.s.jobs).at(-1);
  const d = path.join(w.team.dir, 'inbox', rec.ticket); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify({ pr: 10, headSha: NEW, findings: [], commandsRun: ['node --test'], descriptionClaims: [], ...v }));
  w.jobs.states[id].status = 'completed'; const report = { ingested: [] }; await w.team.ingest(report); return report;
};
const copy = rows => rows.map(r => ({ requirement: r.requirement, status: r.status, evidence: `${r.evidence} (carried from the earlier head ${OLD.slice(0, 12)})` }));
const marksOf = scope => Object.fromEntries(scope.requirements.map(r => [r.requirement.slice(0, 2), r.mark]));

test('marking: a fix touching one file rechecks the rows citing it and carries the rest', () => {
  const rows = markRows(FIX.requirements, ['supervisor/agenticon.mjs']);
  const byNumber = n => rows.find(r => r.requirement.startsWith(`${n}.`));
  assert.equal(byNumber(3).mark, 'recheck', 'not met and cites agenticon.mjs');
  assert.equal(byNumber(1).mark, 'carried', 'cites agent-icon.mjs, not agenticon.mjs');
  assert.equal(byNumber(2).mark, 'carried', 'cites agenticon-file.mjs, a different file');
});

test('marking: a fix touching no cited file carries every met row; unmet and file-less rows are rechecked', () => {
  const rows = markRows(FIX.requirements, ['README.md']);
  for (const r of rows) {
    const expectRecheck = r.status !== 'met' || filesNamedIn(r.evidence).length === 0;
    assert.equal(r.mark, expectRecheck ? 'recheck' : 'carried', r.requirement.slice(0, 40));
  }
  assert.ok(rows.some(r => r.mark === 'carried'));
  assert.deepEqual(markRow({ requirement: 'x', status: 'met', evidence: 'the diff adds only small changes' }, []).mark, 'recheck');
  assert.equal(markRow({ requirement: 'x', status: 'met', evidence: 'src/a.mjs:3' }, ['src/a.mjs']).mark, 'recheck');
  assert.equal(markRow({ requirement: 'x', status: 'met', evidence: 'a.mjs:3' }, ['src/a.mjs']).mark, 'recheck', 'a bare name matches a changed path');
  assert.deepEqual(countMarks(rows), { carried: rows.filter(r => r.mark === 'carried').length, rechecked: rows.filter(r => r.mark === 'recheck').length });
});

test('marking: an earlier verdict with no rows, or no way to list files, gives the scope file of today', () => {
  assert.deepEqual(buildScope({ blocking: FIX.blocking, reviewedHead: OLD, newHead: NEW, changedFiles: ['a'], rows: undefined }), { blocking: FIX.blocking });
  assert.deepEqual(buildScope({ blocking: FIX.blocking, reviewedHead: OLD, newHead: NEW, changedFiles: null, rows: FIX.requirements }), { blocking: FIX.blocking });
});

test('real launch: the fix round review scope carries both heads, the changed files and every row marked; the job record counts them', async t => {
  const w = world(t);
  const { spec, scope, rec } = await launch(w);
  assert.deepEqual(w.calls.diff, [OLD, NEW]);
  assert.deepEqual(scope.blocking, FIX.blocking);
  assert.equal(scope.reviewedHead, OLD); assert.equal(scope.newHead, NEW); assert.deepEqual(scope.changedFiles, FIX.fixFiles);
  assert.equal(scope.requirements.length, FIX.requirements.length);
  const carried = scope.requirements.filter(r => r.mark === 'carried'), rechecked = scope.requirements.filter(r => r.mark === 'recheck');
  assert.ok(carried.length > 0 && rechecked.length > 0);
  assert.ok(scope.requirements.find(r => r.status === 'not-met').mark === 'recheck');
  assert.equal(rec.fixRoundReview, true); assert.equal(rec.rowsCarried, carried.length); assert.equal(rec.rowsRechecked, rechecked.length);
  assert.match(spec.prompt, new RegExp(`git diff ${OLD} ${NEW}`));
  assert.match(spec.prompt, new RegExp(`${rechecked.length} requirement rows marked recheck`));
  assert.match(spec.prompt, new RegExp(`${carried.length} rows marked carried`));
  assert.match(spec.prompt, /clone|git clone --no-local/);
  assert.match(spec.prompt, /test-slot run --no-reuse/, 'the reviewer still runs the full suite (D-024)');
});

test('real launch: a first review has no scope file, no fix round wording and no counts on its job record', async t => {
  const w = world(t);
  delete w.team.s.verdicts[`10:${OLD}`]; delete w.team.s.jobs.fix1;
  const { spec, scope, rec } = await launch(w);
  assert.equal(scope, null); assert.doesNotMatch(spec.prompt, /fix-round/);
  assert.equal(rec.fixRoundReview, undefined); assert.equal(rec.rowsCarried, undefined);
});

test('real launch: an earlier verdict with no requirement rows gives the scope file of today', async t => {
  const w = world(t, { earlier: null });
  const { spec, scope, rec } = await launch(w);
  assert.deepEqual(scope, { blocking: FIX.blocking });
  assert.match(spec.prompt, /fix-round re-review\. Read .*review-scope\.json as task data\. Check only the previous blocking findings/);
  assert.equal(rec.fixRoundReview, true); assert.equal(rec.rowsCarried, undefined);
});

test('real launch: when git cannot list the changed files the scope file is today\'s', async t => {
  const w = world(t, { changed: null });
  const { scope } = await launch(w);
  assert.deepEqual(scope, { blocking: FIX.blocking });
});

test('ingest: a verdict that copies every carried row and judges the rechecked rows is recorded', async t => {
  const w = world(t);
  const { scope, rec } = await launch(w);
  const rows = scope.requirements.map(r => r.mark === 'carried' ? copy([r])[0] : { requirement: r.requirement, status: r.status, evidence: r.evidence });
  const report = await finish(w, rec, { verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'row 3 is still not met' }], requirements: rows });
  assert.equal(report.ingested.at(-1).error, undefined);
  assert.equal(w.team.s.verdicts[`10:${NEW}`].verdict, 'CHANGES');
});

test('ingest: a carried row flipped to not-met without new evidence is refused, with the repair step', async t => {
  const w = world(t);
  const { scope, rec } = await launch(w);
  const target = scope.requirements.find(r => r.mark === 'carried');
  const rows = scope.requirements.map(r => r === target ? { requirement: r.requirement, status: 'not-met', evidence: r.evidence } : { requirement: r.requirement, status: r.status, evidence: r.evidence });
  const report = await finish(w, rec, { verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'x is wrong' }], requirements: rows });
  assert.match(report.ingested.at(-1).error, /carried requirement row changed status without new evidence/);
  assert.equal(w.team.s.verdicts[`10:${NEW}`], undefined);
});

test('ingest: a carried row marked not-met with new evidence is accepted and counts as rechecked', async t => {
  const w = world(t);
  const { scope, rec } = await launch(w);
  const target = scope.requirements.find(r => r.mark === 'carried');
  const rows = scope.requirements.map(r => r === target ? { requirement: r.requirement, status: 'not-met', evidence: 'supervisor/team.mjs:1 now fails the case' } : { requirement: r.requirement, status: r.status, evidence: r.evidence });
  const report = await finish(w, rec, { verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'carried row no longer true' }], requirements: rows });
  assert.equal(report.ingested.at(-1).error, undefined);
});

test('ingest: a verdict that leaves a carried row out is refused', async t => {
  const w = world(t);
  const { scope, rec } = await launch(w);
  const target = scope.requirements.find(r => r.mark === 'carried');
  const rows = scope.requirements.filter(r => r !== target).map(r => ({ requirement: r.requirement, status: r.status, evidence: r.evidence }));
  const report = await finish(w, rec, { verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'still not met' }], requirements: rows });
  assert.match(report.ingested.at(-1).error, /carried requirement row is missing/);
});

test('verdict check: only the evidence note added is not new evidence', () => {
  const carried = [{ requirement: 'R', status: 'met', evidence: 'a.mjs:1' }];
  const flip = { requirements: [{ requirement: 'R', status: 'not-met', evidence: `a.mjs:1 (carried from the earlier head ${OLD.slice(0, 12)})` }] };
  assert.match(carriedRowError(flip, carried), /without new evidence/);
  assert.match(carriedRowError({ requirements: [{ requirement: 'R', status: 'not-applicable', evidence: 'new' }] }, carried), /without new evidence/);
  assert.equal(carriedRowError({ requirements: carried }, carried), null);
  assert.equal(carriedRowError({ requirements: [] }, []), null);
});

test('the post-condition refuses a flipped carried row with the verdict-refused detail that starts the repair step', async t => {
  const w = world(t);
  const { scope, rec, spec } = await launch(w);
  const target = scope.requirements.find(r => r.mark === 'carried');
  const rows = scope.requirements.map(r => ({ requirement: r.requirement, status: r === target ? 'not-met' : r.status, evidence: r.evidence }));
  const d = path.join(w.team.dir, 'inbox', rec.ticket);
  fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify({ pr: 10, headSha: NEW, verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'x' }], commandsRun: ['c'], requirements: rows, descriptionClaims: [] }));
  const job = { postcondition: spec.postcondition };
  assert.equal(await w.team.postconditions()(job), false);
  assert.match(job.postconditionDetail, /^verdict refused: a carried requirement row changed status without new evidence/);
});
