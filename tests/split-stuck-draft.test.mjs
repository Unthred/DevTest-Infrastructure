import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { acceptSplit } from '../supervisor/splitaccept.mjs';
import { bodyFault, checkStuckDraft, itemBody } from '../supervisor/splitstuck-draft.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/split-stuck/pr1139.json', import.meta.url), 'utf8'));
const item = (title, files, extra = {}) => ({
  title,
  scope: `${title} scope`,
  files,
  acceptance: [{ tag: 'before PR', text: 'the unit check passes' }, { tag: 'after install', text: 'the installed dashboard shows it' }],
  tests: [`tests/${title}.test.mjs: proves the split item`],
  ...extra
});
const context = { pullRequest: fixture.pr, openPullRequestFiles: fixture.openPrFiles };

test('the real PR 1139 draft of three non-conflicting items is accepted', () => {
  const draft = {
    items: [
      item('Capacity team', ['supervisor/capacityteam.mjs']),
      item('Inbox agent', ['supervisor/inboxagent.mjs'], { prerequisite: 1 }),
      item('Pass speed', ['tests/pass-speed.test.mjs'], { prerequisite: 2 })
    ]
  };
  const checked = checkStuckDraft(draft, context);
  assert.deepEqual(checked.error, undefined);
  assert.equal(checked.items.length, 3);
  assert.equal(fixture.pr.fixRounds, 4);
  assert.equal(fixture.pr.sourceIssue, 1127);
  assert.deepEqual(checked.items.map(value => value.prerequisite), [null, 1, 2]);
});

test('two and four items are accepted, while one and five name their found counts', () => {
  const two = { items: [item('one', ['one.mjs']), item('two', ['two.mjs'])] };
  const four = { items: [item('one', ['one.mjs']), item('two', ['two.mjs']), item('three', ['three.mjs']), item('four', ['four.mjs'])] };
  assert.ok(checkStuckDraft(two, context).items);
  assert.ok(checkStuckDraft(four, context).items);
  assert.match(checkStuckDraft({ items: [item('one', ['one.mjs'])] }, context).error, /found 1 items/);
  assert.match(checkStuckDraft({ items: Array.from({ length: 5 }, (_, index) => item(`item-${index}`, [`${index}.mjs`])) }, context).error, /found 5 items/);
});

test('item faults name the item and its files, acceptance tags, tests, or prerequisite rule', () => {
  const cases = [
    [{ items: [item('one', []), item('two', ['two.mjs'])] }, /item 1 must name the files it edits/],
    [
      { items: [{ ...item('one', ['one.mjs']), acceptance: [{ tag: 'unverified', text: 'x' }] }, item('two', ['two.mjs'])] },
      /item 1 needs an acceptance list whose lines are tagged/
    ],
    [{ items: [{ ...item('one', ['one.mjs']), tests: [] }, item('two', ['two.mjs'])] }, /item 1 must name its tests/],
    [{ items: [item('one', ['one.mjs']), item('two', ['two.mjs'], { prerequisite: 2 })] }, /item 2 names a prerequisite that is not an earlier item/]
  ];
  for (const [draft, expected] of cases) assert.match(checkStuckDraft(draft, context).error, expected);
});

test('a shared file names the other open pull request, but the parked PR itself is ignored', () => {
  const conflicting = { items: [item('one', ['supervisor/dashboard.mjs']), item('two', ['two.mjs'])] };
  assert.match(checkStuckDraft(conflicting, context).error, /supervisor\/dashboard\.mjs, which open PR #1183/);
  const own = { items: [item('one', ['supervisor/capacityteam.mjs']), item('two', ['two.mjs'])] };
  const ownContext = { pullRequest: { number: 1139, files: ['supervisor/capacityteam.mjs'] }, openPullRequestFiles: { 1139: ['supervisor/capacityteam.mjs'] } };
  assert.ok(checkStuckDraft(own, ownContext).items);
});

test('item bodies name the parked PR, add a dependency only for an earlier item, and report parser faults', () => {
  const first = itemBody({ item: item('one', ['one.mjs']), index: 0, count: 2, parent: 1139, source: 1127 });
  const second = itemBody({ item: item('two', ['two.mjs'], { prerequisite: 1 }), index: 1, count: 2, parent: 1139, source: 1127 });
  assert.match(first, /parked PR #1139/);
  assert.doesNotMatch(first, /^Depends on:/m);
  assert.match(second, /^Depends on: \{\{PREREQUISITE\}\}$/m);
  assert.equal(bodyFault(first), null);
  assert.equal(bodyFault(second), null);
  const refusal = bodyFault('Depends on: not-an-issue');
  assert.match(refusal, /Depends on line must be a comma-separated list/);
});

test('ordinary issue split text is unchanged by the move of acceptSplit into its own module', async () => {
  const filed = [];
  const notices = [];
  const team = {
    s: { unblock: { queued: {} }, splits: { 7: { status: 'proposed', agent: 'codex', children: [
      { title: 'a', scope: 'part one' }, { title: 'b', scope: 'part two' }] } } },
    gh: { findIssueByMarker: async () => null, createIssue: async (title, body) => filed.push(body) + 99 },
    save: () => {},
    clock: { now: () => 1 },
    postNotice: async (issue, key, text) => notices.push([issue, key, text])
  };
  await acceptSplit(team, 7);
  const expected = ['<!-- devtest-split-child v1 parent=7 idx=0 -->',
    'Part 1 of 2 of #7, split by Foreman after #7 ran out of context (accepted by the homeowner).',
    '', '**Scope:** part one', '', 'Read #7 for the full requirements; deliver only this part.'].join('\n');
  assert.equal(filed[0], expected);
  assert.match(notices[0][2], /This issue is not started again; close it when the children are done\./);
});
