// Issue #624: foreman_mismatches and foreman_needs_you (D-030). Pure readings of the dashboard view; secret-shaped fixtures are built at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../foreman-mcp/tools.mjs';
import { causeOf, mismatches, needsYouGroups } from '../foreman-mcp/insights.mjs';

const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const PW = ['pass', 'word'].join(''), PWVAL = ['hunter2', 'hunter2x'].join('');
const NOW = 10 * 24 * 3600000, OLD = 'a'.repeat(32), NEW = 'b'.repeat(32);
const card = (id, n, extra = {}) => ({ id, text: `PR #${n} needs the homeowner`, ref: { kind: 'pr', n }, action: 'Decide.', severity: 'action', ...extra });
const view = () => ({
  attention: [], issues: [], prs: [], jobs: [],
  panels: { needsYou: [card('homeowner-pr-1', 1), card('homeowner-pr-2', 2), card('homeowner-pr-3', 3), card('decision-D-024', 9, { ref: null }), card('job-' + 'c'.repeat(32), 5, { ref: null, decision: 'Look at it.' })] },
});
const toolsFor = v => createTools({ source: { get: async () => ({ view: v, ageMs: 0, stale: false }) }, readHost: () => ({}), now: () => NOW });

test('causeOf strips the numeric or hex tail of an item id', () => {
  assert.equal(causeOf('homeowner-pr-538'), 'homeowner-pr'); assert.equal(causeOf('job-' + 'c'.repeat(32)), 'job'); assert.equal(causeOf('stale-mark-12'), 'stale-mark'); assert.equal(causeOf('tick-failed'), 'tick-failed'); assert.equal(causeOf(undefined), 'unknown');
});

test('needs you: a cluster of one cause is one group with the real count, and the other causes stay separate', () => {
  const g = needsYouGroups(view());
  assert.equal(g.totalItems, 5); assert.equal(g.distinctCauses, 3);
  assert.equal(g.groups[0].cause, 'homeowner-pr'); assert.equal(g.groups[0].count, 3); assert.deepEqual(g.groups[0].refs, ['pr #1', 'pr #2', 'pr #3']);
  assert.deepEqual(g.groups[0].actions, [{ action: 'Decide.', items: 3 }]);
  assert.equal(needsYouGroups({ attention: [] }).totalItems, 0, 'nothing to group');
  assert.equal(needsYouGroups({ attention: [card('x-1', 1), { id: 'w', severity: 'warning', text: 'w' }] }).totalItems, 1, 'without panels only action items count');
});

test('mismatches: each of the four kinds is found, and a healthy view finds none', () => {
  assert.equal(mismatches(view(), NOW).count, 0);
  const v = view();
  v.issues = [{ number: 10, state: 'OPEN', reason: 'started earlier; no PR yet', labels: [] }, { number: 11, state: 'OPEN', reason: 'started earlier; no PR yet', labels: [] }, { number: 12, state: 'CLOSED', labels: ['needs-homeowner'] }, { number: 13, state: 'CLOSED', labels: [] }];
  v.prs = [{ number: 20, status: 'open', issue: 11, needsHomeowner: false }, { number: 21, status: 'open', needsHomeowner: true, awaitingReview: false }, { number: 22, status: 'open', needsHomeowner: true, awaitingReview: true }, { number: 1, status: 'open', needsHomeowner: true, jobs: [{ fullId: NEW }] }];
  v.jobs = [{ fullId: OLD, startedAt: NOW - 3600000, status: 'stopped' }, { fullId: NEW, startedAt: NOW - 60000, status: 'running', ref: 1 }];
  v.panels.needsYou.push(card('reviewrefused-30', 30), card('noreviewer-refused-31', 31));
  v.panels.needsYou[0] = card('homeowner-pr-1', 1, { tried: `Foreman labelled this PR needs-homeowner because job ${OLD.slice(0, 8)} stopped` });
  const m = mismatches(v, NOW), by = k => m.items.filter(i => i.kind === k).map(i => i.ref);
  assert.deepEqual(by('implemented-without-pr'), ['issue #10'], 'issue 11 has a PR; 13 is not flagged');
  assert.deepEqual(by('finished-not-recorded'), ['pr #30', 'pr #31']);
  assert.deepEqual(by('stale-label').sort(), ['issue #12', 'pr #21'], 'a PR awaiting review (22) or with a card (1) is not stale');
  assert.deepEqual(by('hold-by-old-job'), ['pr #1']);
  assert.match(m.items.find(i => i.kind === 'hold-by-old-job').what, /newer job/);
});

test('mismatches: a hold by a job over 24 hours old with no newer job is found; a recent one is not', () => {
  const v = view(); v.prs = [{ number: 1, status: 'open', needsHomeowner: true, jobs: [] }];
  v.panels.needsYou[0] = card('homeowner-pr-1', 1, { tried: `because job ${OLD.slice(0, 8)} stopped` });
  v.jobs = [{ fullId: OLD, startedAt: NOW - 3 * 24 * 3600000, status: 'stopped' }];
  assert.equal(mismatches(v, NOW).items.filter(i => i.kind === 'hold-by-old-job').length, 1);
  v.jobs[0].startedAt = NOW - 1000; assert.equal(mismatches(v, NOW).count, 0);
});

test('the lists are bounded and the true count is stated', () => {
  const v = view(); v.issues = Array.from({ length: 100 }, (_, i) => ({ number: 100 + i, state: 'CLOSED', labels: ['needs-homeowner'] }));
  const m = mismatches(v, NOW); assert.equal(m.count, 100); assert.equal(m.items.length, 40);
});

test('through the tools: both are listed read-only, take no arguments, and no secret-shaped text escapes', async () => {
  const v = view(); v.panels.needsYou.push(card('homeowner-pr-4', 4, { text: `leak ${GH} ${PW}=${PWVAL}`, action: `use ${GH}`, decision: `Bearer ${['abcdefgh', 'ijklmnop', '1234'].join('')}` }));
  v.issues = [{ number: 12, state: 'CLOSED', labels: ['needs-homeowner'] }];
  v.panels.needsYou.push(card('reviewrefused-40', 40, { text: `refused ${GH} ${PW}=${PWVAL}` }));
  const t = toolsFor(v), list = t.list();
  for (const n of ['foreman_mismatches', 'foreman_needs_you']) { const d = list.find(x => x.name === n); assert.equal(d.annotations.readOnlyHint, true); assert.deepEqual(d.inputSchema.properties, {}); }
  for (const n of ['foreman_mismatches', 'foreman_needs_you']) {
    const r = await t.call(n, {}); assert.equal(r.isError, false);
    for (const bad of [GH, PWVAL, 'ijklmnop']) assert.ok(!r.text.includes(bad), `${n} leaked ${bad.slice(0, 5)}`);
  }
  assert.equal(JSON.parse((await t.call('foreman_needs_you', {})).text).totalItems, 7);
  assert.ok(JSON.parse((await t.call('foreman_mismatches', {})).text).count >= 2);
});
