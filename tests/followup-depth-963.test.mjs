// Issue #963: follow-up recognition, plain titles, the one-off fold plan and the fold run (fake GitHub, nothing real is written).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isFollowUpIssue, parentPrOf, plainTitle, planFold, foldItems, batchMarker } from '../supervisor/followups.mjs';
import { foldBacklog } from '../supervisor/followfold.mjs';

test('follow-up issues are recognised, ordinary issues are not', () => {
  assert.ok(isFollowUpIssue({ title: 'Review follow-ups for PR #850 (issue #1)', body: '' }));
  assert.ok(isFollowUpIssue({ title: 'x', body: batchMarker('docs') }));
  assert.ok(!isFollowUpIssue({ title: 'Dashboard: guard pinned cards', body: 'Fix it.' }));
});

test('parent PR is read from body or title; none gives null', () => {
  assert.equal(parentPrOf({ title: 'Review follow-ups for PR #681 (issue #682)', body: '' }), 681);
  assert.equal(parentPrOf({ title: 't', body: 'Split out of PR #207.' }), 207);
  assert.equal(parentPrOf({ title: 'Something', body: 'none' }), null);
});

test('plainTitle strips chained follow-up prefixes', () => {
  assert.equal(plainTitle('Review follow-ups for PR #850 Review follow-ups for PR #768 Dashboard: guard pinned cards'), 'Dashboard: guard pinned cards');
  assert.equal(plainTitle('Dashboard: guard pinned cards after undo/redo'), 'Dashboard: guard pinned cards after undo/redo');
});

test('planFold folds merged parents only, keeps open parents, lists the unclassifiable, skips batches', () => {
  const issues = [
    { number: 1, title: 'Review follow-ups for PR #10', body: '- a nit' },
    { number: 2, title: 'Review follow-ups for PR #11', body: '' },
    { number: 3, title: 'Review follow-ups for PR #12', body: '' },
    { number: 4, title: 'Review follow-ups: docs', body: batchMarker('docs') },
    { number: 5, title: 'Review follow-ups', body: 'no parent' },
    { number: 6, title: 'Ordinary', body: '' },
  ];
  const parents = new Map([[10, { state: 'MERGED', files: ['docs/a.md'] }], [11, { state: 'OPEN', files: [] }]]);
  const p = planFold(issues, parents);
  assert.deepEqual(p.fold, [{ issue: 1, parent: 10, area: 'docs' }]);
  assert.equal(p.keep[0].issue, 2);
  assert.deepEqual(p.unclassified.map(u => u.issue), [3, 5]);
});

test('foldBacklog dry run writes nothing; apply appends to the batch and closes with a link', async () => {
  const writes = [];
  const open = [
    { number: 1, title: 'Review follow-ups for PR #10', body: '- Rename a helper' },
    { number: 9, title: 'Review follow-ups: docs', body: `${batchMarker('docs')}\nBatch.` },
  ];
  const gh = {
    listOpenIssues: async () => open,
    getPullState: async () => ({ state: 'MERGED', files: ['docs/a.md'] }),
    findOpenIssueByMarker: async m => (open[1].body.includes(m) ? { number: 9, body: open[1].body } : null),
    updateIssueBody: async (n, b) => writes.push(['body', n, b]),
    closeIssue: async (n, c) => writes.push(['close', n, c]),
    createIssue: async () => { throw new Error('must not create'); },
  };
  const dry = await foldBacklog(gh);
  assert.equal(writes.length, 0);
  assert.equal(dry.planned.length, 1);
  const r = await foldBacklog(gh, { apply: true });
  assert.deepEqual(r.folded.map(f => f.batch), [9]);
  const [body, close] = writes;
  assert.match(body[2], /Rename a helper \(was #1\)/);
  assert.match(close[2], /Folded into #9/);
  assert.equal(r.after.followUps, r.before.followUps - 1);
});

test('foldItems falls back to the plain title', () => {
  assert.deepEqual(foldItems({ number: 4, title: 'Review follow-ups for PR #3 Fix X', body: '' }), ['Fix X (was #4)']);
});
