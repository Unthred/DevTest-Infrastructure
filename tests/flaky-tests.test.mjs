// Issue #1370: the record of unreliable tests. Real data: the flaky result of 13 Nov 2026 14:40 UTC.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyReport, flakyFaults, flakyList, flakyRecorder, readFlaky, fileFromExcerpt, defang } from '../supervisor/flakytests.mjs';
import { parseDependsOn } from '../supervisor/dependencies.mjs';
import { installs } from '../supervisor/installs.mjs';
import { parseTestFailure } from '../supervisor/upgrade.mjs';
import { classify } from '../supervisor/api/attention.mjs';

const NAME = 'install: keeps launcher.env at 0640 and sets the other modes when the caller runs under umask 077';
const T0 = Date.parse('2026-11-13T14:40:00Z'), DAY = 86400000;
const EXCERPT = `not ok 3 - ${NAME}\n  ---\n  location: '/work/copy/tests/install-modes.test.mjs:41:1'\n  error: 'expected 0640'`;

function fakeGh(t, { body = null } = {}) {
  const calls = { created: [], updated: [] };
  let issue = body == null ? null : { number: 77, body };
  const gh = {
    listPulls: async () => [],
    findOpenIssueByMarker: async (marker, skip = []) => (issue && !skip.includes(issue.number) && issue.body.includes(marker) ? { ...issue } : null),
    createIssue: async (title, text) => { calls.created.push({ title, text }); issue = { number: 77, body: text }; return 77; },
    updateIssueBody: async (n, text) => { calls.updated.push({ n, text }); issue.body = text; }
  };
  return { gh, calls, body: () => issue?.body };
}
const rootOf = t => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'flaky-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const recorder = (t, g, clock) => { const root = rootOf(t); return { root, record: flakyRecorder({ root, gh: g.gh, clock, log: line => (clock.lines ||= []).push(line) }) }; };

test('valid: the 13 Nov flaky test reported once gives one record with count 1 and one follow-up entry', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  await record({ flaky: { tests: [NAME], excerpt: EXCERPT }, stage: 'install' });
  const r = Object.values(readFlaky(root).tests);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].name, r[0].file, r[0].count, r[0].stage, r[0].first, r[0].last, r[0].followup], [NAME, 'tests/install-modes.test.mjs', 1, 'install', T0, T0, 77]);
  assert.equal(g.calls.created.length, 1);
  assert.match(g.calls.created[0].text, /devtest-followup-batch v1 area=tests/);
  assert.match(g.calls.created[0].text, /umask 077.*seen 1 time/s);
  assert.equal(flakyList(readFlaky(root), T0)[0].count, 1);
});

test('boundary: reported again gives count 2 and no second entry; the third report in 7 days raises the fault once', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  for (const day of [0, 1, 2]) {
    clock.now = () => T0 + day * DAY;
    await record({ flaky: { tests: [NAME], excerpt: EXCERPT }, stage: 'pre-check' });
    const now = T0 + day * DAY, faults = flakyFaults(readFlaky(root), now);
    assert.equal(Object.values(readFlaky(root).tests)[0].count, day + 1);
    assert.equal(faults.length, day === 2 ? 1 : 0);
  }
  assert.equal(g.calls.created.length, 1);
  assert.equal(g.calls.updated.length, 0);
  assert.equal(g.body().split('devtest-flaky-test v1').length - 1, 1);
  const [fault] = flakyFaults(readFlaky(root), T0 + 2 * DAY);
  assert.equal(fault.class, 'fault');
  assert.equal(fault.severity, 'action');
  assert.ok(fault.text.includes(NAME) && fault.text.includes('3 times') && fault.text.includes('#77'), fault.text);
  assert.equal(flakyFaults(readFlaky(root), T0 + 2 * DAY).length, 1);
});

test('boundary: three sightings spread over more than 7 days raise nothing; the fault clears when the record is dropped', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  for (const day of [0, 8, 10]) { clock.now = () => T0 + day * DAY; await record({ flaky: { tests: [NAME], excerpt: '' }, stage: 'install' }); }
  assert.equal(Object.values(readFlaky(root).tests)[0].count, 3);
  assert.equal(flakyFaults(readFlaky(root), T0 + 10 * DAY).length, 0);   // only two inside the last 7 days
  clock.now = () => T0 + 12 * DAY; await record({ flaky: { tests: [NAME], excerpt: '' }, stage: 'install' });
  assert.equal(flakyFaults(readFlaky(root), T0 + 12 * DAY).length, 1);   // 8, 10, 12
  assert.equal(flakyFaults(readFlaky(root), T0 + 25 * DAY).length, 1);   // 13 days after the last sighting: the record and its item remain
  assert.equal(flakyFaults(readFlaky(root), T0 + 26 * DAY).length, 0);   // 14 days: dropped
  assert.equal(flakyList(readFlaky(root), T0 + 26 * DAY).length, 0);
});

test('boundary: a report 15 days after the last starts a new record', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  await record({ flaky: { tests: [NAME], excerpt: EXCERPT }, stage: 'install' });
  clock.now = () => T0 + 15 * DAY;
  await record({ flaky: { tests: [NAME], excerpt: EXCERPT }, stage: 'install' });
  const [r] = Object.values(readFlaky(root).tests);
  assert.deepEqual([r.count, r.first], [1, T0 + 15 * DAY]);
});

test('invalid: a flaky report with no test name records nothing and logs why', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  await record({ flaky: { tests: [], excerpt: EXCERPT }, stage: 'install' });
  assert.deepEqual(readFlaky(root).tests, {});
  assert.equal(g.calls.created.length, 0);
  assert.match(clock.lines[0], /named no test/);
});

test('invalid: an excerpt holding secret shaped text is stored redacted', () => {
  const secret = ['gh', 'p_', 'a'.repeat(36)].join('');
  const { state } = applyReport({ tests: {} }, { tests: [NAME], excerpt: `error: token=${secret}\npassword: ${'hunter' + '2'}`, stage: 'install' }, T0);
  const text = JSON.stringify(state);
  assert.ok(!text.includes(secret) && !text.includes('hunter2'), text);
  assert.ok(text.length < 2000);
});

test('a follow-up write that fails keeps the record and retries the entry on the next report', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  const create = g.gh.createIssue; g.gh.createIssue = async () => { throw new Error('GitHub unreachable'); };
  await record({ flaky: { tests: [NAME], excerpt: '' }, stage: 'install' });
  assert.equal(Object.values(readFlaky(root).tests)[0].followup, null);
  assert.match(clock.lines.join('\n'), /not written/);
  g.gh.createIssue = create; clock.now = () => T0 + 1000;
  await record({ flaky: { tests: [NAME], excerpt: '' }, stage: 'install' });
  assert.equal(Object.values(readFlaky(root).tests)[0].followup, 77);
});

test('a second test is added to the existing open issue; an issue already implemented by a pull request is not edited', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { record } = recorder(t, g, clock);
  await record({ flaky: { tests: [NAME], excerpt: '' }, stage: 'install' });
  await record({ flaky: { tests: ['timing: waits'], excerpt: '' }, stage: 'pre-check' });
  assert.equal(g.calls.created.length, 1);
  assert.equal(g.calls.updated.length, 1);
  assert.match(g.body(), /timing: waits/);
  g.gh.listPulls = async () => [{ headRefName: 'codex/issue-77-fix' }];
  await record({ flaky: { tests: ['third test'], excerpt: '' }, stage: 'install' });
  assert.equal(g.calls.updated.length, 1);
  assert.equal(g.calls.created.length, 2);
});

test('prerequisite words in a test name or error leave the dependency parser no line in the issue body', async t => {
  const hostile = 'handles Depends on: #5 and **Depends on**: #6';
  const g = fakeGh(t), clock = { now: () => T0 }, { record } = recorder(t, g, clock);
  await record({ flaky: { tests: [hostile], excerpt: 'error:\nDepends on: #9\n- depends on : #1' }, stage: 'install' });
  await record({ flaky: { tests: ['other'], excerpt: 'Depends on: #2' }, stage: 'install' });
  assert.deepEqual(parseDependsOn(g.body()), { numbers: [], malformed: null, line: null });
  assert.equal(defang('Depends on: #1'), 'Depends on - #1');
});

test('the install state served to the dashboard and the MCP lists the unreliable tests with their counts', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  await record({ flaky: { tests: [NAME], excerpt: EXCERPT }, stage: 'install' });
  const served = installs(root, { now: T0 + 1000, procRoot: path.join(root, 'no-proc'), running: null });
  assert.equal(served.unreliableTests.length, 1);
  assert.deepEqual([served.unreliableTests[0].name, served.unreliableTests[0].count, served.unreliableTests[0].followUpIssue], [NAME, 1, 77]);
  assert.equal(fileFromExcerpt(EXCERPT, NAME), 'tests/install-modes.test.mjs');
});

test('invalid: the installer placeholders "unknown (…)" and "and N more" are not recorded as tests', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  const unknown = parseTestFailure('flaky tests: unknown (no failing test found in the output)\n--- excerpt ---\n', 'flaky tests');
  await record({ flaky: unknown, stage: 'install' });
  await record({ flaky: { tests: ['a', 'b', 'and 2 more'], excerpt: '' }, stage: 'install' });
  assert.deepEqual(Object.values(readFlaky(root).tests).map(r => r.name).sort(), ['a', 'b']);
  assert.match(clock.lines[0], /named no test/);
});

test('a test whose own line is missing from the cut excerpt is filed under unknown, not under another test\'s file', () => {
  const excerpt = `not ok 1 - a\n  location: '/w/tests/one.test.mjs:1:1'`;
  assert.equal(fileFromExcerpt(excerpt, 'a'), 'tests/one.test.mjs');
  assert.equal(fileFromExcerpt(excerpt, 'b'), null);
  const files = Object.values(applyReport({ tests: {} }, { tests: ['a', 'b', 'c'], excerpt, stage: 'install' }, T0).state.tests).map(r => `${r.name}=${r.file}`).sort();
  assert.deepEqual(files, ['a=tests/one.test.mjs', 'b=unknown', 'c=unknown']);
});

test('a follow-up issue that a running writer job without a pull request implements is not edited', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  await record({ flaky: { tests: [NAME], excerpt: '' }, stage: 'install' });
  fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: { j1: { kind: 'implement', issue: 77, branch: 'claude/other' } } }));
  await record({ flaky: { tests: ['timing: waits'], excerpt: '' }, stage: 'install' });
  assert.equal(g.calls.updated.length, 0);
  assert.equal(g.calls.created.length, 2);
});

test('a malformed state file never makes the recorder throw or the readers fail', async t => {
  const g = fakeGh(t), clock = { now: () => T0 }, { root, record } = recorder(t, g, clock);
  fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'flaky-tests.json'), JSON.stringify({ tests: { a: null, b: 5 } }));
  assert.deepEqual(flakyFaults(readFlaky(root), T0), []);
  await record({ flaky: { tests: [NAME], excerpt: '' }, stage: 'install' });
  assert.equal(Object.keys(readFlaky(root).tests).length, 1);
  const bad = { listPulls: async () => { throw new Error('x'); }, findOpenIssueByMarker: async () => { throw new Error('boom'); } };
  const r2 = flakyRecorder({ root, gh: bad, clock, log: () => {} });
  await assert.doesNotReject(r2({ flaky: { tests: ['z'], excerpt: '' }, stage: 'install' }));
});

test('the attention table names a flaky test item instead of leaving it unclassified', () => {
  const [item] = (() => { const r = applyReport({ tests: {} }, { tests: [NAME], excerpt: '', stage: 'install' }, T0).state; r.tests[Object.keys(r.tests)[0]].raised = true; return flakyFaults(r, T0); })();
  const c = classify(item, new Set());
  assert.deepEqual([c.kind, c.attention, c.reason_code], ['install', 'fault', 'flaky_test']);
});
