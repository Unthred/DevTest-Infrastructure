// Issue #939: one standard list/table component with declared filters, chips with counts, column resize and show/hide.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PAGE_NAMES, dli, dlist, needsKind, NEEDS_KINDS, SEV_FILTER, renderRoute, table } from '../supervisor/dashrender.mjs';
import { applyFacets, columnWidths, decodeFacet, encodeFacet, facetChips, facetsActive, sanitizeFacets, tableState, toggleFacet } from '../supervisor/dashui/logic.mjs';
import { listView, sanitizeListState } from '../supervisor/dashui/lists.mjs';
import { clampWidth, sanitizeColumns } from '../supervisor/dashui/tables-ui.mjs';
import { overviewView } from './helpers/lists-fixture.mjs';

const src = fs.readFileSync(new URL('../supervisor/dashrender.mjs', import.meta.url), 'utf8');

// ---- pure filter logic
const rows = [{ k: 'a', s: 'x' }, { k: 'a', s: 'y' }, { k: 'b', s: 'x' }, { k: 'c', s: null }];
const filters = [{ key: 'k', label: 'K', order: ['b', 'a'] }, { key: 's', label: 'S' }];
test('filters combine: OR inside one filter, AND across filters; blank selection shows everything', () => {
  assert.equal(applyFacets(rows, filters, {}).length, 4);
  assert.deepEqual(applyFacets(rows, filters, { k: ['a', 'b'] }).map(r => r.k), ['a', 'a', 'b']);
  assert.deepEqual(applyFacets(rows, filters, { k: ['a', 'b'], s: ['x'] }).map(r => `${r.k}${r.s}`), ['ax', 'bx']);
  assert.deepEqual(applyFacets(rows, filters, { s: ['Unknown'] }).map(r => r.k), ['c'], 'a missing value is its own "Unknown" chip');
  assert.deepEqual(applyFacets(rows, filters, { k: ['zzz'] }), [], 'a value nothing has shows nothing');
});
test('chips: declared order first, counts are against the other filters, a chosen value with no rows stays so it can be unchosen', () => {
  const g = facetChips(rows, filters, {});
  assert.deepEqual(g[0].options.map(o => [o.value, o.count]), [['b', 1], ['a', 2], ['c', 1]]);
  const g2 = facetChips(rows, filters, { s: ['x'] });
  assert.deepEqual(g2[0].options.map(o => [o.value, o.count]), [['b', 1], ['a', 1]].concat([['c', 0]].slice(0, 0)), 'k counts only rows with s=x');
  assert.deepEqual(g2[1].options.map(o => [o.value, o.count, o.on]).filter(o => o[2]), [['x', 2, true]], 'a filter\'s own counts ignore its own choice');
  const g3 = facetChips(rows, filters, { k: ['zzz'] });
  assert.ok(g3[0].options.some(o => o.value === 'zzz' && o.count === 0 && o.on));
});
test('toggle, sanitize and the URL encoding', () => {
  assert.deepEqual(toggleFacet({ k: ['a'] }, 'k', 'b'), { k: ['a', 'b'] });
  assert.deepEqual(toggleFacet({ k: ['a'] }, 'k', 'a'), { k: [] });
  assert.equal(facetsActive({ k: [] }), false); assert.equal(facetsActive({ k: ['a'] }), true);
  assert.deepEqual(sanitizeFacets({ k: ['a', 5, 'b'], evil: ['x'], s: 'no' }, filters), { k: ['a', 'b'] });
  assert.deepEqual(decodeFacet(encodeFacet(['a b', 'c,d'])), ['a b', 'c d']);
  assert.deepEqual(decodeFacet(''), []);
});
test('list state and view carry the filter choice; search and filters combine', () => {
  const lr = [{ i: 0, sev: 'action', text: 'alpha', facets: { kind: 'Approvals' } }, { i: 1, sev: 'action', text: 'beta', facets: { kind: 'Blocked' } }, { i: 2, sev: 'info', text: 'alpha two', facets: { kind: 'Blocked' } }];
  const f = [{ key: 'kind', label: 'Kind' }];
  assert.deepEqual(sanitizeListState({ f: { kind: ['Blocked'], bad: ['x'] } }, { filters: f }).f, { kind: ['Blocked'] });
  const v = listView(lr, { f: { kind: ['Blocked'] }, filters: f });
  assert.deepEqual(v.shown.map(r => r.i), [1, 2]); assert.equal(v.filtered, true);
  assert.deepEqual(listView(lr, { q: 'alpha', f: { kind: ['Blocked'] }, filters: f }).shown.map(r => r.i), [2]);
  assert.equal(listView(lr, { f: { kind: ['nope'] }, filters: f }).none, true);
});
test('default column widths follow the content: a short column is not squeezed, the long text column takes the rest', () => {
  const cols = [{ label: 'Job' }, { label: 'What happened' }, { label: 'Status' }];
  const w = columnWidths(cols, [['abcd1234 watch', 'x'.repeat(120), 'completed'], ['abcd1234 watch', 'short', 'failed']]);
  assert.equal(w[1], null, 'the long text column is left to take the remaining width');
  assert.ok(w[0] >= 14, 'the Job column fits its id and link'); assert.ok(w[2] >= 9);
  assert.ok(columnWidths([{ label: 'A' }], [['x']])[0] >= 6, 'never narrower than the minimum');
});
test('saved column state is sanitised and the last column can never be hidden', () => {
  assert.deepEqual(sanitizeColumns({ w: { a: 99999, zz: 10, b: 'x' }, hidden: ['a', 'q'] }, ['a', 'b']), { w: { a: 900 }, hidden: ['a'] });
  assert.deepEqual(sanitizeColumns({ hidden: ['a', 'b'] }, ['a', 'b']).hidden, ['a']);
  assert.deepEqual(sanitizeColumns('junk', ['a']), { w: {}, hidden: [] });
  assert.equal(clampWidth(1), 48);
});

// ---- the components refuse to render without declared filters
test('a list or a table with no declared filters does not render', () => {
  const r = [dli({ sev: 'info', inner: 'x' })];
  assert.throws(() => dlist({ id: 'x', label: 'x', rows: r }), /declares no filters/);
  assert.throws(() => dlist({ id: 'x', label: 'x', rows: r, filters: [] }), /declares no filters/);
  assert.throws(() => table({ id: 't', path: '/', query: new URLSearchParams(), cols: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }] }), /declares no filters/);
  assert.ok(dlist({ id: 'x', label: 'x', rows: r, filters: [SEV_FILTER] }).includes('data-filters='));
});
test('no list or table is written by hand: every plain list goes through dlist(), every table through table()', () => {
  // Fixed-schema tables with a handful of rows that are not yet on table() (each a follow-up, see the PR): breaker causes, allowance
  // windows, UI review runs, the Diagnostics plainTable and the process table.
  const handTables = (src.match(/<table[ >]/g) || []).length;
  assert.ok(handTables <= 6, `a new hand-written <table> appeared (${handTables}; table() itself plus the five above); use table() from dashrender.mjs`);
  assert.equal((src.match(/<ul class="(?:panel-list|watch-list|since-list)[^"]*">/g) || []).length, 0, 'a plain list appeared; use dlist() or sevList()');
});

// ---- rendered: every page, every list and table
test('every rendered list declares filters and every rendered table has its table component markup', async () => {
  const v = await overviewView({ needs: 4, warnings: 3, later: 2, next: 3, watching: 2, since: 3 });
  let lists = 0, tables = 0;
  for (const page of PAGE_NAMES) {
    for (const route of [{ page }, { page, id: 'claude' }]) {
      let out; try { out = renderRoute(v, route, { query: new URLSearchParams(), pathname: '/' }); } catch (e) { assert.fail(`${page}: ${e.message}`); }
      const main = (/<main[\s\S]*<\/main>/.exec(out.html) || [''])[0];
      for (const m of main.matchAll(/<div class="dlist[^"]*" data-dlist="([^"]+)"[^>]*data-filters="([^"]*)"/g)) { lists++; assert.notEqual(m[2].replace(/&quot;/g, '"'), '[]', `${page}/${m[1]}`); }
      assert.equal((main.match(/<div class="dlist/g) || []).length, (main.match(/data-filters="/g) || []).length, `${page}: a list without data-filters`);
      assert.doesNotMatch(main, /<ul class="(?:panel-list|watch-list|since-list)(?![^"]*dl-scroll)/, `${page}: a plain list`);
      tables += (main.match(/data-tregion=/g) || []).length;
    }
  }
  assert.ok(lists >= 4 && tables >= 1, `exercised ${lists} lists and ${tables} tables`);
});

// ---- Needs you: Approvals first, one click
test('Needs you kinds: proposals are Approvals and sort first; the others are told apart; the order is declared', () => {
  assert.equal(needsKind({ id: 'inbox-1', text: 'Overseer proposal', inbox: {} }), 'Approvals');
  assert.equal(needsKind({ id: 'a', text: 'The weekly limit is reached' }), 'Limits');
  assert.equal(needsKind({ id: 'b', text: 'CI is red on PR 4' }), 'CI');
  assert.equal(needsKind({ id: 'c', text: 'Issue 9 is blocked by 3' }), 'Blocked');
  assert.equal(needsKind({ id: 'd', text: 'Something else' }), 'Other');
  assert.deepEqual(NEEDS_KINDS, ['Approvals', 'Blocked', 'Limits', 'CI', 'Other']);
});
test('the Overview Needs you list carries kind chips (Approvals first) on its rows', async () => {
  const v = await overviewView({ needs: 3 });
  v.panels.needsYou[0].inbox = { id: 'p1' };
  const html = renderRoute(v, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  const needs = /<div class="dlist[^"]*" data-dlist="needs"[\s\S]*?<div class="dl-foot/.exec(html)[0];
  assert.match(needs, /data-filters="[^"]*&quot;key&quot;:&quot;kind&quot;[^"]*Approvals/);
  assert.match(needs, /data-facets="[^"]*kind&quot;:&quot;Approvals/);
  assert.match(needs, /data-facets="[^"]*kind&quot;:&quot;Other/);
});

// ---- tables: URL filters, counts, clear all, and the lines the issue names
const T = (rowsIn, q = '') => table({ id: 't', path: '/p', query: new URLSearchParams(q), noun: 'things', rows: rowsIn, searchKeys: ['name'], filters: [{ key: 'kind', label: 'Kind' }, { key: 'st', label: 'State' }],
  cols: [{ key: 'name', label: 'Name' }, { key: 'kind', label: 'Kind' }, { key: 'st', label: 'State' }] });
const data = [{ name: 'one', kind: 'job', st: 'ok' }, { name: 'two', kind: 'job', st: 'bad' }, { name: 'three', kind: 'pr', st: 'ok' }];
test('table filter chips: counts, URL state, narrowing rows, the footer count, and Clear all only while one is on', () => {
  const all = T(data);
  assert.match(all, /class="chip" href="[^"]*t\.f\.kind=job[^"]*"[^>]*>job <span class="n">2<\/span>/);
  assert.doesNotMatch(all, /Clear all/);
  assert.match(all, /<colgroup>/); assert.match(all, /data-col="name"/);
  const one = T(data, 't.f.kind=job');
  assert.match(one, /class="chip on"[^>]*aria-pressed="true"[^>]*>job/);
  assert.match(one, /one/); assert.match(one, /two/); assert.doesNotMatch(one, /three/);
  assert.match(one, /2 of 3 things/); assert.match(one, /Clear all/);
  assert.match(one, /t\.f\.st=bad[^>]*>bad <span class="n">1<\/span>/, 'counts follow the other filter');
  const both = T(data, 't.f.kind=job&t.f.st=bad');
  assert.match(both, /two/); assert.doesNotMatch(both, /one</);
  const cleared = /Clear all/.exec(one) && /href="([^"]*)">Clear all/.exec(one)[1];
  assert.doesNotMatch(cleared, /f\./);
  assert.match(T(data, 't.f.kind=nothing'), /No things match the filter/);
  const st = tableState(data, { filters: [{ key: 'kind' }], sel: { kind: ['pr'] } });
  assert.equal(st.total, 1); assert.equal(st.all, 3);
});
test('Reviews: Verdicts per agent is a table that groups by agent, model or both and keeps its filters', async () => {
  const v = await overviewView({});
  v.verdicts = [{ pr: 1, reviewer: 'codex', model: 'm1', verdict: 'PASS', findings: [], at: 1 }, { pr: 2, reviewer: 'codex', model: 'm2', verdict: 'CHANGES', findings: ['x'], at: 2 }, { pr: 3, reviewer: 'claude', model: 'm1', verdict: 'PASS', findings: [], at: 3 }];
  const page = q => renderRoute(v, { page: 'reviews' }, { query: new URLSearchParams(q), pathname: '/reviews' }).html;
  const card = h => /data-card="r-v"[\s\S]*?<\/article>|data-card="r-v"[\s\S]*?<\/section>|data-card="r-v"[\s\S]*?(?=data-card="r-m")/.exec(h)[0];
  const byAgent = card(page(''));
  assert.match(byAgent, /<th[^>]*>(?:<a[^>]*>)?Agent/); assert.match(byAgent, /codex/); assert.doesNotMatch(byAgent, /codex · m1/);
  const byModel = card(page('rv.group=model'));
  assert.match(byModel, /<th[^>]*>(?:<a[^>]*>)?Model/); assert.match(byModel, />m1</); assert.match(byModel, /aria-current="true"[^>]*>Model/);
  const both = card(page('rv.group=both'));
  assert.match(both, /codex · m1/); assert.match(both, /codex · m2/); assert.match(both, /claude · m1/);
  assert.match(both, /data-filters|chipbar/);
  assert.match(card(page('rv.group=bogus')), /<th[^>]*>(?:<a[^>]*>)?Agent/, 'an unknown grouping falls back to agent');
});
test('Usage: Tokens per job has default widths from content and the job filters; Work queue cards use the shared list with search', async () => {
  const v = await overviewView({});
  v.jobs = [{ id: 'abcd1234', fullId: 'abcd1234-full', agent: 'codex', desc: 'x'.repeat(200), kind: 'implement', status: 'completed', model: 'm', inTokens: 10, outTokens: 5, cost: 0.1, hasTranscript: true }];
  const usage = renderRoute(v, { page: 'usage' }, { query: new URLSearchParams(), pathname: '/usage' }).html;
  const t = /data-table="jobs"[\s\S]*?<\/table>/.exec(usage)[0];
  const cols = [...t.matchAll(/<col data-col="(\w+)"( style="width:(\d+)ch")?>/g)].map(m => [m[1], m[3] ? Number(m[3]) : null]);
  assert.ok(cols.length >= 5);
  assert.ok(Object.fromEntries(cols).id >= 14, 'the Job column is wide enough for its id and link');
  assert.equal(Object.fromEntries(cols).desc, null, 'What happened takes the remaining space');
  assert.match(usage, /tregion[^>]*data-tregion="jobs"[\s\S]*?(Agent|Kind|Model|Outcome)[\s\S]*?chip/);
  v.queues = { claude: [{ type: 'issue', ref: 5, reason: 'r', next: true }, { type: 'pr', ref: 6, reason: 'r2', next: false }] };
  const work = renderRoute(v, { page: 'work' }, { query: new URLSearchParams(), pathname: '/work' }).html;
  assert.match(work, /data-dlist="wq-claude"/); assert.match(work, /dl-q/);
});
