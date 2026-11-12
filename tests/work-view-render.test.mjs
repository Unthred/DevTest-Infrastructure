// Issue #1224: the Work page carries the view switch and the rows, and the table, board and side panel markup is escaped and complete.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { STATIC } from '../supervisor/dashserver.mjs';
import { buildWorkRows } from '../supervisor/workrows.mjs';
import { jsonForScript } from '../supervisor/workviewrender.mjs';
import { switchHtml, pickView } from '../supervisor/dashui/viewswitch.mjs';
import { VIEWS, boardColumns, defaultState, emptyFilters, facetCounts, facetValues, groupRows, sortRows } from '../supervisor/dashui/worktable.mjs';
import { boardHtml, filterBarHtml, panelHtml, tableHtml } from '../supervisor/dashui/workview-draw.mjs';
import { workView } from './helpers/work-fixture.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const ctx = { time: ms => `T${ms}`, duration: ms => `D${ms}` };
const view = await workView(NOW);
const data = buildWorkRows(view);
const page = renderRoute(view, { page: 'work' }, { query: new URLSearchParams(), pathname: '/work' }).html;

test('GET /work is a page that says Queue and carries the switch with Queue cards, Table and Board', () => {
  assert.match(page, /Queue/);
  assert.match(page, /data-workview/);
  assert.deepEqual([...page.matchAll(/class="btn vs-btn" data-view="(\w+)"/g)].map(m => m[1]), ['cards', 'table', 'board']);
  assert.match(page, /<script type="module" src="\/static\/workview-ui\.mjs">/);
  assert.match(page, /data-card="wq-claude"/, 'the queue cards are still on the page');
});

test('the rows embedded in the page are exactly the rows the builder makes', () => {
  const m = /<script type="application\/json" id="wv-data">([\s\S]*?)<\/script>/.exec(page);
  assert.deepEqual(JSON.parse(m[1]), JSON.parse(JSON.stringify(data)));
});

test('the new scripts are served: each is in the static table and exists', () => {
  for (const f of ['worktable.mjs', 'workview-draw.mjs', 'workview-ui.mjs', 'viewswitch.mjs']) {
    assert.ok(STATIC[`/static/${f}`], f);
    assert.ok(fs.existsSync(new URL(`../supervisor/dashui/${f}`, import.meta.url)), f);
  }
});

test('JSON in a script block cannot close it: < and the line separators are escaped', () => {
  const text = jsonForScript({ t: '</script><img src=x onerror=alert(1)> ' });
  assert.ok(!text.includes('</script>') && !text.includes('<'));
  assert.ok(!text.includes(' '));
  assert.equal(JSON.parse(text).t, '</script><img src=x onerror=alert(1)> ');
});

test('the switch marks the active view and ignores an unknown one', () => {
  assert.match(switchHtml(VIEWS, 'board'), /data-view="board" aria-pressed="true"/);
  assert.match(switchHtml(VIEWS, 'board'), /data-view="table" aria-pressed="false"/);
  assert.equal(pickView(VIEWS, 'table', 'cards'), 'table');
  assert.equal(pickView(VIEWS, 'grid', 'cards'), 'cards');
});

const evil = { ...data.rows[0], title: '<img src=x onerror=alert(1)>', agent: 'a"b', holdReason: '<b>x</b>', labels: ['<l>'] };
test('the table shows the visible columns only, marks the sorted column and escapes every value', () => {
  const state = { ...defaultState(), hidden: ['cost', 'tokens'], widths: { title: 400 } };
  const html = tableHtml({ groups: groupRows([evil], ''), state, ctx, sortKey: 'rank', sortDir: 'desc' });
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<b>x'));
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /data-col="rank" style="width:110px" aria-sort="descending"/);
  assert.match(html, /data-col="title" style="width:400px" aria-sort="none"/);
  assert.ok(!html.includes('data-col="cost"') && !html.includes('data-col="tokens"'));
  assert.equal((html.match(/<th scope="col"/g) || []).length, 18);
  assert.match(html, /data-open="issue:1153"/);
});

test('grouped rows get a group header with the count', () => {
  const html = tableHtml({ groups: groupRows(data.rows, 'state'), state: defaultState(), ctx, sortKey: 'rank', sortDir: 'asc' });
  assert.match(html, /<th colspan="20" scope="colgroup">Held <span class="qf-n">\d+<\/span>/);
});

test('the board shows ref, title, agent and hold reason on a card, in six columns', () => {
  const html = boardHtml(boardColumns(data.rows));
  assert.equal((html.match(/data-board="/g) || []).length, 6);
  assert.match(html, /<b>#1169<\/b> <span class="wv-title">Table view of the queue<\/span><span class="sub">claude · waiting for #1157 still open<\/span>/);
  assert.ok(!boardHtml(boardColumns([evil])).includes('<img'));
});

test('the filter bar has a button with a count per state, agent and label, and the saved views', () => {
  const html = filterBarHtml({ state: { ...defaultState(), filters: { ...emptyFilters(), state: ['held'] } }, counts: facetCounts(data.rows, emptyFilters()), values: facetValues(data.rows),
    saved: [{ name: 'My <held>', state: defaultState() }], shown: 3, total: 23 });
  assert.match(html, /data-facet="state" data-value="held" aria-pressed="true"><span>Held<\/span> <span class="qf-n">\d+<\/span>/);
  assert.match(html, /data-facet="agent" data-value="claude"/);
  assert.match(html, /data-facet="label" data-value="v2-ui"/);
  assert.match(html, /<option value="My &lt;held&gt;">/);
  assert.match(html, /3 of 23 items/);
  assert.match(html, /data-wv-csv/);
});

test('the side panel of #1169 shows its hold reason and when it began, its chain, and the GitHub and dashboard links', () => {
  const row = data.rows.find(r => r.key === 'issue:1169');
  const html = panelHtml(row, data.details[row.key], ctx);
  assert.match(html, /waiting for #1157 still open/);
  assert.match(html, new RegExp(`Began: T${NOW - 4 * 3600000}`));
  assert.match(html, /Open · <a href="\/work\/issue\/1157">#1157<\/a>/);
  assert.match(html, /href="https:\/\/github\.com\/o\/r\/issues\/1169"/);
  assert.match(html, /Rank<\/dt><dd>17 of 21/);
});

test('the side panel of a running item lists its job with tokens, cost and the job page; a held item without a start time says not recorded', () => {
  const run = data.rows.find(r => r.key === 'issue:1155');
  const html = panelHtml(run, data.details[run.key], ctx);
  assert.match(html, /<b>implement<\/b> running · claude · 15000 tokens · £0\.\d\d/);
  assert.match(html, /<a href="\/work\/job\/aaaaaaaa">Job aaaaaaaa<\/a>/);
  const held = { ...data.rows.find(r => r.key === 'issue:1169'), holdSince: null };
  assert.match(panelHtml(held, data.details['issue:1169'], ctx), /Began: not recorded/);
});

test('the side panel of a pull request lists its reviews and verdicts; one without any says so', () => {
  const row = data.rows.find(r => r.key === 'pr:1178');
  const html = panelHtml(row, { jobs: [], verdicts: [{ reviewer: 'codex', model: 'gpt', verdict: 'CHANGES', head: 'abc1234', at: NOW, findings: ['<x> bad'] }], chain: [] }, ctx);
  assert.match(html, /<b>CHANGES<\/b> by codex \(gpt\) at abc1234/);
  assert.match(html, /&lt;x&gt; bad/);
  assert.match(panelHtml(row, data.details[row.key], ctx), /No reviews yet/);
  assert.match(panelHtml(row, data.details[row.key], ctx), /No jobs recorded/);
});

test('a transcript link appears only for a job that has a transcript', () => {
  const row = data.rows[0];
  const job = { id: 'abcd1234', kind: 'review', status: 'completed', agent: 'codex', tokens: 5, costText: '£0.01', cause: 'done', page: '/work/job/abcd1234', transcript: '/jobs/' + 'b'.repeat(32) };
  assert.match(panelHtml(row, { jobs: [job], verdicts: [], chain: [] }, ctx), /<a href="\/jobs\/b{32}">Transcript<\/a>/);
  assert.ok(!panelHtml(row, { jobs: [{ ...job, transcript: null }], verdicts: [], chain: [] }, ctx).includes('Transcript'));
});

test('sorting then grouping keeps rows inside their group in sort order', () => {
  const groups = groupRows(sortRows(data.rows, 'rank', 'desc'), 'agent');
  const claude = groups.find(g => g.key === 'claude').rows.filter(r => r.rank);
  assert.deepEqual(claude.map(r => r.rank), [...claude.map(r => r.rank)].sort((a, b) => b - a));
});
