// Issue #1226: a blocking finding about the pull request description only starts a description round, not a fix round.
// These tests drive the real planner (Team.plan), the real launch (Team.execute), the real post-condition and the real ingest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateVerdict, reviewPrompt } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { isDescriptionOnly, planDescriptionRound, DESCRIPTION_ROUND_LIMIT } from '../supervisor/descround.mjs';
import { collectEntries, entryText } from '../supervisor/history.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const table = '## Requirements check\n\n| Requirement | Status | Evidence |\n| --- | --- | --- |\n| One | Met | supervisor/descround.mjs:1; node --test |\n';
const real = JSON.parse(fs.readFileSync(new URL('./fixtures/description-round/pr1192-head-9a2cd36.json', import.meta.url), 'utf8'));
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });

const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
function world(t, { head = H(2), body = 'old body' } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'descround-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], created: [] };
  const pull = { number: 11, title: 't11', headRefName: 'claude/issue-23-y', headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green };
  const gh = { pulls: [pull], body, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [],
    listMergedPulls: async () => [], pullBody: async () => gh.body, addLabel: async (n, l) => (calls.labels ||= []).push([n, l]), comment: async (n, b) => calls.comments.push([n, b]), hasComment: async () => false };
  const jobs = { states: {}, seq: 0, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: config(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 1000 } });
  return { gh, jobs, team, calls, head };
}
const verdict = (...findings) => ({ verdict: 'CHANGES', reviewer: 'codex', at: 500, findings });
const desc = text => ({ kind: 'blocking', scope: 'description', text });
const code = text => ({ kind: 'blocking', scope: 'code', text });
const claudeAction = async w => (await w.team.plan()).find(a => a.agent === 'claude');

test('pure decision: only description findings start a round; a missing scope is code; the limit is 2', () => {
  assert.equal(isDescriptionOnly(verdict(desc('a'), desc('b'))), true);
  assert.equal(isDescriptionOnly(verdict(desc('a'), code('b'))), false);
  assert.equal(isDescriptionOnly(verdict(desc('a'), { kind: 'blocking', text: 'no scope' })), false);
  assert.equal(isDescriptionOnly(verdict(desc('a'), { kind: 'blocking', scope: 'tests', text: 't' })), false);
  assert.equal(isDescriptionOnly(verdict({ kind: 'follow-up', text: 'x' })), false);
  assert.equal(isDescriptionOnly({ verdict: 'PASS', findings: [] }), false);
  assert.equal(planDescriptionRound({ verdict: verdict(desc('a')), rounds: DESCRIPTION_ROUND_LIMIT - 1 }).start, true);
  assert.equal(planDescriptionRound({ verdict: verdict(desc('a')), rounds: DESCRIPTION_ROUND_LIMIT }).start, false);
  assert.equal(DESCRIPTION_ROUND_LIMIT, 2);
});

test('planner: a verdict with only description findings plans a description round, not a plain fix round', async t => {
  const w = world(t);
  w.team.s.verdicts[`11:${w.head}`] = verdict(desc('the line count claim is wrong'));
  const a = await claudeAction(w);
  assert.deepEqual([a.type, a.pr, a.head, a.description, a.escalated], ['fix', 11, w.head, true, undefined]);
});

test('planner: a mix of description and code findings plans the existing fix round with all findings', async t => {
  const w = world(t);
  w.team.s.verdicts[`11:${w.head}`] = verdict(desc('wrong number'), code('real defect'));
  const a = await claudeAction(w);
  assert.equal(a.type, 'fix');
  assert.equal(a.description, undefined);
  await w.team.execute({ agent: 'claude', ...a });
  const spec = w.calls.created[0];
  assert.ok(spec.allowed_actions.includes('push_feature_branch'));
  assert.equal(spec.postcondition.kind, 'new_head');
  assert.equal(w.team.fixCount(11), 1);
  assert.equal(w.team.s.descRounds?.[11], undefined);
});

test('planner: a third description round is refused and the pull request gets no description round', async t => {
  const w = world(t);
  w.team.s.verdicts[`11:${w.head}`] = verdict(desc('wrong number'));
  for (let round = 1; round <= 2; round++) {
    const a = await claudeAction(w);
    assert.equal(a.description, true, `round ${round}`);
    await w.team.execute({ agent: 'claude', ...a });
    w.team.s.jobs[Object.keys(w.team.s.jobs).at(-1)].ingested = true;
  }
  assert.equal(w.team.s.descRounds[11], 2);
  const third = await claudeAction(w);
  assert.notEqual(third?.description, true);   // refused: the existing fix path applies instead
  assert.equal(w.team.fixCount(11), 0);
});

test('a description round pushes no commit: no push or edit permission, own post-condition, fix counter untouched', async t => {
  const w = world(t);
  w.team.s.verdicts[`11:${w.head}`] = verdict(desc('wrong number'));
  w.team.s.fixAttempts[`11:${H(1)}`] = 3;   // the fix limit is already reached, as on PR 1192
  const a = await claudeAction(w);
  assert.equal(a.description, true);
  assert.notEqual(a.escalated, true);
  await w.team.execute({ agent: 'claude', ...a });
  const spec = w.calls.created[0];
  assert.deepEqual(spec.allowed_actions, ['read', 'test', 'update_issue']);
  assert.equal(spec.postcondition.kind, 'description_edited');
  assert.match(spec.prompt, /Do not change, commit or push any file/);
  assert.match(spec.prompt, /never from memory/);
  assert.equal(w.team.fixCount(11), 3);
  assert.equal(w.team.s.descRounds[11], 1);
  assert.equal(Object.values(w.team.s.jobs).at(-1).description, true);
});

test('real verdict of PR 1192 at head 9a2cd36 starts a description round and no fix round, even at the fix limit', async t => {
  const w = world(t, { head: real.head });
  w.team.s.verdicts[`${real.pr}:${real.head}`] = { ...real.verdict, at: 500 };
  const pull = { ...w.gh.pulls[0], number: real.pr };
  w.gh.pulls = [pull];
  w.team.s.fixAttempts[`${real.pr}:${H(1)}`] = real.fixRoundsUsed;
  w.team.s.unblock.escalated[real.pr] = { head: H(1) };   // the one final fix round is also used up
  const actions = (await w.team.plan()).filter(x => x.agent === 'claude');
  assert.equal(actions.length, 1);
  assert.deepEqual([actions[0].type, actions[0].description, actions[0].escalated], ['fix', true, undefined]);
  assert.equal(real.verdict.findings.filter(f => f.kind === 'blocking').length, 1);
  await w.team.tick();   // the real tick launches it
  assert.equal(w.team.fixCount(real.pr), 3);   // not counted as a fix round
  assert.deepEqual(w.calls.created.map(c => c.postcondition.kind), ['description_edited']);
  // the fix-limit Needs-homeowner notice is not raised while a description round can still answer the finding
  assert.equal(w.calls.comments.filter(c => /fix rounds/.test(c[1])).length, 0);
});

test('post-condition: needs the same head, an edited body and a valid requirements table', async t => {
  const w = world(t, { body: table });
  w.team.s.verdicts[`11:${w.head}`] = verdict(desc('wrong number'));
  await w.team.execute({ agent: 'claude', ...await claudeAction(w) });
  const job = { kind: 'fix', postcondition: w.calls.created[0].postcondition };
  const check = () => w.team.postconditions()(job);
  assert.equal(await check(), false);                       // body not edited yet
  assert.match(job.postconditionDetail, /not edited/);
  w.gh.body = table.replace('node --test', 'node --test; tests/x.test.mjs');
  assert.equal(await check(), true);
  w.gh.body = 'edited but the table is gone';
  assert.equal(await check(), false);
  assert.match(job.postconditionDetail, /requirements table/);
  w.gh.body = table.replace('Met', 'Met ') + ' edited';
  w.gh.pulls[0] = { ...w.gh.pulls[0], headRefOid: H(7) };   // a pushed commit is a violation
  assert.equal(await check(), false);
  assert.match(job.postconditionDetail, /must not move the head/);
});

test('completed description round sets the verdict aside once and the same head is reviewed again', async t => {
  const w = world(t, { body: table });
  const key = `11:${w.head}`;
  w.team.s.verdicts[key] = verdict(desc('wrong number'));
  w.team.s.reviewAttempts[`${key}:codex`] = 1;
  await w.team.execute({ agent: 'claude', ...await claudeAction(w) });
  const id = Object.keys(w.team.s.jobs).at(-1);
  w.jobs.states[id] = { id, status: 'completed', lastEvent: 'completed' };
  const report = { ingested: [] };
  await w.team.ingest(report);
  assert.equal(w.team.s.verdicts[key], undefined);
  assert.equal(w.team.s.reviewAttempts[`${key}:codex`], undefined);
  assert.equal(w.calls.comments.filter(c => /Description round done/.test(c[1])).length, 1);
  const review = (await w.team.plan()).find(x => x.type === 'review');
  assert.deepEqual([review.pr, review.head], [11, w.head]);
  w.team.s.jobs[id].ingested = false;
  await w.team.ingest({ ingested: [] });   // an ingest repeated for the same job changes nothing
  assert.equal(w.calls.comments.filter(c => /Description round done/.test(c[1])).length, 1);
});

test('a description round that did not complete leaves the CHANGES verdict in place', async t => {
  const w = world(t);
  const key = `11:${w.head}`;
  w.team.s.verdicts[key] = verdict(desc('wrong number'));
  await w.team.execute({ agent: 'claude', ...await claudeAction(w) });
  const id = Object.keys(w.team.s.jobs).at(-1);
  w.jobs.states[id] = { id, status: 'failed', lastEvent: 'incomplete' };
  await w.team.ingest({ ingested: [] });
  assert.equal(w.team.s.verdicts[key].verdict, 'CHANGES');
});

test('verdict file: scope is optional, bounded to the three names, and the review prompt asks for it', () => {
  const base = { pr: 5, headSha: H(1), verdict: 'CHANGES', commandsRun: ['node --test'] };
  const expect = { pr: 5, head: H(1) };
  assert.equal(validateVerdict({ ...base, findings: [{ kind: 'blocking', text: 'x', scope: 'description' }] }, expect), null);
  assert.equal(validateVerdict({ ...base, findings: [{ kind: 'blocking', text: 'x' }] }, expect), null);
  assert.match(validateVerdict({ ...base, findings: [{ kind: 'blocking', text: 'x', scope: 'docs' }] }, expect), /findings/);
  assert.match(validateVerdict({ ...base, findings: [{ kind: 'blocking', text: 'x', scope: 'code', extra: 1 }] }, expect), /findings/);
  const prompt = reviewPrompt({ pr: 5, head: H(1), branch: 'b', repository: 'o/r', inbox: '/i', requirementsFile: '/i/r.json' });
  assert.match(prompt, /"scope" field/);
  assert.match(prompt, /Check every numeric claim in the description/);
});

test('history: a description round is its own entry type, not a fix', async t => {
  const w = world(t);
  w.team.s.verdicts[`11:${w.head}`] = verdict(desc('wrong number'));
  await w.team.execute({ agent: 'claude', ...await claudeAction(w) });
  const entries = collectEntries({ config: config(), root: null, jobs: [], events: [], state: w.team.s });
  const e = entries.find(x => x.kind === 'description');
  assert.equal(e.pr, 11);
  assert.match(entryText(e), /description round on PR #11/);
});
