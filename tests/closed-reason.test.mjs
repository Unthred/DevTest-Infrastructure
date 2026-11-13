// Issue #1306: which closed issues were dropped with no recorded reason, the record file, and the one grouped Needs you item.
// The real example is issue 895, closed as not planned on 9 Nov 2026 in the hour from 20:00 UTC in the sweep of 232 issues, with no comment.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closedWithoutReason, closedReasonItem, windowFull, validReason, ITEM_ID, WINDOW } from '../supervisor/closedreason.mjs';
import { readRecord, ensureStartedAt, addReason, recordFile, closedReasonAttention } from '../supervisor/closedreason-store.mjs';
import { recordTick, readCache, compactIssues } from '../supervisor/dashdata.mjs';

const TITLE_895 = 'Explain everything: every skip, refusal and failure records a plain-English reason, shown as a per-item story, grouped Needs you, and an outcome board';
const CLOSED_AT = '2026-11-09T20:14:00Z';
const START_BEFORE = Date.UTC(2026, 10, 9, 19, 0, 0);
const START_AFTER = Date.UTC(2026, 10, 10, 0, 0, 0);
const issue = (number, over = {}) => ({ number, title: `Issue ${number}`, state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: CLOSED_AT, ...over });
const i895 = issue(895, { title: TITLE_895 });
const EMPTY = { reasons: {} };
const numbers = (issues, extra = {}) => closedWithoutReason({ issues, record: EMPTY, startedAt: START_BEFORE, ...extra }).map(c => c.number);

function tmp(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'closedreason-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  return root;
}

test('real data: issue 895 is listed with a start time of 9 Nov 19:00 UTC and not with a start time of 10 Nov', () => {
  assert.deepEqual(closedWithoutReason({ issues: [i895], record: EMPTY, startedAt: START_BEFORE }).map(c => [c.number, c.title, c.reason]), [[895, TITLE_895, 'NOT_PLANNED']]);
  assert.deepEqual(closedWithoutReason({ issues: [i895], record: EMPTY, startedAt: START_AFTER }), []);
});

test('the set: closed not planned and closed duplicate count; closed completed, open, before the start and with a recorded reason do not', () => {
  const issues = [
    issue(1), issue(2, { stateReason: 'DUPLICATE' }), issue(3, { stateReason: 'COMPLETED' }), issue(4, { state: 'OPEN', stateReason: null, closedAt: undefined }),
    issue(5, { closedAt: '2026-11-09T18:00:00Z' }), issue(6),
  ];
  assert.deepEqual(numbers(issues, { record: { reasons: { 6: { reason: 'Superseded by the V2 plan', at: 1, call: 'k' } } } }), [1, 2]);
});

test('boundary: a close time equal to the start time does not count; one millisecond later does', () => {
  const at = Date.UTC(2026, 10, 9, 20, 0, 0);
  assert.deepEqual(numbers([issue(7, { closedAt: new Date(at).toISOString() })], { startedAt: at }), []);
  assert.deepEqual(numbers([issue(7, { closedAt: new Date(at + 1).toISOString() })], { startedAt: at }), [7]);
});

test('invalid input: a missing or unreadable close time, an unknown close reason, no start time and a non-list never count', () => {
  const issues = [issue(8, { closedAt: undefined }), issue(9, { closedAt: 'yesterday' }), issue(10, { stateReason: 'REOPENED' }), issue(11, { stateReason: null }), null, { title: 'no number' }];
  assert.deepEqual(numbers(issues), []);
  assert.deepEqual(numbers([issue(12)], { startedAt: null }), []);
  assert.deepEqual(numbers('not a list'), []);
});

test('the close reason is read in any spelling GitHub or the cache gives: lower case, with a space, with a hyphen', () => {
  assert.deepEqual(numbers([issue(1, { stateReason: 'not planned' }), issue(2, { stateReason: 'Not-Planned' }), issue(3, { stateReason: 'duplicate' })]), [1, 2, 3]);
});

test('oldest close first, and the order is stable for equal times', () => {
  const issues = [issue(30, { closedAt: '2026-11-09T21:00:00Z' }), issue(20, { closedAt: '2026-11-09T20:00:01Z' }), issue(10, { closedAt: '2026-11-09T20:00:01Z' })];
  assert.deepEqual(numbers(issues), [10, 20, 30]);
});

test('one grouped item: id closed-noreason, the count, every number and exact title, oldest first, since the oldest close', () => {
  const issues = [issue(900, { title: 'Second', closedAt: '2026-11-09T20:30:00Z', stateReason: 'DUPLICATE' }), i895, issue(3, { stateReason: 'COMPLETED' })];
  const item = closedReasonItem({ issues, record: EMPTY, startedAt: START_BEFORE });
  assert.equal(item.id, ITEM_ID);
  assert.equal(item.id, 'closed-noreason');
  assert.equal(item.since, Date.parse(CLOSED_AT));
  assert.deepEqual(item.issues, [895, 900]);
  assert.match(item.text, /^2 closed issues were dropped with no reason recorded: /);
  assert.ok(item.text.includes(`#895 ${TITLE_895} (not planned); #900 Second (duplicate).`), item.text);
  assert.ok(item.text.indexOf('#895') < item.text.indexOf('#900'));
  assert.equal(item.severity, 'action');
  assert.equal(item.ref, null);
});

test('no counted issue gives no item', () => {
  assert.equal(closedReasonItem({ issues: [issue(1, { stateReason: 'COMPLETED' })], record: EMPTY, startedAt: START_BEFORE }), null);
  assert.equal(closedReasonItem({ issues: [i895], record: { reasons: { 895: { reason: 'Moved to V2 as issue 1300', at: 1, call: 'k' } } }, startedAt: START_BEFORE }), null);
});

test('limit: the item says at least when the closed-by-update fetch is full of closes after the start, and not below that', () => {
  const sweep = n => Array.from({ length: n }, (_, k) => issue(1000 + k));
  assert.equal(windowFull({ issues: sweep(WINDOW), startedAt: START_BEFORE }), true);
  assert.equal(windowFull({ issues: sweep(WINDOW - 1), startedAt: START_BEFORE }), false);
  assert.equal(windowFull({ issues: sweep(WINDOW), startedAt: START_AFTER }), false, 'closes before the start time do not fill it');
  assert.equal(windowFull({ issues: sweep(WINDOW), startedAt: null }), false);
  const full = closedReasonItem({ issues: sweep(WINDOW), record: EMPTY, startedAt: START_BEFORE });
  assert.match(full.text, new RegExp(`^At least ${WINDOW} closed issues were dropped`));
  assert.ok(full.text.includes(`${WINDOW} most recently updated closed issues`));
  const partial = closedReasonItem({ issues: sweep(2), record: EMPTY, startedAt: START_BEFORE });
  assert.match(partial.text, /^2 closed issues were dropped/);
  assert.ok(!partial.text.includes('At least'));
});

test('a reason needs at least 10 characters once trimmed', () => {
  assert.equal(validReason('0123456789'), true);
  assert.equal(validReason('  too short '), false);
  assert.equal(validReason(null), false);
});

test('record file: created on first write, read back, and the start time is written once and never moved', t => {
  const root = tmp(t);
  assert.deepEqual(readRecord(root).record, { version: 1, startedAt: null, reasons: {} });
  assert.equal(fs.existsSync(recordFile(root)), false);
  assert.equal(ensureStartedAt(root, 1000), 1000);
  assert.equal(ensureStartedAt(root, 9999), 1000);
  assert.equal(readRecord(root).record.startedAt, 1000);
  assert.deepEqual(addReason(root, 895, { reason: 'Dropped in the V2 sweep', at: 2000, call: 'call-key-1' }), { ok: true });
  assert.deepEqual(readRecord(root).record.reasons['895'], { reason: 'Dropped in the V2 sweep', at: 2000, call: 'call-key-1' });
  assert.equal(readRecord(root).record.startedAt, 1000);
  assert.equal(ensureStartedAt(root, 5000), 1000);
  assert.deepEqual(addReason(root, 895, { reason: 'Again', at: 3000, call: 'k2' }), { ok: false, why: 'a reason is already recorded' });
  assert.equal(readRecord(root).record.reasons['895'].reason, 'Dropped in the V2 sweep');
});

test('record file: an empty file is an empty record that takes a start time; a damaged file is reported and left untouched', t => {
  const root = tmp(t);
  fs.mkdirSync(path.dirname(recordFile(root)), { recursive: true });
  fs.writeFileSync(recordFile(root), '');
  assert.deepEqual(readRecord(root).record, { version: 1, startedAt: null, reasons: {} });
  assert.equal(ensureStartedAt(root, 1000), 1000);
  for (const damaged of ['{"startedAt": 1000, "reasons": ', '[]', '{"startedAt": "x", "reasons": {}}', '{"startedAt": 1}']) {
    fs.writeFileSync(recordFile(root), damaged);
    assert.match(readRecord(root).error, /close reasons/);
    assert.equal(readRecord(root).record, undefined);
    assert.equal(ensureStartedAt(root, 2000), null);
    assert.equal(addReason(root, 1, { reason: 'x'.repeat(12), at: 1, call: 'k' }).ok, false);
    assert.equal(fs.readFileSync(recordFile(root), 'utf8'), damaged);
  }
});

test('the view item: a damaged record gives one fault item and never an empty list', t => {
  const root = tmp(t);
  ensureStartedAt(root, START_BEFORE);
  assert.deepEqual(closedReasonAttention(root, [i895]).map(a => a.id), ['closed-noreason']);
  fs.writeFileSync(recordFile(root), 'not json');
  const [fault] = closedReasonAttention(root, [i895]);
  assert.equal(fault.id, 'closed-noreason-unreadable');
  assert.match(fault.text, /not valid JSON/);
  fs.rmSync(recordFile(root));
  assert.deepEqual(closedReasonAttention(root, [i895]), []);
});

test('the cached issue list keeps the close reason and the close time, and the full title of a dropped issue', () => {
  const [kept, done, open] = compactIssues([
    { ...i895, labels: [], body: '' }, { number: 1, title: 'word '.repeat(40), state: 'CLOSED', stateReason: 'COMPLETED', closedAt: CLOSED_AT, labels: [], body: '' },
    { number: 2, title: 'Open', state: 'OPEN', labels: [], body: '' },
  ]);
  assert.equal(kept.stateReason, 'NOT_PLANNED');
  assert.equal(kept.closedAt, CLOSED_AT);
  assert.equal(kept.title, TITLE_895);
  assert.equal(done.stateReason, 'COMPLETED');
  assert.equal(done.title.length, 120);
  assert.equal('stateReason' in open, false);
});

test('the check runs on a rebuild of the cached issue list, and has no timer of its own', t => {
  const root = tmp(t);
  const team = (issues) => ({ c: { repository: 'o/r', agents: {} }, view: { prs: [], issues }, delivered: [], merged: [], files: new Map() });
  recordTick(root, { now: START_BEFORE, status: 'ok', team: team([i895]), jobs: [] });
  assert.equal(readRecord(root).record.startedAt, START_BEFORE);
  recordTick(root, { now: START_AFTER, status: 'ok', team: team([i895]), jobs: [] });
  assert.equal(readRecord(root).record.startedAt, START_BEFORE);
  assert.equal(readCache(root).issues[0].stateReason, 'NOT_PLANNED');
  assert.deepEqual(closedReasonAttention(root, readCache(root).issues).map(a => a.id), ['closed-noreason']);
  for (const file of ['closedreason.mjs', 'closedreason-store.mjs', 'api/commands/work-item-close-reason.mjs']) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../supervisor/${file}`, import.meta.url), 'utf8'), /setInterval|setTimeout|cron/i, file);
  }
});
