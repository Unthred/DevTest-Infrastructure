// Issue #1240: a pull request stuck at the fix limit is parked and a split into smaller items is proposed for approval. These tests drive the
// real tick (Team.tick), the real ingest and the real accept path (Team.acceptSplit through the approved inbox action), over fake GitHub and jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { stuckWorld } from './helpers/split-stuck-world.mjs';
import { checkStuckDraft, itemBody, bodyFault } from '../supervisor/splitstuck-draft.mjs';
import { stuckCause, approveStuckSplit, rejectStuckSplit } from '../supervisor/splitstuck.mjs';
import { splitFacts, withStuckSplits } from '../supervisor/splitstuck-view.mjs';
import { decisionCard } from '../supervisor/decisiontable.mjs';
import { validateItem } from '../supervisor/inbox.mjs';

const HEAD = 'a'.repeat(40);
const PR = { number: 11, branch: 'codex/issue-7-thing', head: HEAD, files: ['a.mjs', 'b.mjs', 'c.mjs'] };
const item = (title, files, extra = {}) => ({ title, scope: `${title} scope`, files, acceptance: [{ tag: 'before PR', text: 'unit tests pass' }, { tag: 'after install', text: 'the page shows it' }], tests: [`tests/${title}.test.mjs: proves it`], ...extra });
const GOOD = { items: [item('one', ['a.mjs']), item('two', ['b.mjs', 'c.mjs'], { prerequisite: 1 })] };
const names = { pr: n => ({ text: `PR #${n}` }) };

async function proposed(t, opts = {}) {
  const w = stuckWorld(t, { pr: PR, ...opts });
  await w.team.tick();
  await w.finishDraft(GOOD);
  return w;
}

test('fix limit reached: the PR is parked, the planning job is read only, and nothing is filed', async t => {
  const w = stuckWorld(t, { pr: PR });
  const report = await w.team.tick();
  assert.deepEqual(w.calls.labels.filter(l => l[1] === 'parked'), [[11, 'parked', 'app']], 'parked through the App identity');
  assert.equal(w.calls.created.length, 1);
  const spec = w.calls.created[0];
  assert.equal(spec.kind, 'split'); assert.deepEqual(spec.allowed_actions, ['read']); assert.equal(spec.postcondition.kind, 'stuck_split_drafted');
  assert.doesNotMatch(spec.prompt, /open \(or update\) a pull request|git push/);
  assert.match(spec.prompt, /split-stuck-draft\.json/); assert.match(spec.prompt, /#7/);
  assert.equal(w.team.s.stuckSplits[11].status, 'planning'); assert.equal(w.team.s.stuckSplits[11].parked, true);
  assert.match(w.team.s.stuckSplits[11].reason, /4 fix rounds/);
  assert.deepEqual(w.calls.issues, []);
  assert.ok(report.notified.some(n => n.splitStuck === 'fix-limit'));
  const ctx = JSON.parse(fs.readFileSync(path.join(w.team.dir, 'inbox', w.team.s.jobs[Object.keys(w.team.s.jobs)[0]].ticket, 'context.json'), 'utf8'));
  assert.deepEqual(ctx.thisPrFiles, PR.files); assert.deepEqual(ctx.blockingFindings, ['the wiring has no end to end test']);
});

test('below the fix limit, or already passing, or with a description round still to run, nothing is parked', async t => {
  const below = stuckWorld(t, { pr: PR, fixRounds: 3 });
  await below.team.tick(); assert.deepEqual(below.calls.created.filter(s => s.kind === 'split'), []); assert.deepEqual(below.team.s.stuckSplits || {}, {});
  const desc = stuckWorld(t, { pr: PR, verdict: { verdict: 'CHANGES', reviewer: 'claude', at: 5, findings: [{ kind: 'blocking', scope: 'description', text: 'wrong count' }] } });
  assert.equal(stuckCause(desc.team, desc.gh.pulls[0]), null, 'the description only path is tried first');
});

test('a second fix limit event on the same PR creates no second record, job or card', async t => {
  const w = stuckWorld(t, { pr: PR });
  await w.team.tick(); await w.team.tick(); await w.team.tick();
  assert.equal(w.calls.created.length, 1); assert.equal(Object.keys(w.team.s.stuckSplits).length, 1);
  assert.equal(w.calls.comments.filter(([, b]) => /split-stuck-parked/.test(b)).length, 1);
  w.team.s.fixAttempts[`11:${'b'.repeat(40)}`] = 1;   // another fix event on a later head
  await w.team.tick(); assert.equal(w.calls.created.length, 1);
});

test('the rebase cap with the same cause also parks the PR', async t => {
  const w = stuckWorld(t, { pr: PR, fixRounds: 0, verdict: { verdict: 'PASS', reviewer: 'claude', at: 1, findings: [] } });
  w.team.s.sameCause['rebase:11'] = { count: 2, head: w.gh.pulls[0].headRefOid };
  assert.match(stuckCause(w.team, w.gh.pulls[0])?.text || '', /rebases of this PR stopped 2 times/);
  await w.team.tick(); assert.equal(w.team.s.stuckSplits[11].cause, 'rebase-cap');
});

test('a rebase cap recorded for an earlier head does not park the PR at a new head', async t => {
  const w = stuckWorld(t, { pr: PR, fixRounds: 0, verdict: { verdict: 'PASS', reviewer: 'claude', at: 1, findings: [] } });
  w.team.s.sameCause['rebase:11'] = { count: 5, head: 'f'.repeat(40) };
  assert.equal(stuckCause(w.team, w.gh.pulls[0]), null);
  await w.team.tick(); assert.equal(w.team.s.stuckSplits[11], undefined);
});

test('a good draft becomes ONE proposal: a notice, a card with both buttons, and nothing filed', async t => {
  const w = await proposed(t);
  assert.equal(w.team.s.stuckSplits[11].status, 'proposed'); assert.equal(w.team.s.stuckSplits[11].items.length, 2);
  assert.deepEqual(w.calls.issues, []);
  assert.equal(w.calls.comments.filter(([, b]) => /proposed split/.test(b)).length, 1);
  await w.team.tick(); assert.equal(w.calls.comments.filter(([, b]) => /proposed split/.test(b)).length, 1);
  const attention = withStuckSplits([{ id: 'fixlimit-11', text: 'x', ref: { kind: 'pull', n: 11 }, severity: 'action' }], { state: w.team.s, names, open: new Set([11]), repo: 'o/r' });
  assert.deepEqual(attention.map(a => a.id), ['split-stuck-11'], 'the split card replaces the fix limit card');
  const card = decisionCard({ ...attention[0] }, {});
  assert.deepEqual(card.controls.map(c => c.action), ['approve_split', 'reject_split']);
  assert.deepEqual(card.controls.map(c => c.label), ['Approve split', 'Reject split']);
  assert.match(attention[0].tried, /Parked: 4 fix rounds/); assert.match(attention[0].tried, /one \(a\.mjs\)/);
});

test('a draft that shares a file with another open PR, is too short, or is malformed is refused and files nothing', async t => {
  const base = { pr: PR, others: { 12: ['b.mjs', 'z.mjs'] } };
  const w = stuckWorld(t, base);
  await w.team.tick(); await w.finishDraft(GOOD);
  assert.equal(w.team.s.stuckSplits[11].status, 'failed');
  assert.match(w.team.s.stuckSplits[11].error, /item 2 edits b\.mjs, which open PR #12 also changes/);
  assert.deepEqual(w.calls.issues, []);
  const facts = splitFacts(w.team.s, 11); assert.equal(facts.code, 'failed');
  const open = new Map([[12, ['z.mjs']]]);
  for (const bad of [{ items: [item('one', ['a.mjs'])] }, { items: [1, 2] }, { items: Array.from({ length: 5 }, (_, i) => item(`n${i}`, [`f${i}.mjs`])) }, { items: [item('a', []), item('b', ['x'])] },
    { items: [item('a', ['../x']), item('b', ['x'])] }, { items: [{ ...item('a', ['a']), acceptance: [{ tag: 'later', text: 'x' }] }, item('b', ['b'])] },
    { items: [{ ...item('a', ['a']), acceptance: [{ tag: 'after install', text: 'x' }] }, item('b', ['b'])] }, { items: [{ ...item('a', ['a']), tests: [] }, item('b', ['b'])] },
    { items: [item('a', ['a'], { prerequisite: 1 }), item('b', ['b'])] }, { items: [item('a', ['a']), item('b', ['b'], { prerequisite: 2 })] }]) {
    assert.ok(checkStuckDraft(bad, open).error, JSON.stringify(bad).slice(0, 80));
  }
  assert.ok(checkStuckDraft(GOOD, open).items);
});

test('a missing or failed planning job leaves a failed record with the reason and files nothing', async t => {
  const w = stuckWorld(t, { pr: PR });
  await w.team.tick(); await w.finishDraft(null);
  assert.equal(w.team.s.stuckSplits[11].status, 'failed'); assert.match(w.team.s.stuckSplits[11].error, /missing or not JSON/);
  assert.deepEqual(w.calls.issues, []);
});

// The approval travels the real way: a card click is an approved inbox item, applied by the tick (runInboxAction -> applyInboxAction).
async function click(w, action) {
  const v = validateItem({ kind: 'action', title: `${action} 11`, action, target: '11', reason: 'homeowner pressed the button' });
  assert.ok(v.ok, v.reason);
  return w.team.applyInboxAction(v.item, {});
}

test('approval files the items once through acceptSplit, validates their bodies, links the PR and is idempotent', async t => {
  const w = await proposed(t);
  const first = await click(w, 'approve_split');
  assert.match(first, /filed #2000, #2001/);
  assert.equal(w.calls.issues.length, 2);
  const [one, two] = w.calls.issues.map(i => i[2]);
  assert.match(one, /Files: a\.mjs/); assert.match(one, /- before PR: unit tests pass/); assert.match(one, /- after install: the page shows it/); assert.match(one, /parked PR #11 \(source issue #7\)/);
  assert.doesNotMatch(one, /Depends on/); assert.match(two, /^Depends on: #2000$/m, 'a prerequisite names the earlier new item');
  assert.equal(bodyFault(one), null); assert.equal(bodyFault(two), null);
  assert.deepEqual(w.team.s.unblock.queued.codex, [2000, 2001]);
  assert.equal(w.team.s.stuckSplits[11].status, 'filed');
  assert.ok(w.calls.comments.some(([n, b]) => n === 11 && /Split accepted/.test(b) && /#2000, #2001/.test(b) && /stays parked/.test(b)));
  await click(w, 'approve_split'); await approveStuckSplit(w.team, 11);
  assert.equal(w.calls.issues.length, 2, 'a repeat files nothing more');
  await assert.rejects(rejectStuckSplit(w.team, 11), /no split in the state proposed/);
});

test('approval resumes after a crash between two items without filing the first twice', async t => {
  const w = await proposed(t);
  const real = w.gh.createIssue; let n = 0;
  w.gh.createIssue = async (...a) => { if (++n === 2) throw new Error('network'); return real(...a); };
  await assert.rejects(click(w, 'approve_split'), /network/);
  assert.equal(w.team.s.stuckSplits[11].status, 'proposed');
  w.gh.createIssue = real;
  await click(w, 'approve_split');
  assert.equal(w.calls.issues.length, 2); assert.equal(w.team.s.stuckSplits[11].status, 'filed');
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
  assert.ok(bodyFault(itemBody({ item: { ...GOOD.items[0], scope: 'x' }, index: 0, count: 2, parent: 11, source: 7 })) === null);
});

test('rejection files nothing, leaves the PR parked with its standing options, and cannot be approved afterwards', async t => {
  const w = await proposed(t);
  assert.match(await click(w, 'reject_split'), /nothing filed/);
  assert.deepEqual(w.calls.issues, []); assert.equal(w.team.s.stuckSplits[11].status, 'rejected');
  assert.ok(w.gh.pulls[0].labels.includes('parked'));
  assert.ok(w.calls.comments.some(([, b]) => /Split rejected/.test(b) && /Standing options/.test(b)));
  await click(w, 'reject_split');
  await assert.rejects(click(w, 'approve_split'), /no split in the state proposed/);
  const a = withStuckSplits([], { state: w.team.s, names, open: new Set([11]), repo: 'o/r' });
  assert.match(a[0].tried, /Standing options/); assert.deepEqual(decisionCard(a[0], {}).controls.map(c => c.action), []);
  await w.team.tick(); assert.equal(w.calls.created.length, 1, 'no second planning job or card after a rejection');
});

test('merged items mark the parked PR ready to close and Foreman does not close it', async t => {
  const w = await proposed(t);
  await click(w, 'approve_split');
  await w.team.tick();
  w.team.delivered = new Set([2000]);
  await w.team.notifyFixLimit({ notified: [], skipped: [], actions: [] });
  assert.notEqual(w.team.s.stuckSplits[11].itemsMerged, true, 'one of two items merged is not enough');
  w.team.delivered = new Set([2000, 2001]);
  const report = { notified: [], skipped: [], actions: [] };
  await w.team.notifyFixLimit(report);
  const rec = w.team.s.stuckSplits[11];
  assert.equal(rec.itemsMerged, true); assert.equal(rec.status, 'filed'); assert.ok(report.notified.some(x => x.splitItemsMerged));
  assert.equal(typeof w.gh.closePull, 'undefined', 'Foreman has no close of its own; #1157 owns the close');
  assert.ok(w.gh.pulls.some(p => p.number === 11), 'the PR is still open and parked');
  const [card] = withStuckSplits([], { state: w.team.s, names, open: new Set([11]), repo: 'o/r' });
  assert.match(card.tried, /closed as superseded/); assert.match(card.action, /#1157/); assert.equal(card.severity, 'action');
  const again = { notified: [], skipped: [], actions: [] };
  await w.team.notifyFixLimit(again); assert.deepEqual(again.notified, [], 'noted once');
  w.gh.pulls = []; await w.team.notifyFixLimit(again); assert.equal(w.team.s.stuckSplits[11].status, 'closed');
});

// The real data of PR 1139 (4 fix rounds, source issue 1127), with the file lists of the ten pull requests that were open beside it on 12 Nov 2026.
const real = JSON.parse(fs.readFileSync(new URL('./fixtures/split-stuck/pr1139.json', import.meta.url), 'utf8'));
const realItem = (title, files) => ({ title, scope: `${title}: the part of #1127 that edits only ${files.length} files nobody else has open`, files, acceptance: [{ tag: 'before PR', text: `${title} has its unit tests` }, { tag: 'after install', text: 'the dashboard shows it' }], tests: [`${files.find(f => f.startsWith('tests/'))}: proves it`] });

test('PR 1139 with its real data: a draft of 3 items, none sharing a file with another open PR, and a card with both buttons', async t => {
  const w = stuckWorld(t, { pr: { number: real.pr.number, branch: real.pr.headRefName, head: real.pr.headRefOid, files: real.pr.files }, others: real.openPrFiles, fixRounds: real.pr.fixRounds });
  await w.team.tick();
  const rec = w.team.s.stuckSplits[1139];
  assert.equal(rec.issue, real.pr.sourceIssue); assert.match(rec.reason, /4 fix rounds/);
  const free = real.pr.files.filter(f => !Object.values(real.openPrFiles).flat().includes(f));
  assert.ok(free.length >= 6, 'the PR has files no other open PR touches');
  await w.finishDraft({ items: [realItem('Capacity team', free.filter(f => /capacity/.test(f))), realItem('Issue assignment', free.filter(f => /issueassign|overseer/.test(f))), realItem('Inbox agent and pass speed', free.filter(f => /inboxagent|pass-speed|test-resources/.test(f)))] });
  assert.equal(rec.status, 'proposed'); assert.ok(rec.items.length >= 2 && rec.items.length <= 4, `${rec.items.length} items`);
  const others = new Set(Object.values(real.openPrFiles).flat());
  for (const x of rec.items) assert.deepEqual(x.files.filter(f => others.has(f)), [], x.title);
  const [att] = withStuckSplits([], { state: w.team.s, names, open: new Set([1139]), repo: 'o/r' });
  assert.deepEqual(decisionCard(att, {}).controls.map(c => c.label), ['Approve split', 'Reject split']);
  // the same draft, but with team.mjs in it (open PRs 1183 and others change it), is refused
  const bad = stuckWorld(t, { pr: { number: 1139, branch: real.pr.headRefName, head: real.pr.headRefOid, files: real.pr.files }, others: real.openPrFiles, fixRounds: 4 });
  await bad.team.tick(); await bad.finishDraft({ items: [realItem('A', ['supervisor/team.mjs', 'tests/pass-speed.test.mjs']), realItem('B', ['tests/capacity-planner.test.mjs'])] });
  assert.equal(bad.team.s.stuckSplits[1139].status, 'failed'); assert.match(bad.team.s.stuckSplits[1139].error, /supervisor\/team\.mjs, which open PR #1183/);
});
