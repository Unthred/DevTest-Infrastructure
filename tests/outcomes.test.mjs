// Issue #1307: the pure outcomes builder. The two real examples are entries copied from the retained timeline of 13 Nov 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutcomes, stepOf, lapsOf, binOf, MAX_ITEMS } from '../supervisor/outcomes.mjs';

const HOUR = 3600000;
const END = Date.UTC(2026, 10, 13, 12, 0, 0);
const WINDOW = { startMs: END - 24 * HOUR, endMs: END };
const verdict = (pr, verdict, at) => ({ id: `verdict:${pr}:${at}`, at, kind: 'verdict', pr, verdict });
const rebase = (pr, at) => ({ id: `rebase:${pr}:${at}`, at, kind: 'rebase', pr });
const job = (jobKind, event, at, refs) => ({ id: `ev:${jobKind}:${event}:${at}`, at, kind: 'job', event, jobKind, ...refs });
const outcomes = (extra = {}) => buildOutcomes({ window: WINDOW, ...extra });
const only = result => { assert.equal(result.items.length, 1); return result.items[0]; };

const PR_1244 = [1794527989913, 1794531808790, 1794535413611, 1794540079109, 1794545739085, 1794559510484].map(at => verdict(1244, 'CHANGES', at))
  .concat([1794539121068, 1794544754579, 1794558538287].map(at => rebase(1244, at)));
const PR_1261 = [
  job('implement', 'completed', 1794549643675, { issue: 1259 }), verdict(1261, 'PASS', 1794550179006),
  { id: 'merge:1261', at: 1794550417061, kind: 'merge', issue: 1259, pr: 1261 },
];

test('real: pull request 1244 for issue 1224 went round again and is named in Needs you, one item under 1244 with the issue kept', () => {
  const item = only(outcomes({
    entries: [...PR_1244, job('implement', 'completed', 1794525997129, { issue: 1224 })],
    needsYou: [{ id: 'fixlimit-1244', ref: { kind: 'pull', n: 1244 } }],
    prs: [{ number: 1244, issue: 1224, title: 'Work tab table and board views' }],
  }));
  assert.equal(item.key, 'pr-1244');
  assert.equal(item.issue, 1224);
  assert.equal(item.title, 'Work tab table and board views');
  assert.equal(item.steps.filter(s => s.peg === 'review' && s.result === 'bounced').length, 6);
  assert.equal(item.steps[0].peg, 'implement');   // the issue's own job joins the pull request item
  assert.ok(item.laps >= 2);
  assert.equal(item.laps, 5);   // six review bounces; the last one had nothing after it
  assert.equal(item.bin, 'needs_you');
});

test('real: pull request 1261 for issue 1259 passed review and merged with no laps', () => {
  const result = outcomes({ entries: PR_1261, prs: [{ number: 1261, issue: 1259, title: 'Draftchain' }] });
  const item = only(result);
  assert.deepEqual(item.steps.map(s => `${s.peg}:${s.result}`), ['implement:passed', 'review:passed', 'merge:passed']);
  assert.equal(item.key, 'pr-1261');
  assert.equal(item.issue, 1259);
  assert.equal(item.laps, 0);
  assert.equal(item.bin, 'merged');
  assert.deepEqual(result.counts, { merged: 1, needs_you: 0, failed: 0, moving: 0 });
});

test('the mapping: every listed event gives its stated peg and result, and others give none', () => {
  const at = 1;
  const cases = [
    [job('implement', 'completed', at, {}), 'implement', 'passed'], [job('continue', 'completed', at, {}), 'implement', 'passed'],
    [job('implement', 'blocked', at, {}), 'implement', 'bounced'], [job('continue', 'crash', at, {}), 'implement', 'bounced'],
    [job('implement', 'incomplete', at, {}), 'implement', 'bounced'],
    [verdict(1, 'PASS', at), 'review', 'passed'], [verdict(1, 'CHANGES', at), 'review', 'bounced'],
    [job('cifix', 'created', at, {}), 'ci', 'bounced'],
    [rebase(1, at), 'rebase', 'passed'], [job('rebase', 'blocked', at, {}), 'rebase', 'bounced'],
    [job('rebase', 'incomplete', at, {}), 'rebase', 'bounced'], [job('rebase', 'retry_exhausted', at, {}), 'rebase', 'bounced'],
    [job('rebase', 'crash', at, {}), 'rebase', 'bounced'], [job('implement', 'stale_handover', at, {}), 'implement', 'bounced'],
    [{ kind: 'merge', at, pr: 1 }, 'merge', 'passed'],
  ];
  for (const [entry, peg, result] of cases) assert.deepEqual(stepOf(entry), { at, peg, result }, JSON.stringify(entry));
  const ignored = [job('implement', 'started', at, {}), job('cifix', 'completed', at, {}), job('rebase', 'completed', at, {}),
    job('review', 'completed', at, {}), job('fix', 'completed', at, {}), job('mystery', 'completed', at, {}),
    verdict(1, 'MAYBE', at), { kind: 'unblock', at }, { kind: 'limit_reset', at }];
  for (const entry of ignored) assert.equal(stepOf(entry), null, JSON.stringify(entry));
});

test('laps count the bounced steps that a later step followed', () => {
  const steps = (...list) => list.map(([peg, result]) => ({ at: 0, peg, result }));
  assert.equal(lapsOf(steps(['review', 'bounced'], ['rebase', 'passed'], ['review', 'bounced'])), 1);
  assert.equal(lapsOf(steps(['review', 'bounced'], ['review', 'bounced'], ['review', 'passed'])), 2);
  assert.equal(lapsOf(steps(['review', 'passed'], ['merge', 'passed'])), 0);
  assert.equal(lapsOf([]), 0);
});

test('bins are decided in order: merged, then needs_you, then failed, else moving', () => {
  const bounced = [{ peg: 'review', result: 'bounced' }];
  const merged = [{ peg: 'review', result: 'bounced' }, { peg: 'merge', result: 'passed' }];
  assert.equal(binOf(merged, true), 'merged');
  assert.equal(binOf(bounced, true), 'needs_you');
  assert.equal(binOf(bounced, false), 'failed');
  assert.equal(binOf([{ peg: 'review', result: 'passed' }], false), 'moving');
  assert.equal(binOf([{ peg: 'review', result: 'bounced' }, { peg: 'rebase', result: 'passed' }], false), 'moving');
});

test('an issue with no pull request yet is its own item, and a Needs you line on the issue names it', () => {
  const entries = [job('implement', 'blocked', END - HOUR, { issue: 50 })];
  const item = only(outcomes({ entries, needsYou: [{ ref: { kind: 'issue', n: 50 } }], issues: [{ number: 50, title: 'Fifty' }] }));
  assert.deepEqual([item.key, item.kind, item.pr, item.issue, item.title, item.bin], ['issue-50', 'issue', null, 50, 'Fifty', 'needs_you']);
  assert.equal(only(outcomes({ entries })).bin, 'failed');
});

test('an issue entry and a pull request entry are one item once a merge or a pull request row links them', () => {
  const entries = [
    job('implement', 'completed', END - 3 * HOUR, { issue: 7 }), verdict(70, 'PASS', END - 2 * HOUR),
    { kind: 'merge', at: END - HOUR, pr: 70, issue: 7, id: 'm' },
  ];
  const item = only(outcomes({ entries }));
  assert.deepEqual([item.key, item.issue, item.steps.length], ['pr-70', 7, 3]);
});

test('the title is null when neither the pull request row nor the issue row is known', () => {
  assert.equal(only(outcomes({ entries: [verdict(9, 'PASS', END - HOUR)] })).title, null);
  assert.equal(only(outcomes({ entries: [verdict(9, 'PASS', END - HOUR)], prs: [{ number: 9, title: 'Nine' }] })).title, 'Nine');
});

test('window edges: an entry exactly at the start counts; one before it, and an item with only that, do not', () => {
  const inside = verdict(1, 'PASS', WINDOW.startMs);
  const outside = verdict(2, 'PASS', WINDOW.startMs - 1);
  const result = outcomes({ entries: [inside, outside, verdict(1, 'CHANGES', WINDOW.startMs - 5)] });
  assert.deepEqual(result.items.map(i => i.key), ['pr-1']);
  assert.equal(result.items[0].steps.length, 1);
});

test('invalid input: no number, unknown kind, bad shapes and an empty timeline give no item and no error', () => {
  const entries = [
    verdict(undefined, 'PASS', END - HOUR), job('mystery', 'completed', END - HOUR, { pr: 3 }),
    { kind: 'verdict', at: 'x', pr: 4, verdict: 'PASS' },
  ];
  assert.deepEqual(outcomes({ entries }), { items: [], counts: { merged: 0, needs_you: 0, failed: 0, moving: 0 }, truncated: false });
  assert.equal(outcomes({}).items.length, 0);
  const needsYou = [null, { ref: null }, { ref: { kind: 'pull', n: 'x' } }];
  assert.equal(outcomes({ entries: [verdict(5, 'PASS', END - HOUR)], needsYou }).items[0].bin, 'moving');
});

test('200 items are kept, the most recently active first; 201 sets truncated and the counts cover all', () => {
  const make = count => Array.from({ length: count }, (_, i) => verdict(i + 1, 'PASS', WINDOW.startMs + i * 1000));
  const full = outcomes({ entries: make(MAX_ITEMS) });
  assert.deepEqual([full.items.length, full.truncated], [200, false]);
  const over = outcomes({ entries: make(MAX_ITEMS + 1) });
  assert.deepEqual([over.items.length, over.truncated, over.counts.moving], [200, true, 201]);
  assert.equal(over.items[0].key, 'pr-201');
  assert.ok(!over.items.some(i => i.key === 'pr-1'));
});

test('the builder reads no clock and calls no network: the same input gives the same output', () => {
  const input = { entries: PR_1261, prs: [{ number: 1261, issue: 1259 }] };
  const realNow = Date.now;
  Date.now = () => { throw new Error('the builder must not read the clock'); };
  try { assert.deepEqual(outcomes(input), outcomes(input)); } finally { Date.now = realNow; }
});

test('a rebase job that ends on incomplete, as Foreman records a blocked job, bounces the item into the failed bin', () => {
  const entries = [verdict(70, 'CHANGES', END - 3 * HOUR), job('rebase', 'incomplete', END - HOUR, { pr: 70 })];
  const item = only(outcomes({ entries }));
  assert.deepEqual(item.steps.map(s => `${s.peg}:${s.result}`), ['review:bounced', 'rebase:bounced']);
  assert.deepEqual([item.laps, item.bin], [1, 'failed']);
});
