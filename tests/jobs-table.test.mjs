// Issue #1220: the Jobs table. The row builder over the two real job records (the blocked rebase 60b46719 of PR #1180 and its review 91896f66),
// each filter, grouping, the totals row (with a job of unknown cost), the CSV, then the real Work route and the browser-side logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_KEYS, FACETS, NO_CAUSE, allJobRows, applyFilters, buildRow, csvCell, facetCounts, groupRows, jobsQuery, parseJobsQuery, sameRef, sortRows, toCsv, totalsRow } from '../supervisor/dashui/jobs-table.mjs';
import { KEYS, bindJobs, cleanName, currentCsv, lastQuery, restoreTarget, sanitizeColumns, sanitizeViews, saveView, visibleColumns } from '../supervisor/dashui/jobs-ui.mjs';
import { jobTableFields } from '../supervisor/jobs-fields.mjs';
import { decisionCard } from '../supervisor/decisiontable.mjs';
import { matchRoute, renderRoute } from '../supervisor/dashrender.mjs';
import { NOW, REBASE_ID, REVIEW_ID, fixtureView, jobRecords, stateRecords } from './helpers/jobs-fixture.mjs';

const q = s => new URLSearchParams(s);
const base = () => parseJobsQuery(q(''));
const byId = (rows, id) => rows.find(r => r.id === id);
const ids = rows => rows.map(r => r.id).sort().join(' ');
const FAILED_UNKNOWN = 'f1f1f1f1', REBASE = '60b46719', REVIEW = '91896f66', OLD = 'c0c0c0c0';

test('the row builder over the real blocked rebase of PR #1180', async () => {
  const r = byId(allJobRows(await fixtureView()), REBASE);
  assert.deepEqual({ id: r.id, kind: r.kind, agent: r.agent, model: r.model, effort: r.effort, ref: r.ref, refKind: r.refKind, status: r.status, cause: r.cause, attempts: r.attempts },
    { id: REBASE, kind: 'rebase', agent: 'claude', model: 'sonnet', effort: 'low', ref: 1180, refKind: 'pr', status: 'blocked', cause: 'deterministic', attempts: 2 });
  assert.equal(r.fullId, REBASE_ID);
  assert.equal(r.tokensIn, 3393004);
  assert.equal(r.tokensOut, 34980);
  assert.equal(r.tokensIn + r.tokensOut, 3427984);
  assert.equal(r.costGbp, 1.21, '1.61 USD equivalent shown in pounds at the configured 0.75 rate');
  assert.equal(r.wasted, 3427984, 'a blocked job spent all its tokens without a result');
  assert.match(r.causeLabel, /^deterministic/);
});

test('the row builder over the real completed review of PR #1180', async () => {
  const r = byId(allJobRows(await fixtureView()), REVIEW);
  assert.deepEqual({ kind: r.kind, model: r.model, effort: r.effort, ref: r.ref, refKind: r.refKind, status: r.status, cause: r.cause, wasted: r.wasted, tokensIn: r.tokensIn, tokensOut: r.tokensOut },
    { kind: 'review', model: 'opus', effort: 'medium', ref: 1180, refKind: 'pr', status: 'completed', cause: null, wasted: 0, tokensIn: 1840095, tokensOut: 15749 });
  assert.equal(r.fullId, REVIEW_ID);
  assert.equal(r.costGbp, 0.95);
});

test('unknown tokens and cost stay null in the row, never 0; an implement job refers to an issue', async () => {
  const rows = allJobRows(await fixtureView());
  const u = byId(rows, FAILED_UNKNOWN);
  assert.deepEqual([u.tokensIn, u.tokensOut, u.costGbp, u.wasted], [null, null, null, null]);
  assert.equal(u.refKind, 'issue');
  assert.equal(buildRow({ fullId: 'x'.repeat(32), id: 'xxxxxxxx', status: 'queued' }).ref, null);
});

test('the postcondition and cause fields come from the job record and the failure record', () => {
  const [rebase] = jobRecords();
  const f = jobTableFields(rebase, stateRecords());
  assert.equal(f.cause, 'deterministic');
  assert.equal(f.postcondition.kind, 'rebased');
  assert.equal(f.postcondition.met, false);
  assert.match(f.postcondition.because, /postcondition_not_met: no new head was pushed/);
  assert.match(f.causeDetail, /the same stop/);
  const review = jobTableFields(jobRecords()[1], stateRecords());
  assert.deepEqual([review.cause, review.postcondition.met, review.postcondition.because], [null, true, null]);
  assert.equal(jobTableFields({ id: 'z', status: 'queued' }, {}).wastedTokens, null, 'no usage reported: unknown, not 0');
  assert.equal(jobTableFields({ id: 'z', status: 'failed', usage: { inputTokens: 5, outputTokens: 1 } }, {}).wastedTokens, 6);
  assert.equal(jobTableFields({ id: 'z', status: 'failed' }, { failCauses: { records: { z: { cause: 'not-in-the-list' } } } }).cause, null, 'only the fixed list of causes is accepted');
});

test('each filter selects the jobs it names', async () => {
  const rows = allJobRows(await fixtureView());
  const only = change => ids(applyFilters(rows, { ...base(), ...change }, NOW));
  assert.equal(only({}), [FAILED_UNKNOWN, REVIEW, REBASE, OLD].sort().join(' '));
  assert.equal(only({ agent: 'codex' }), OLD);
  assert.equal(only({ kind: 'review' }), REVIEW);
  assert.equal(only({ status: 'blocked' }), REBASE);
  assert.equal(only({ status: 'completed' }), [REVIEW, OLD].sort().join(' '));
  assert.equal(only({ cause: 'deterministic' }), REBASE);
  assert.equal(only({ cause: NO_CAUSE }), [FAILED_UNKNOWN, REVIEW, OLD].sort().join(' '));
  assert.equal(only({ range: '24h' }), [FAILED_UNKNOWN, REVIEW, REBASE].sort().join(' '), 'the 20 day old job is out of the last 24 hours');
  assert.equal(only({ range: '7d' }), [FAILED_UNKNOWN, REVIEW, REBASE].sort().join(' '));
  assert.equal(only({ q: '#1180' }), [REVIEW, REBASE].sort().join(' '));
  assert.equal(only({ q: 'pr 1180 opus' }), REVIEW);
  assert.equal(only({ q: 'deterministic' }), REBASE);
  assert.equal(only({ q: REBASE }), REBASE);
  assert.equal(only({ status: 'blocked', agent: 'codex' }), '', 'filters combine');
  assert.equal(only({ status: 'blocked', range: '24h', q: 'rebase' }), REBASE);
});

test('the day range excludes a job that has no start time', () => {
  const r = buildRow({ fullId: 'a'.repeat(32), id: 'aaaaaaaa', status: 'queued' });
  assert.equal(applyFilters([r], { ...base(), range: '24h' }, NOW).length, 0);
});

test('filter buttons count what choosing them would show, with the other filters kept', async () => {
  const rows = allJobRows(await fixtureView());
  const none = facetCounts(rows, base(), NOW);
  assert.deepEqual(none.agent, [{ value: 'claude', count: 3 }, { value: 'codex', count: 1 }]);
  assert.deepEqual(none.status.map(s => [s.value, s.count]), [['completed', 2], ['blocked', 1], ['failed', 1]]);
  assert.deepEqual(none.cause, [{ value: NO_CAUSE, count: 3 }, { value: 'deterministic', count: 1 }]);
  assert.deepEqual(none.range.map(r => [r.value, r.count]), [['24h', 3], ['7d', 3]]);
  const blocked = facetCounts(rows, { ...base(), status: 'blocked' }, NOW);
  assert.deepEqual(blocked.status.map(s => [s.value, s.count]), [['completed', 2], ['blocked', 1], ['failed', 1]], 'the status buttons ignore the status filter itself');
  assert.deepEqual(blocked.agent, [{ value: 'claude', count: 1 }], 'the other buttons count inside it');
  assert.deepEqual(facetCounts(rows, { ...base(), agent: 'nobody' }, NOW).agent.find(a => a.value === 'nobody'), { value: 'nobody', count: 0 }, 'a filter on a value no job has still shows its button');
  assert.deepEqual(FACETS.map(f => f.id), ['agent', 'kind', 'status', 'cause']);
});

test('grouping by cause, agent, kind and ref', async () => {
  const rows = allJobRows(await fixtureView());
  const g = by => groupRows(rows, by).map(x => [x.label, x.rows.length]);
  assert.deepEqual(g('cause'), [['No cause recorded', 3], [rows.find(r => r.cause).causeLabel, 1]]);
  assert.deepEqual(g('agent'), [['claude', 3], ['codex', 1]]);
  assert.deepEqual(g('kind'), [['implement', 2], ['rebase', 1], ['review', 1]]);
  assert.deepEqual(g('ref'), [['PR #1180', 2], ['Issue #2', 1], ['Issue #30', 1]]);
  assert.equal(groupRows(rows, '').length, 1);
  assert.equal(groupRows(rows, '')[0].rows.length, 4);
});

test('sorting puts unknown values last in either direction', async () => {
  const rows = allJobRows(await fixtureView());
  assert.equal(sortRows(rows, 'costGbp', 'desc').at(-1).id, FAILED_UNKNOWN);
  assert.equal(sortRows(rows, 'costGbp', 'asc').at(-1).id, FAILED_UNKNOWN);
  assert.deepEqual(sortRows(rows, 'costGbp', 'desc').slice(0, 2).map(r => r.id), [REBASE, REVIEW]);
  assert.deepEqual(sortRows(rows, 'startedAt', 'desc').map(r => r.id), [FAILED_UNKNOWN, REVIEW, REBASE, OLD]);
  assert.equal(sortRows(rows, 'wasted', 'desc')[0].id, REBASE);
});

test('the totals row counts jobs, tokens, cost and wasted tokens, and says how many were unknown', async () => {
  const rows = allJobRows(await fixtureView());
  const t = totalsRow(rows);
  assert.equal(t.jobs, 4);
  assert.deepEqual(t.tokens, { total: 3427984 + 1855844 + 1500, unknown: 1 });
  assert.deepEqual(t.cost, { total: 1.21 + 0.95 + 0.15, unknown: 1 });
  assert.deepEqual(t.wasted, { total: 3427984, unknown: 1 });
  assert.equal(t.shareWasted, Math.round((3427984 / (3427984 + 1855844 + 1500)) * 1000) / 10, 'share over the jobs where both are known');
  const blocked = totalsRow(applyFilters(rows, { ...base(), status: 'blocked' }, NOW));
  assert.deepEqual([blocked.jobs, blocked.wasted.total, blocked.shareWasted, blocked.cost.unknown], [1, 3427984, 100, 0]);
  const unknownOnly = totalsRow([byId(rows, FAILED_UNKNOWN)]);
  assert.deepEqual([unknownOnly.tokens.total, unknownOnly.cost.total, unknownOnly.wasted.total, unknownOnly.shareWasted], [null, null, null, null]);
  assert.deepEqual(totalsRow([]).tokens, { total: null, unknown: 0 });
});

test('the CSV has a header, one line per row, pounds, and the word unknown for unknown values', async () => {
  const rows = sortRows(allJobRows(await fixtureView()), 'startedAt', 'desc');
  const lines = toCsv(rows).trimEnd().split('\r\n');
  assert.equal(lines.length, 5);
  assert.equal(lines[0], 'Id,Kind,Agent,Model,Effort,Ref,Status,Cause,Started,Duration (s),Tokens in,Tokens out,Cost (GBP),Attempts,Wasted tokens');
  const rebase = lines.find(l => l.startsWith(REBASE_ID));
  assert.match(rebase, /,rebase,claude,sonnet,low,PR #1180,blocked,deterministic \(the same failure repeats\),/);
  assert.match(rebase, /,3393004,34980,1\.21,2,3427984$/);
  const unknown = lines.find(l => l.startsWith('f1f1'));
  assert.match(unknown, /,unknown,unknown,unknown,2?1?,?/);
  assert.ok(unknown.split(',').filter(c => c === 'unknown').length >= 4, unknown);
  assert.ok(!/,0\.00,/.test(unknown), 'unknown cost is not written as zero');
  assert.equal(toCsv(rows, ['id', 'costGbp']).split('\r\n')[0], 'Id,Cost (GBP)');
  assert.equal(toCsv([], ['id']), 'Id\r\n');
});

test('a CSV cell that a spreadsheet would run as a formula is kept as text, and commas and quotes are escaped', () => {
  assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvCell('@cmd'), "'@cmd");
  assert.equal(csvCell('-5'), '-5');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), 'unknown');
});

test('the other jobs on the same pull request, oldest first', async () => {
  const rows = allJobRows(await fixtureView());
  assert.deepEqual(sameRef(rows, byId(rows, REBASE)).map(r => r.id), [REBASE, REVIEW]);
  assert.deepEqual(sameRef(rows, byId(rows, OLD)).map(r => r.id), [OLD]);
  assert.deepEqual(sameRef(rows, buildRow({ fullId: 'b'.repeat(32), status: 'queued' })), []);
});

test('the address query round trips and rejects values outside the lists', () => {
  const f = parseJobsQuery(q('view=jobs&status=blocked&group=cause&range=7d&sort=costGbp&dir=asc&q=pr&page=2&job=60b46719'));
  assert.deepEqual([f.status, f.group, f.range, f.sort, f.dir, f.q, f.page, f.job], ['blocked', 'cause', '7d', 'costGbp', 'asc', 'pr', 2, '60b46719']);
  assert.deepEqual(parseJobsQuery(q(jobsQuery(f))), f);
  const bad = parseJobsQuery(q('group=evil&range=9y&sort=__proto__&dir=up&page=-3&job=../x'));
  assert.deepEqual([bad.group, bad.range, bad.sort, bad.dir, bad.page, bad.job], ['', '', 'startedAt', 'desc', 1, '']);
  assert.ok(COLUMN_KEYS.length === 15);
  assert.equal(jobsQuery(base()), 'view=jobs&sort=startedAt&dir=desc', 'never a bare address, which is the one that restores the saved view');
});

// ---- the real Work route ----
const render = async (search, view) => renderRoute(view || await fixtureView(), matchRoute('/work'), { query: q(search), pathname: '/work' });

test('the Jobs view on the real Work route shows the table, the filter buttons with counts and the totals row', async () => {
  const { status, html } = await render('view=jobs');
  assert.equal(status, 200);
  for (const key of COLUMN_KEYS) assert.ok(html.includes(`data-col="${key}"`), key);
  assert.match(html, /data-chip="status:blocked"[^>]*>blocked <span class="qf-n">1<\/span>/);
  assert.match(html, /data-chip="range:24h"[^>]*>Last 24 hours <span class="qf-n">3<\/span>/);
  assert.match(html, /data-total="Jobs"><b>Jobs<\/b> 4/);
  assert.match(html, /data-total="Cost"><b>Cost<\/b> £2\.31 \(1 unknown\)/);
  assert.match(html, /data-total="Share wasted"><b>Share wasted<\/b> 64\.9%/);
  assert.equal((html.match(/<tr data-job=/g) || []).length, 4);
  assert.match(html, /<td class="c-costGbp num" data-label="Cost \(£\)">unknown<\/td>/);
});

test('filtering to blocked and grouping by cause on the real route', async () => {
  const { html } = await render('view=jobs&status=blocked&group=cause');
  assert.equal((html.match(/<tr data-job=/g) || []).length, 1);
  assert.match(html, /data-group-row="deterministic[^"]*"/);
  assert.match(html, /data-chip="status:blocked"[^>]*aria-current="true"/);
  assert.match(html, /data-group="cause"[^>]*aria-current="true"/);
  assert.match(html, /data-total="Jobs"><b>Jobs<\/b> 1/);
});

test('an empty result says so and offers Clear filters', async () => {
  const { html } = await render('view=jobs&agent=nobody');
  assert.match(html, /No jobs match/);
  assert.match(html, /data-clear-filters/);
});

test('the side panel of the blocked rebase: record, postcondition, other jobs on PR #1180, transcript state', async () => {
  const { html } = await render(`view=jobs&job=${REBASE}`);
  assert.match(html, /data-job-panel="60b46719"/);
  assert.match(html, /data-job-record>/);
  assert.match(html, /data-job-postcondition>rebased: Not met/);
  assert.match(html, /postcondition_not_met: no new head was pushed: the branch is unchanged/);
  assert.match(html, /Cause detail<\/dt><dd>the same stop/);
  const same = [...html.matchAll(/data-same-ref="([0-9a-f]{8})"/g)].map(m => m[1]);
  assert.deepEqual(same, [REBASE, REVIEW], 'the other jobs on PR #1180, oldest first');
  assert.match(html, /<li aria-current="true" data-same-ref="60b46719"/);
  assert.match(html, /No transcript was kept/);
  assert.match(html, /No overseer note|data-job-overseer/);
  assert.match(html, /aria-selected="true"/);
});

test('the panel offers the shared decision card controls of this job and nothing else', async () => {
  const item = { id: `job-${REBASE}`, text: 'The rebase job is blocked.', tried: 'Two attempts.', severity: 'action', ref: { kind: 'pull', n: 1180 } };
  const other = { id: 'job-f1f1f1f1f1f1f1f1', text: 'Another job.', ref: { kind: 'issue', n: 30 } };
  const view = await fixtureView({ needsYou: [item, other].map(a => ({ ...a, card: decisionCard(a, {}) })) });
  const { html } = await render(`view=jobs&job=${REBASE}`, view);
  const panel = html.slice(html.indexOf('data-job-panel='));
  assert.match(panel, /name="control" value="resume_job"/);
  assert.match(panel, /name="control" value="close_job"/);
  assert.match(panel, /action="\/decision"/);
  assert.ok(!panel.includes('Another job.'), 'the other job\'s card is not shown here');
  const none = (await render(`view=jobs&job=${REVIEW}`, view)).html;
  assert.match(none, /No action applies to this job now/);
});

test('the panel offers the retry-cap card of the job\'s kind and item as its retry control', async () => {
  const cap = { id: 'retrycap-rebase-1180', text: 'Foreman stopped the rebase of PR #1180 after repeated attempts.', severity: 'action', ref: { kind: 'pull', n: 1180 } };
  const wrongItem = { id: 'retrycap-rebase-30', text: 'The rebase of PR #30 is stopped.', ref: { kind: 'pull', n: 30 } };
  const view = await fixtureView({ needsYou: [cap, wrongItem].map(a => ({ ...a, card: decisionCard(a, {}) })) });
  const panel = (await render(`view=jobs&job=${REBASE}`, view)).html;
  const shown = panel.slice(panel.indexOf('data-job-panel='));
  assert.match(shown, /name="control" value="clear_retry_cap"/);
  assert.ok(!shown.includes('PR #30 is stopped'), 'the card of another item is not shown');
  const review = (await render(`view=jobs&job=${REVIEW}`, view)).html;
  assert.match(review, /No action applies to this job now/, 'a review job has another kind, so the rebase card does not apply');
});

test('an unknown job id and no selection both give a plain panel', async () => {
  assert.match((await render('view=jobs&job=deadbeef')).html, /No such job/);
  assert.match((await render('view=jobs')).html, /No job selected/);
});

test('the Work tab still opens on the queue, with a switch to Jobs; the Queue text is there', async () => {
  const { status, html } = await render('');
  assert.equal(status, 200);
  assert.match(html, /Queue/);
  assert.match(html, /<a class="qf on" href="\/work" aria-current="true" data-work-view="queue">/);
  assert.match(html, /<a class="qf" href="\/work\?view=jobs" data-work-view="jobs">/);
});

test('text from a job record is escaped in the table and the panel', async () => {
  const jobs = jobRecords();
  jobs[0].model = '<img src=x onerror=alert(1)>';
  const { html } = await render(`view=jobs&job=${REBASE}`, await fixtureView({ jobs }));
  assert.ok(!html.includes('<img src=x'));
  assert.match(html, /&lt;img src=x/);
});

// ---- the browser side ----
test('column choices keep only known columns and sensible widths, and never hide every column', () => {
  assert.deepEqual(sanitizeColumns({ hidden: ['cause', 'nope', 'cause'], widths: { id: 5, cause: 9000, x: 100, kind: 'wide' } }), { hidden: ['cause'], widths: { id: 48, cause: 800 } });
  assert.deepEqual(sanitizeColumns({ hidden: COLUMN_KEYS }).hidden, []);
  assert.deepEqual(sanitizeColumns(null), { hidden: [], widths: {} });
  assert.equal(visibleColumns({ hidden: ['id', 'cause'] }).length, 13);
});

test('saved views hold the table query and the column choices per name, at most 20', () => {
  let views = saveView({}, '  Blocked   by cause ', 'view=jobs&status=blocked&group=cause', { hidden: ['model'], widths: {} });
  assert.deepEqual(Object.keys(views), ['Blocked by cause']);
  assert.equal(views['Blocked by cause'].query, 'view=jobs&status=blocked&group=cause');
  assert.deepEqual(views['Blocked by cause'].columns.hidden, ['model']);
  assert.equal(saveView(views, '   ', 'x', {}), views, 'a blank name saves nothing');
  for (let i = 0; i < 30; i++) views = saveView(views, `v${i}`, 'view=jobs', {});
  assert.equal(Object.keys(views).length, 20);
  assert.deepEqual(sanitizeViews({ a: { query: 5 }, b: 'x', c: { query: 'view=jobs' } }), { c: { query: 'view=jobs', columns: { hidden: [], widths: {} } } });
  assert.equal(cleanName('x'.repeat(100)).length, 40);
});

test('a bare Jobs address restores the last view; an address that chose something, or an unfiltered last view, does not', () => {
  const last = 'view=jobs&status=blocked&group=cause&sort=startedAt&dir=desc';
  assert.equal(restoreTarget('?view=jobs', last), `/work?${last}`);
  assert.equal(restoreTarget('?view=jobs&status=failed', last), null);
  assert.equal(restoreTarget('?view=jobs', null), null);
  assert.equal(restoreTarget('', last), null, 'the queue view is not touched');
  assert.equal(lastQuery('?view=jobs&status=blocked&job=60b46719&page=3&reset=1'), 'view=jobs&status=blocked&sort=startedAt&dir=desc', 'canonical: no open job, no page');
  assert.equal(lastQuery('?view=jobs'), 'view=jobs&sort=startedAt&dir=desc');
  assert.equal(lastQuery('?x=1'), null);
  const cleared = lastQuery(`?${jobsQuery(base())}`);
  assert.equal(restoreTarget(`?${cleared}`, cleared), null, 'the unfiltered table is not a bare address, so it never redirects in a loop');
  assert.equal(restoreTarget('?view=jobs&reset=1', last), null, 'Clear filters is not undone by the saved view');
});

// A minimal page for bindJobs: it needs querySelector(All), addEventListener and the elements it touches.
function fakeStore(initial = {}) { const m = new Map(Object.entries(initial)); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; }

test('opening a bare Jobs address with a saved last view replaces the address, once', () => {
  const last = 'view=jobs&status=blocked&sort=startedAt&dir=desc';
  const seen = [];
  const loc = { search: '?view=jobs', replace: u => seen.push(u) };
  bindJobs({ loc, store: fakeStore({ [KEYS.last]: last }), doc: {} });
  assert.deepEqual(seen, [`/work?${last}`]);
});

test('the CSV of the current table is built from the filtered rows in the address', async () => {
  const view = JSON.parse(JSON.stringify(await fixtureView()));
  const fetchFn = async url => { assert.equal(url, '/api/view.json'); return { ok: true, json: async () => view }; };
  const csv = await currentCsv(fetchFn, '?view=jobs&status=blocked', ['id', 'status', 'costGbp']);
  assert.equal(csv, `Id,Status,Cost (GBP)\r\n${REBASE_ID},blocked,1.21\r\n`);
  const all = await currentCsv(fetchFn, '?view=jobs&sort=costGbp&dir=desc', ['id']);
  assert.equal(all.trimEnd().split('\r\n').length, 5);
  await assert.rejects(() => currentCsv(async () => ({ ok: false, status: 500 }), '?view=jobs', ['id']), /500/);
});
