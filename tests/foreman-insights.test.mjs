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
  v.prs = [{ number: 20, status: 'open', issue: 11, needsHomeowner: false }, { number: 21, status: 'open', needsHomeowner: true, awaitingReview: false }, { number: 22, status: 'open', needsHomeowner: true, awaitingReview: true }, { number: 1, status: 'open', needsHomeowner: true, head: 'f'.repeat(40), jobs: [{ fullId: NEW }] }];
  v.jobs = [{ fullId: OLD, startedAt: NOW - 3600000, status: 'stopped', head: 'e'.repeat(40) }, { fullId: NEW, startedAt: NOW - 60000, status: 'running', ref: 1 }];
  v.panels.needsYou.push(card('reviewrefused-30', 30), card('noreviewer-refused-31', 31, { ref: 31 }));
  v.panels.needsYou[0] = card('homeowner-pr-1', 1, { tried: `Foreman labelled this PR needs-homeowner because job ${OLD.slice(0, 8)} stopped` });
  const m = mismatches(v, NOW), by = k => m.items.filter(i => i.kind === k).map(i => i.ref);
  assert.deepEqual(by('implemented-without-pr'), ['issue #10'], 'issue 11 has a PR; 13 is not flagged');
  assert.deepEqual(by('finished-not-recorded'), ['pr #30', 'pr #31']);
  assert.deepEqual(by('stale-label').sort(), ['issue #12', 'pr #21'], 'a PR awaiting review (22) or with a card (1) is not stale');
  assert.deepEqual(by('hold-by-old-job'), ['pr #1']);
  assert.match(m.items.find(i => i.kind === 'hold-by-old-job').what, /head has moved/);
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

// Issue #633: foreman_rebase_stats.
import { rebaseStats } from '../foreman-mcp/insights.mjs';
const H = 3600000;
const merged = (n, openAt, mergedAt, rebaseRounds, reviewRounds) => ({ number: n, status: 'merged', mergedAt, rebaseRounds, reviewRounds, timeline: openAt === null ? [] : [{ at: openAt }, { at: mergedAt }] });

test('rebase stats: per-pull-request averages and open-to-merge time, before and after a split', () => {
  const v = { prs: [merged(1, 0, 10 * H, 4, 3), merged(2, 0, 20 * H, 2, 2), merged(3, 100 * H, 104 * H, 0, 1), merged(4, 100 * H, 108 * H, 1, 1), { number: 5, status: 'open', rebaseRounds: 9, reviewRounds: 9, timeline: [{ at: 1 }] }] };
  const s = rebaseStats(v, { splitAt: new Date(50 * H).toISOString() });
  assert.equal(s.all.pullRequests, 4, 'an open pull request is not counted');
  assert.deepEqual([s.before.pullRequests, s.before.rebases.perPullRequest, s.before.reviews.perPullRequest, s.before.openToMergeHours.median], [2, 3, 2.5, 15]);
  assert.deepEqual([s.after.pullRequests, s.after.rebases.perPullRequest, s.after.reviews.perPullRequest, s.after.openToMergeHours.mean], [2, 0.5, 1, 6]);
  assert.equal(s.recent[0].pr, 4, 'newest merge first');
});

test('rebase stats: no merges gives nulls, a missing timestamp leaves out only the time, a bad splitAt is refused', () => {
  assert.equal(rebaseStats({ prs: [] }).all.rebases.perPullRequest, null);
  const s = rebaseStats({ prs: [merged(1, null, 5 * H, 2, 1)] });
  assert.equal(s.all.pullRequests, 1); assert.equal(s.all.rebases.total, 2); assert.equal(s.all.openToMergeHours.measured, 0); assert.equal(s.all.openToMergeHours.median, null);
  assert.throws(() => rebaseStats({ prs: [] }, { splitAt: 'not a date' }), /splitAt/);
});

test('rebase stats tool: read-only, bounded, and no secret-shaped text escapes (fixtures built at run time)', async () => {
  const v = { prs: [{ ...merged(7, 0, H, 1, 1), name: `leak ${GH}` }, merged(8, 0, 2 * H, 0, 1)] };
  const t = toolsFor(v), d = t.list().find(x => x.name === 'foreman_rebase_stats');
  assert.equal(d.annotations.readOnlyHint, true);
  const r = await t.call('foreman_rebase_stats', { splitAt: `${new Date(H).toISOString()} ${GH} ${PW}=${PWVAL}` });
  assert.equal(r.isError, true, 'a splitAt that is not a date is refused');
  for (const bad of [GH, PWVAL]) assert.ok(!r.text.includes(bad), 'the refusal does not echo secret-shaped input');
  const ok = await t.call('foreman_rebase_stats', { limit: 1 }); assert.equal(ok.isError, false);
  const j = JSON.parse(ok.text); assert.equal(j.recent.length, 1); assert.equal(j.all.pullRequests, 2);
  for (const bad of [GH, PWVAL]) assert.ok(!ok.text.includes(bad));
});

test('rebase stats (#633): carried verdicts are not reviews; the merge entry is not the start of the timeline', () => {
  const p = { number: 7, status: 'merged', mergedAt: 10 * H, rebaseRounds: 3, reviewRounds: 4, verdicts: [{}, { carry: { at: 1 } }, { carry: { at: 2 } }, { carry: { at: 3 } }], timeline: [{ at: 10 * H, text: 'merged' }] };
  const s = rebaseStats({ prs: [p, { ...p, number: 8, timeline: [{ at: 4 * H, text: 'x' }, { at: 10 * H, text: 'merged' }] }] });
  assert.equal(s.all.reviews.total, 2); assert.equal(s.all.reviews.carriedTotal, 6);
  assert.equal(s.all.openToMergeHours.measured, 1, 'a PR whose only entry is the merge has no duration');
  assert.equal(s.all.openToMergeHours.median, 6);
});

test('rebase stats (#717): the merge-log start beats a late first timeline entry; second opinions count as reviews', () => {
  const base = { number: 9, status: 'merged', mergedAt: 100 * H, rebaseRounds: 0, reviewRounds: 1, verdicts: [{}], timeline: [{ at: 90 * H, text: 'x' }, { at: 100 * H, text: 'merged' }] };
  const s = rebaseStats({ prs: [{ ...base, startedAt: 40 * H, secondOpinionRounds: 1 }, { ...base, number: 10 }] });
  assert.equal(s.all.reviews.total, 3);
  assert.equal(s.recent.find(r => r.pr === 9).openToMergeHours, 60, 'from startedAt');
  assert.equal(s.recent.find(r => r.pr === 10).openToMergeHours, 10, 'falls back to the first timeline entry');
});

test('a bare numeric ref (noreviewer-refused) is read as a pull request in both tools', () => {
  const v = view(); v.panels.needsYou.push(card('noreviewer-refused-31', 31, { ref: 31 }));
  assert.deepEqual(mismatches(v, NOW).items.filter(i => i.kind === 'finished-not-recorded').map(i => i.ref), ['pr #31']);
  assert.ok(needsYouGroups(v).groups.find(g => g.cause === 'noreviewer-refused').refs.includes('pr #31'));
});

test('causeOf keeps decisions apart and merges agent-suffixed ids', () => {
  assert.notEqual(causeOf('decision-D-020'), causeOf('decision-D-024'));
  assert.equal(causeOf('pause-claude'), causeOf('pause-codex')); assert.equal(causeOf('idle-claude'), 'idle');
  assert.equal(causeOf('homeowner-pr-538'), 'homeowner-pr');
});

test('hold-by-old-job: a newer job on the same head does not overtake the hold; a moved head does; an unknown held job is reported', () => {
  const v = view(), H = 'e'.repeat(40);
  v.prs = [{ number: 1, status: 'open', needsHomeowner: true, head: H, jobs: [{ fullId: NEW }] }];
  v.panels.needsYou[0] = card('homeowner-pr-1', 1, { tried: `because job ${OLD.slice(0, 8)} stopped` });
  v.jobs = [{ fullId: OLD, startedAt: NOW - 3600000, status: 'stopped', head: H }, { fullId: NEW, startedAt: NOW - 60000, status: 'done', head: H }];
  assert.equal(mismatches(v, NOW).count, 0, 'a newer review job on the same head is not an overtake');
  v.prs[0].head = 'f'.repeat(40); assert.equal(mismatches(v, NOW).items.filter(i => i.kind === 'hold-by-old-job').length, 1);
  v.jobs = []; const m = mismatches(v, NOW); assert.equal(m.count, 0); assert.equal(m.notChecked.length, 1);
});

test('stale-label: an issue card with the same number does not hide a labelled PR', () => {
  const v = view(); v.panels.needsYou = [card('homeowner-77', 77, { ref: { kind: 'issue', n: 77 } })];
  v.prs = [{ number: 77, status: 'open', needsHomeowner: true, awaitingReview: false }];
  assert.deepEqual(mismatches(v, NOW).items.filter(i => i.kind === 'stale-label').map(i => i.ref), ['pr #77']);
});
