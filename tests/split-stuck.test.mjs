// Issue #1338: a pull request stuck at the fix limit is parked and a split into smaller items is proposed for approval. These tests drive the
// real tick (Team.tick), the real ingest and the real accept path (the approved inbox action, applyInboxAction, to acceptSplit).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stuckWorld } from './helpers/split-stuck-world.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { withDecisionCards } from '../supervisor/decisioncards.mjs';
import { REGISTER } from './helpers/split-stuck-world.mjs';
import { LeaseHeld } from '../supervisor/core.mjs';
import { bodyFault } from '../supervisor/splitstuck-draft.mjs';
import { stuckCause, approveStuckSplit, rejectStuckSplit } from '../supervisor/splitstuck.mjs';
import { withStuckSplits } from '../supervisor/splitstuck-view.mjs';
import { decisionCard } from '../supervisor/decisiontable.mjs';
import { validateItem } from '../supervisor/inbox.mjs';

const HEAD = 'a'.repeat(40);
const PR = { number: 11, branch: 'codex/issue-7-thing', head: HEAD, files: ['a.mjs', 'b.mjs', 'c.mjs'] };
const item = (title, files, extra = {}) => ({
  title, scope: `${title} scope`, files, tests: [`tests/${title}.test.mjs: proves it`], ...extra,
  acceptance: [{ tag: 'before PR', text: 'unit tests pass' }, { tag: 'after install', text: 'the page shows it' }]
});
const GOOD = { items: [item('one', ['a.mjs']), item('two', ['b.mjs', 'c.mjs'], { prerequisite: 1 })] };
const names = { pr: n => ({ text: `PR #${n}` }) };
const PASS = { verdict: 'PASS', reviewer: 'claude', at: 1, findings: [] };
const cards = (w, n = 11) => withStuckSplits([], { state: w.team.s, names, open: new Set([n]), repo: 'o/r' });
const controls = (card, parked = [11]) => decisionCard(card, { parked: new Set(parked) }).controls.map(c => c.action);

async function proposed(t, opts = {}) {
  const w = stuckWorld(t, { pr: PR, ...opts });
  await w.team.tick();
  await w.finishDraft(GOOD);
  return w;
}

// The approval travels the real way: a card click is an approved inbox item, applied by the tick (applyInboxAction).
async function click(w, action) {
  const v = validateItem({ kind: 'action', title: `${action} 11`, action, target: '11', reason: 'homeowner pressed the button' });
  assert.ok(v.ok, v.reason);
  return w.team.applyInboxAction(v.item, {});
}

test('fix limit after the final round: the tick parks the PR, records the reason and starts one read only planning job', async t => {
  const w = stuckWorld(t, { pr: PR });
  const report = await w.team.tick();
  assert.deepEqual(w.calls.labels.filter(l => l[1] === 'parked'), [[11, 'parked', 'app']], 'parked through the App identity');
  assert.equal(w.calls.created.length, 1);
  const spec = w.calls.created[0];
  assert.equal(spec.kind, 'split');
  assert.deepEqual(spec.allowed_actions, ['read']);
  assert.equal(spec.postcondition.kind, 'stuck_split_drafted');
  assert.doesNotMatch(spec.prompt, /open \(or update\) a pull request|git push/);
  assert.equal(w.team.s.stuckSplits[11].status, 'planning');
  assert.equal(w.team.s.stuckSplits[11].parked, true);
  assert.match(w.team.s.stuckSplits[11].reason, /4 fix rounds/);
  assert.deepEqual(w.calls.issues, []);
  assert.ok(report.notified.some(n => n.splitStuck === 'fix-limit'));
  const ticket = w.team.s.jobs[Object.keys(w.team.s.jobs)[0]].ticket;
  const ctx = JSON.parse(fs.readFileSync(path.join(w.team.dir, 'inbox', ticket, 'context.json'), 'utf8'));
  assert.deepEqual(ctx.thisPrFiles, PR.files);
  assert.deepEqual(ctx.blockingFindings, ['the wiring has no end to end test']);
  assert.deepEqual(ctx.otherOpenPrFiles, {});
});

test('the other open PR file lists reach the planning job context', async t => {
  const w = stuckWorld(t, { pr: PR, others: { 12: ['z.mjs'] } });
  await w.team.tick();
  const ticket = w.team.s.jobs[Object.keys(w.team.s.jobs)[0]].ticket;
  const ctx = JSON.parse(fs.readFileSync(path.join(w.team.dir, 'inbox', ticket, 'context.json'), 'utf8'));
  assert.deepEqual(ctx.otherOpenPrFiles, { 12: ['z.mjs'] });
});

test('below the fix limit, with an approved head, or while the description only round applies, nothing is parked', async t => {
  const below = stuckWorld(t, { pr: PR, fixRounds: 3 });
  await below.team.tick();
  assert.deepEqual(below.calls.created.filter(s => s.kind === 'split'), []);
  assert.deepEqual(below.team.s.stuckSplits || {}, {});
  const passing = stuckWorld(t, { pr: PR, verdict: PASS });
  passing.gh.pulls[0].statusCheckRollup = [];
  await passing.team.tick();
  assert.deepEqual(passing.team.s.stuckSplits || {}, {});
  const findings = [{ kind: 'blocking', scope: 'description', text: 'wrong count' }];
  const desc = stuckWorld(t, { pr: PR, verdict: { verdict: 'CHANGES', reviewer: 'claude', at: 5, findings } });
  assert.equal(stuckCause(desc.team, desc.gh.pulls[0]), null, 'the description only path is tried first');
});

test('a second fix limit event on the same PR creates no second record, job or card', async t => {
  const w = stuckWorld(t, { pr: PR });
  await w.team.tick();
  await w.team.tick();
  await w.team.tick();
  assert.equal(w.calls.created.length, 1);
  assert.equal(Object.keys(w.team.s.stuckSplits).length, 1);
  assert.equal(w.calls.comments.filter(([, b]) => /split-stuck-parked/.test(b)).length, 1);
  w.team.s.fixAttempts[`11:${'b'.repeat(40)}`] = 1;
  await w.team.tick();
  assert.equal(w.calls.created.length, 1);
  assert.equal(cards(w).length, 1);
});

test('the rebase cap with the same cause at the current head parks the PR', async t => {
  const w = stuckWorld(t, { pr: PR, fixRounds: 0, verdict: { verdict: 'CHANGES', reviewer: 'claude', at: 5, findings: [] } });
  w.gh.pulls[0].statusCheckRollup = [];
  w.team.s.sameCause['rebase:11'] = { count: 2, head: HEAD };
  assert.match(stuckCause(w.team, w.gh.pulls[0])?.text || '', /rebases of this PR stopped 2 times/);
  await w.team.tick();
  assert.equal(w.team.s.stuckSplits[11].cause, 'rebase-cap');
  assert.equal(w.team.s.stuckSplits[11].parked, true);
});

test('a rebase cap at the current head does not park a PR whose head is already approved', async t => {
  const w = stuckWorld(t, { pr: PR, fixRounds: 0, verdict: PASS });
  w.gh.pulls[0].statusCheckRollup = [];
  w.team.s.sameCause['rebase:11'] = { count: 2, head: HEAD };
  assert.equal(stuckCause(w.team, w.gh.pulls[0]), null);
  await w.team.tick();
  assert.deepEqual(w.team.s.stuckSplits || {}, {});
});

test('a rebase cap recorded for an earlier head does not park the PR', async t => {
  const w = stuckWorld(t, { pr: PR, fixRounds: 0, verdict: PASS });
  w.gh.pulls[0].statusCheckRollup = [];
  w.team.s.sameCause['rebase:11'] = { count: 5, head: 'f'.repeat(40) };
  assert.equal(stuckCause(w.team, w.gh.pulls[0]), null);
  await w.team.tick();
  assert.equal(w.team.s.stuckSplits?.[11], undefined);
});

test('a good draft becomes ONE card with Approve split and Reject split, and nothing is filed', async t => {
  const w = await proposed(t);
  assert.equal(w.team.s.stuckSplits[11].status, 'proposed');
  assert.equal(w.team.s.stuckSplits[11].items.length, 2);
  assert.deepEqual(w.calls.issues, []);
  assert.equal(w.calls.comments.filter(([, b]) => /proposed split/.test(b)).length, 1);
  await w.team.tick();
  assert.equal(w.calls.comments.filter(([, b]) => /proposed split/.test(b)).length, 1);
  const stale = [{ id: 'fixlimit-11', text: 'x', ref: { kind: 'pull', n: 11 }, severity: 'action' }];
  const attention = withStuckSplits(stale, { state: w.team.s, names, open: new Set([11]), repo: 'o/r' });
  assert.deepEqual(attention.map(a => a.id), ['split-stuck-11'], 'the split card replaces the fix limit card');
  const card = decisionCard(attention[0], {});
  assert.deepEqual(card.controls.map(c => c.label), ['Approve split', 'Reject split']);
  assert.match(attention[0].tried, /Parked: 4 fix rounds/);
  assert.match(attention[0].tried, /one \(a\.mjs\)/);
  assert.match(attention[0].tried, /two \(b\.mjs, c\.mjs\)/);
});

test('a draft sharing a file with another open PR is refused, files nothing and the record shows the fault', async t => {
  const w = stuckWorld(t, { pr: PR, others: { 12: ['b.mjs', 'z.mjs'] } });
  await w.team.tick();
  await w.finishDraft(GOOD);
  assert.equal(w.team.s.stuckSplits[11].status, 'failed');
  assert.match(w.team.s.stuckSplits[11].error, /item 2 edits b\.mjs, which open PR #12 also changes/);
  assert.deepEqual(w.calls.issues, []);
  const [card] = cards(w);
  assert.match(card.tried, /Draft refused: item 2 edits b\.mjs/);
});

test('a missing draft leaves a failed record with the reason and files nothing', async t => {
  const w = stuckWorld(t, { pr: PR });
  await w.team.tick();
  await w.finishDraft(null);
  assert.equal(w.team.s.stuckSplits[11].status, 'failed');
  assert.match(w.team.s.stuckSplits[11].error, /missing or not JSON/);
  assert.deepEqual(w.calls.issues, []);
});

test('a planning job that failed is retried once, and the second failure ends in a failed record', async t => {
  const w = stuckWorld(t, { pr: PR });
  await w.team.tick();
  const first = Object.keys(w.jobs.states)[0];
  w.jobs.states[first].status = 'failed';
  await w.team.tick();
  assert.equal(w.team.s.stuckSplits[11].status, 'planning', 'the first failure is retried');
  await w.team.tick();
  assert.equal(w.calls.created.length, 2, 'one more planning job started');
  const second = Object.keys(w.jobs.states)[1];
  w.jobs.states[second].status = 'failed';
  await w.team.tick();
  assert.equal(w.team.s.stuckSplits[11].status, 'failed');
  assert.match(w.team.s.stuckSplits[11].error, /planning job ended failed/);
  await w.team.tick();
  assert.equal(w.calls.created.length, 2, 'no third job');
});

test('a held lease when starting the planning job is a wait, not an error, and the job starts on the next tick', async t => {
  const w = stuckWorld(t, { pr: PR });
  const real = w.jobs.create;
  w.jobs.create = async () => { throw new LeaseHeld('c'.repeat(32)); };
  w.jobs.states['c'.repeat(32)] = { id: 'c'.repeat(32), status: 'running', provider: 'codex' };
  const report = await w.team.tick();
  assert.ok(report.waiting?.some(x => /split 11/.test(x.what)), JSON.stringify(report.waiting));
  assert.deepEqual(report.blocked || [], []);
  assert.equal(w.team.s.stuckSplits[11].status, 'planning');
  assert.equal(w.team.s.stuckSplits[11].draftJob, undefined);
  assert.equal(w.calls.labels.filter(l => l[1] === 'needs-homeowner').length <= 1, true);
  w.jobs.create = real;
  await w.team.tick();
  assert.ok(w.team.s.stuckSplits[11].draftJob, 'started on the next tick');
  assert.equal(w.calls.created.length, 1);
});

test('approval files the items once through acceptSplit, validates their bodies, links the PR and is idempotent', async t => {
  const w = await proposed(t);
  assert.match(await click(w, 'approve_split'), /filed #2000, #2001/);
  assert.equal(w.calls.issues.length, 2);
  const [one, two] = w.calls.issues.map(i => i[2]);
  assert.match(one, /Files: a\.mjs/);
  assert.match(one, /- before PR: unit tests pass/);
  assert.match(one, /parked PR #11 \(source issue #7\)/);
  assert.doesNotMatch(one, /Depends on/);
  assert.match(two, /^Depends on: #2000$/m, 'a prerequisite names the earlier new item');
  assert.equal(bodyFault(one), null);
  assert.deepEqual(w.team.s.unblock.queued.codex, [2000, 2001]);
  assert.equal(w.team.s.stuckSplits[11].status, 'filed');
  assert.ok(w.calls.comments.some(([n, b]) => n === 11 && /Split accepted/.test(b) && /#2000, #2001/.test(b) && /stays parked/.test(b)));
  await click(w, 'approve_split');
  await approveStuckSplit(w.team, 11);
  assert.equal(w.calls.issues.length, 2, 'a repeat files nothing more');
  await assert.rejects(rejectStuckSplit(w.team, 11), /no split in the state proposed/);
});

test('approval resumes after a crash between two items without filing the first twice', async t => {
  const w = await proposed(t);
  const real = w.gh.createIssue;
  let calls = 0;
  w.gh.createIssue = async (...a) => { if (++calls === 2) throw new Error('network'); return real(...a); };
  await assert.rejects(click(w, 'approve_split'), /network/);
  assert.equal(w.team.s.stuckSplits[11].status, 'proposed');
  w.gh.createIssue = real;
  await click(w, 'approve_split');
  assert.equal(w.calls.issues.length, 2);
  assert.equal(w.team.s.stuckSplits[11].status, 'filed');
});

test('approval after a crash that left the split accepted but the record proposed marks it filed', async t => {
  const w = await proposed(t);
  await click(w, 'approve_split');
  w.team.s.stuckSplits[11].status = 'proposed';
  await approveStuckSplit(w.team, 11);
  assert.equal(w.team.s.stuckSplits[11].status, 'filed');
  assert.deepEqual(w.team.s.stuckSplits[11].filed, [2000, 2001]);
  assert.equal(w.calls.issues.length, 2, 'nothing is filed twice');
});

test('an item body the dependency parser refuses stops the approval before anything is filed', async t => {
  const w = await proposed(t);
  w.team.s.stuckSplits[11].items[0].scope = 'Depends on: nothing, see #3';
  await assert.rejects(click(w, 'approve_split'), /refused by the dependency parser/);
  assert.deepEqual(w.calls.issues, []);
  assert.equal(w.team.s.stuckSplits[11].status, 'proposed');
});

test('a filed split shows its items, says the PR stays parked until the close item, and offers Unpark only', async t => {
  const w = await proposed(t);
  await click(w, 'approve_split');
  const [card] = cards(w);
  assert.match(card.id, /^split-wait-11$/);
  assert.match(card.tried, /#2000 one/);
  assert.match(card.tried, /#2001 two/);
  assert.match(card.tried, /stays parked.*until the close as superseded item lands/);
  assert.doesNotMatch(card.action + card.tried, /#1157|Close as superseded action/);
  assert.deepEqual(controls(card), ['unpark']);
  assert.match(decisionCard(card, {}).clears, /close as superseded item closes/);
});

test('rejection files nothing, leaves the PR parked with its standing options and cannot be approved afterwards', async t => {
  const w = await proposed(t);
  assert.match(await click(w, 'reject_split'), /nothing filed/);
  assert.deepEqual(w.calls.issues, []);
  assert.equal(w.team.s.stuckSplits[11].status, 'rejected');
  assert.ok(w.gh.pulls[0].labels.includes('parked'));
  assert.ok(w.calls.comments.some(([, b]) => /Split rejected/.test(b) && /Standing options/.test(b)));
  await click(w, 'reject_split');
  await assert.rejects(click(w, 'approve_split'), /no split in the state proposed/);
  assert.equal(w.calls.issues.length, 0);
  const [card] = cards(w);
  assert.match(card.tried, /Standing options/);
  assert.deepEqual(controls(card), ['unpark']);
  await w.team.tick();
  assert.equal(w.calls.created.length, 1, 'no second planning job or card after a rejection');
});

test('a rejected or failed split has its own card entry whose clears text is not the filed split text', async t => {
  const rejected = await proposed(t);
  await click(rejected, 'reject_split');
  const failed = stuckWorld(t, { pr: PR });
  await failed.team.tick();
  await failed.finishDraft(null);
  const filed = await proposed(t);
  await click(filed, 'approve_split');
  const clears = w => decisionCard(cards(w)[0], {}).clears;
  assert.equal(cards(rejected)[0].id, 'split-parked-11');
  assert.equal(cards(failed)[0].id, 'split-parked-11');
  assert.equal(cards(filed)[0].id, 'split-wait-11');
  assert.match(clears(rejected), /unpark the pull request or decide another way/);
  assert.equal(clears(failed), clears(rejected));
  assert.notEqual(clears(rejected), clears(filed));
  assert.doesNotMatch(clears(rejected), /close as superseded/);
});

test('an unparked PR whose split was decided no longer shows the split card', async t => {
  const w = await proposed(t);
  await click(w, 'reject_split');
  const labels = new Map([[11, []]]);
  const none = withStuckSplits([], { state: w.team.s, names, open: new Set([11]), repo: 'o/r', labels });
  assert.deepEqual(none, []);
});

// The real data of PR 1139 (4 fix rounds, source issue 1127), with the file lists of the pull requests that were open beside it on 12 Nov 2026.
const real = JSON.parse(fs.readFileSync(new URL('./fixtures/split-stuck/pr1139.json', import.meta.url), 'utf8'));
const realItem = (title, files) => item(title, files, { tests: [`${files.find(f => f.startsWith('tests/')) || files[0]}: proves it`] });

test('PR 1139 with its real data: a draft of 3 items, none sharing a file with another open PR, and a card with both buttons', async t => {
  const pr = { number: real.pr.number, branch: real.pr.headRefName, head: real.pr.headRefOid, files: real.pr.files };
  const w = stuckWorld(t, { pr, others: real.openPrFiles, fixRounds: real.pr.fixRounds });
  await w.team.tick();
  const rec = w.team.s.stuckSplits[1139];
  assert.equal(rec.issue, real.pr.sourceIssue);
  assert.match(rec.reason, /4 fix rounds/);
  const taken = new Set(Object.values(real.openPrFiles).flat());
  const free = real.pr.files.filter(f => !taken.has(f));
  await w.finishDraft({ items: [
    realItem('Capacity team', free.filter(f => /capacity/.test(f))),
    realItem('Issue assignment', free.filter(f => /issueassign|overseer/.test(f))),
    realItem('Inbox agent and pass speed', free.filter(f => /inboxagent|pass-speed|test-resources/.test(f)))
  ] });
  assert.equal(rec.status, 'proposed');
  assert.ok(rec.items.length >= 2 && rec.items.length <= 4, `${rec.items.length} items`);
  for (const x of rec.items) assert.deepEqual(x.files.filter(f => taken.has(f)), [], x.title);
  const [card] = cards(w, 1139);
  assert.deepEqual(decisionCard(card, {}).controls.map(c => c.label), ['Approve split', 'Reject split']);
  const bad = stuckWorld(t, { pr, others: real.openPrFiles, fixRounds: 4 });
  await bad.team.tick();
  await bad.finishDraft({ items: [realItem('A', ['supervisor/team.mjs', 'tests/pass-speed.test.mjs']), realItem('B', ['tests/capacity-planner.test.mjs'])] });
  assert.equal(bad.team.s.stuckSplits[1139].status, 'failed');
  assert.match(bad.team.s.stuckSplits[1139].error, /supervisor\/team\.mjs, which open PR #1183/);
});

// The dashboard path: the saved record becomes one Needs you card with both buttons through the real view builder and decision cards.
test('the dashboard view shows one split card with Approve split and Reject split for a proposed split', async t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'splitview-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o700);
  const now = 1_800_000_000_000;
  const config = {
    schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    github_app: { app_id: 1, installation_id: 2, key_file: '/k/app.pem' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 4 },
    agents: { codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }
  };
  const pull = { number: 11, title: 't', headRefName: PR.branch, headRefOid: HEAD, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',
    statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }], labels: ['parked'], reviewDecision: '', closingIssuesReferences: [],
    url: 'https://github.com/o/r/pull/11' };
  const record = { status: 'proposed', parked: true, reason: '4 fix rounds (limit 4) have not cleared CI', issue: 7, items: GOOD.items };
  const state = { fixAttempts: { [`11:${HEAD}`]: 4 }, verdicts: {}, notified: {}, jobs: {}, stuckSplits: { 11: record } };
  const cache = { tick: { at: now - 60000, status: 'ok', error: null, lastOkAt: now - 60000 }, pulls: [pull], issues: [] };
  const view = await buildView({ config, root, jobs: [], events: [], state, register: REGISTER, cache, snapshots: [], now });
  const items = withDecisionCards(view, config, { pulls: [pull] }).panels.needsYou.filter(a => a.ref?.n === 11);
  assert.deepEqual(items.map(a => a.id), ['split-stuck-11']);
  assert.deepEqual(items[0].card.controls.map(c => c.action), ['approve_split', 'reject_split', 'unpark'], 'the standing Unpark of a parked PR follows');
  assert.match(items[0].tried, /one \(a\.mjs\)/);
});
