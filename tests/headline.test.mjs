// Issue #866: the headline progress numbers, each checked against a fixture; the cards, the drill-down and the MCP tool read the same record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { headlineStats, WINDOWS, CARD_IDS } from '../supervisor/headline.mjs';
import { compactIssues } from '../supervisor/dashdata.mjs';
import { renderRoute, matchRoute } from '../supervisor/dashrender.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { overviewView, NOW } from './helpers/lists-fixture.mjs';

const H = 3600000, ago = h => NOW - h * H;
// Issues: 1 closed 2h ago (opened 30h ago), 2 opened 5h ago and still open, 3 opened 3h ago and closed 1h ago, 4 opened 40h ago and open,
// 5 opened 100h ago closed 60h ago (previous 7d only for nothing; inside the 7d), 6 opened 300h ago closed 200h ago (outside both).
const issues = [
  { number: 1, title: 'one', state: 'CLOSED', createdAt: ago(30), closedAt: ago(2) }, { number: 2, title: 'two', state: 'OPEN', createdAt: ago(5), closedAt: null },
  { number: 3, title: 'three', state: 'CLOSED', createdAt: ago(3), closedAt: ago(1) }, { number: 4, title: 'four', state: 'OPEN', createdAt: ago(40), closedAt: null },
  { number: 5, title: 'five', state: 'CLOSED', createdAt: ago(100), closedAt: ago(60) }, { number: 6, title: 'six', state: 'CLOSED', createdAt: ago(300), closedAt: ago(200) },
];
const v = (verdict, at, extra = {}) => ({ verdict, at, reviewer: 'codex', ...extra });
const prs = [
  // merged 2h ago: first review CHANGES (3h ago), then PASS; 1 fix, 1 rebase, 2 reviews -> 4 rounds; 1000 tokens
  { number: 10, title: 'ten', status: 'merged', mergedAt: ago(2), verdicts: [v('CHANGES', ago(4)), v('PASS', ago(3))], fixRounds: 1, rebaseRounds: 1, secondOpinionRounds: 0, tokens: 1000 },
  // merged 1h ago: first review PASS; 1 review -> 1 round; 3000 tokens
  { number: 11, title: 'eleven', status: 'merged', mergedAt: ago(1), verdicts: [v('PASS', ago(1.5)), v('PASS', ago(1.2), { carry: { at: ago(1.2) } })], fixRounds: 0, rebaseRounds: 0, tokens: 3000 },
  // merged 30h ago (7d only): first PASS 31h ago; 1 review + 2 rebases -> 3 rounds; tokens unknown
  { number: 12, title: 'twelve', status: 'merged', mergedAt: ago(30), verdicts: [v('PASS', ago(31))], fixRounds: 0, rebaseRounds: 2, tokens: null },
  // open, first review CHANGES 6h ago
  { number: 13, title: 'thirteen', status: 'open', mergedAt: null, verdicts: [v('CHANGES', ago(6))], fixRounds: 0, rebaseRounds: 0 },
];
const jobs = [{ id: 'a'.repeat(32), kind: 'implement', status: 'blocked', createdAt: ago(9), updatedAt: ago(8), issue: 4, usage: { inputTokens: 40, outputTokens: 10 } }, { id: 'b'.repeat(32), kind: 'review', status: 'completed', createdAt: ago(8), updatedAt: ago(7) }, { id: 'c'.repeat(32), kind: 'fix', status: 'blocked', createdAt: ago(60), updatedAt: ago(59), issue: 5 }];
const wasteRecords = [{ job: 'w1'.repeat(8), at: ago(3), cause: 'review:no-verdict', tokens: 500, cost: 1.5, pr: 13 }, { job: 'w2'.repeat(8), at: ago(5), cause: 'implement:failed:x', tokens: 200, cost: 0.5, issue: 4 }, { job: 'w3'.repeat(8), at: ago(30), cause: 'review:no-verdict', tokens: 700, cost: 2, pr: 12 }];
const stats = () => headlineStats({ issues, prs, jobs, wasteRecords, now: NOW });
const card = (w, id) => stats().windows[w].cards[id];

test('issues: opened, closed, net and open now, for both windows, against the fixture', () => {
  const d = card('24h', 'issues');
  assert.deepEqual([d.opened, d.closed, d.net, d.openNow], [2, 2, 0, 2]);   // opened 2, 3; closed 1, 3
  assert.deepEqual(d.items.map(i => `${i.ref}:${i.detail}`).sort(), ['1:closed', '2:opened', '3:closed', '3:opened']);
  const w = card('7d', 'issues');
  assert.deepEqual([w.opened, w.closed, w.net], [5, 3, 2]);   // opened 1,2,3,4,5 ; closed 1,3,5
  assert.equal(w.count, 8);
  assert.equal(w.previous.opened, 1, 'issue 6 (opened 300h ago) is the previous 7-day period');
  assert.equal(w.previous.closed, 1, 'and it closed 200h ago, also in the previous period');
  assert.equal(w.direction, 'up'); assert.equal(w.delta, 2, 'net 2 now against net 0 before');
});

test('processed: closed out of what was open at the start plus opened', () => {
  const d = card('24h', 'processed');   // at 24h ago: 1 (opened 30h, still open), 4 (40h), 5 closed at 60h so not open, 6 closed -> open at start = 1 and 4 = 2; opened 2 and 3 -> total 4; closed 2
  assert.deepEqual([d.openAtStart, d.opened, d.total, d.processed, d.value], [2, 2, 4, 2, 50]);
  const w = card('7d', 'processed');   // at 7d ago: issue 6 closed 200h ago (before the window), so open at start 0; opened 5 -> total 5; closed 3
  assert.deepEqual([w.openAtStart, w.total, w.processed, w.value], [0, 5, 3, 60]);
});

test('merge rate: merged PRs per hour of the window', () => {
  assert.equal(card('24h', 'merge-rate').merged, 2); assert.equal(card('24h', 'merge-rate').value, round(2 / 24, 3));
  assert.equal(card('7d', 'merge-rate').merged, 3); assert.equal(card('7d', 'merge-rate').value, round(3 / 168, 3));
});
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

test('first-pass approval: share of PRs whose first review (carried verdicts excluded) was a PASS', () => {
  const d = card('24h', 'first-pass');   // first reviews in 24h: 10 CHANGES(4h), 11 PASS(1.5h), 13 CHANGES(6h)
  assert.deepEqual([d.reviewed, d.approved, d.value], [3, 1, 33.3]);
  const w = card('7d', 'first-pass');    // plus 12 PASS(31h)
  assert.deepEqual([w.reviewed, w.approved, w.value], [4, 2, 50]);
  assert.equal(card('24h', 'first-pass').items.find(i => i.ref === 11).detail, 'first review: PASS');
});

test('rounds: reviews (not carried) plus fixes plus rebases, averaged over merged PRs', () => {
  const d = card('24h', 'rounds');   // PR 10: 2+1+1 = 4; PR 11: 1+0+0 = 1 (the carried verdict is not a round)
  assert.deepEqual([d.merged, d.rounds, d.value], [2, 5, 2.5]);
  assert.equal(card('7d', 'rounds').value, round((4 + 1 + 3) / 3, 2));
  assert.match(d.items.find(i => i.ref === 10).detail, /2 review, 1 fix, 1 rebase/);
});

test('tokens per merged PR: the mean over PRs with known usage, and unknown stays unknown', () => {
  assert.equal(card('24h', 'tokens').value, 2000); assert.equal(card('7d', 'tokens').value, 2000);
  assert.equal(card('7d', 'tokens').withKnownTokens, 2); assert.equal(card('7d', 'tokens').merged, 3);
  assert.equal(card('7d', 'tokens').items.find(i => i.ref === 12).tokens, null);
  assert.equal(headlineStats({ issues: [], prs: [], jobs: [], wasteRecords: [], now: NOW }).windows['24h'].cards.tokens.value, null, 'nothing merged: no figure, not zero');
});

test('waste: tokens, top cause, and no previous 7-day period (the record holds 7 days)', () => {
  const d = card('24h', 'waste');
  assert.deepEqual([d.value, d.jobs, d.costUsdEquivalent, d.topCause], [700, 2, 2, { cause: 'review:no-verdict', tokens: 500 }]);
  const w = card('7d', 'waste');
  assert.equal(w.value, 1400); assert.equal(w.topCause.cause, 'review:no-verdict'); assert.equal(w.topCause.tokens, 1200);
  assert.equal(w.previous, null); assert.equal(w.delta, null); assert.match(w.previousNote, /7 days/);
  assert.equal(d.previous.value, 700, 'the 24h window does have a previous period (24h to 48h ago): the 30h record');
  assert.equal(d.delta, 0);
});

test('rejects: CHANGES verdicts plus blocked jobs in the period', () => {
  const d = card('24h', 'rejects');   // CHANGES: PR 10 (4h), PR 13 (6h); blocked: job a (8h); job c is 59h ago
  assert.deepEqual([d.changes, d.blocked, d.value], [2, 1, 3]);
  assert.deepEqual(card('7d', 'rejects').blocked, 2);
  assert.equal(card('24h', 'rejects').items.find(i => i.kind === 'job').tokens, 50);
});

test('trend: direction and delta against the previous period; none when there is nothing to compare', () => {
  const m = card('24h', 'merge-rate');   // previous 24h to 48h: PR 12 merged at 30h -> 1
  assert.equal(m.previous.merged, 1); assert.equal(m.direction, 'up');
  assert.equal(card('24h', 'tokens').direction, null, 'previous period has no merged PR with known usage');
});

test('every card carries its items, bounded, with the true count', () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ number: 100 + i, title: 't', state: 'OPEN', createdAt: ago(1), closedAt: null }));
  const c = headlineStats({ issues: many, now: NOW }).windows['24h'].cards.issues;
  assert.equal(c.count, 300); assert.equal(c.shown, c.items.length); assert.ok(c.shown <= 200);
  for (const id of CARD_IDS) assert.ok(Array.isArray(stats().windows['7d'].cards[id].items));
  assert.deepEqual(Object.keys(stats().windows), Object.keys(WINDOWS));
});

test('malformed records are ignored, not counted as zero-time events', () => {
  const s = headlineStats({ issues: [{ number: 1, state: 'CLOSED', title: 'x', createdAt: 'nope', closedAt: undefined }], prs: [{ number: 1, status: 'merged', mergedAt: NaN, verdicts: 'x' }], jobs: [{ status: 'blocked' }], wasteRecords: [null, { at: 'x' }], now: NOW });
  assert.equal(s.windows['7d'].cards.issues.count, 0); assert.equal(s.windows['7d'].cards['merge-rate'].merged, 0); assert.equal(s.windows['7d'].cards.rejects.value, 0); assert.equal(s.windows['7d'].cards.waste.jobs, 0);
});

test('the issue cache keeps created and closed times, and drops a bad one', () => {
  const [a, b] = compactIssues([{ number: 1, title: 't', state: 'CLOSED', labels: [], body: '', createdAt: '2026-11-01T00:00:00Z', closedAt: '2026-11-02T00:00:00Z' }, { number: 2, title: 't', state: 'OPEN', labels: [], body: '', createdAt: 'garbage' }]);
  assert.equal(a.createdAt, '2026-11-01T00:00:00Z'); assert.equal(a.closedAt, '2026-11-02T00:00:00Z'); assert.equal('createdAt' in b, false);
});

test('the real view carries the headline, the Overview shows the eight cards first, and each links to its drill-down', async () => {
  const view = await overviewView();
  assert.ok(view.headline && view.headline.windows['24h']);
  view.headline = stats();
  const html = renderRoute(view, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  for (const id of CARD_IDS) { assert.match(html, new RegExp(`data-card="hl-${id}"`)); assert.match(html, new RegExp(`href="/headline/${id}\\?window=24h"`)); }
  assert.ok(html.indexOf('data-card="hl-issues"') < html.indexOf('data-card="watching"'), 'headline cards come first');
  assert.match(html, /net \+0|net 0/); assert.match(html, /2 open now/);
  assert.match(html, /not a cash charge/);
});

test('drill-down: the table lists the items behind the number, with a totals footer, sorting and paging in the URL', async () => {
  const view = await overviewView(); view.headline = stats();
  assert.deepEqual(matchRoute('/headline/rounds'), { page: 'headline', id: 'rounds' }); assert.equal(matchRoute('/headline/nonsense'), null);
  const r = renderRoute(view, matchRoute('/headline/tokens'), { query: new URLSearchParams('window=7d'), pathname: '/headline/tokens' });
  assert.equal(r.status, 200);
  assert.match(r.html, /data-table="hl"/); assert.match(r.html, /<tfoot>/); assert.match(r.html, /hl\.sort=tokens/);
  assert.match(r.html, /PR #10|#10/); assert.match(r.html, />4,000</, 'the footer sums the known tokens (1000 + 3000)');
  const sorted = renderRoute(view, matchRoute('/headline/tokens'), { query: new URLSearchParams('window=7d&hl.sort=tokens&hl.dir=desc'), pathname: '/headline/tokens' }).html;
  assert.ok(sorted.indexOf('PR #11') < sorted.indexOf('PR #10'), 'sorted by tokens, largest first');
  const bad = renderRoute(view, { page: 'headline', id: 'nope' }, { query: new URLSearchParams(), pathname: '/headline/nope' });
  assert.equal(bad.status, 404);
});

test('foreman_headline: the summary has no item lists; a card lists its items; a bad card is refused', async () => {
  const view = { headline: stats() };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0, stale: false }) }, readHost: () => ({}), now: () => NOW });
  const sum = JSON.parse((await tools.call('foreman_headline', {})).text);
  assert.equal(sum.windows['24h'].cards.rejects.value, 3); assert.equal(sum.windows['24h'].cards.rejects.items, undefined);
  const one = JSON.parse((await tools.call('foreman_headline', { card: 'rejects', window: '7d', limit: 2 })).text);
  assert.equal(one.value, 4); assert.equal(one.items.length, 2); assert.equal(one.count, 4);
  const bad = await tools.call('foreman_headline', { card: 'nope' }); assert.equal(bad.isError, true);
  const none = JSON.parse((await createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), now: () => NOW }).call('foreman_headline', {})).text);
  assert.equal(none.available, false);
});
