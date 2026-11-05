// Shared Overview lists: fixed height, search, sort, footer, and state across the page's refresh.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { DIRECTION_WORDS, LIST_MIN_SEARCH, filterListRows, footerText, listView, noMatchText, sanitizeListState, searchVisible, sortListRows } from '../supervisor/dashui/lists.mjs';
import { overviewView } from './helpers/lists-fixture.mjs';

const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
const page = v => renderRoute(v, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
const mk = (i, over = {}) => ({ i, sev: 'info', num: null, name: null, age: null, text: '', ...over });

// ---- logic, per row shape
const needs = [mk(0, { sev: 'action', num: 112, name: 'Fix the tick', text: 'Fix the tick #112' }), mk(1, { sev: 'action', num: 7, name: 'Approve plan', text: 'Approve plan #7' }), mk(2, { sev: 'action', num: null, name: 'Reboot needed', text: 'Reboot needed' })];
const warnings = [mk(0, { sev: 'info', num: 9, text: 'Drift #9' }), mk(1, { sev: 'warning', num: 3, text: 'CI red on PR #3' }), mk(2, { sev: 'warning', num: 5, text: 'Stale data' }), mk(3, { sev: 'action', num: 1, text: 'Halted #1' })];
const watching = [mk(0, { sev: 'ok', num: 40, age: 5000, name: 'PR 40' }), mk(1, { sev: 'action', num: 8, age: 90000, name: 'PR 8' }), mk(2, { sev: 'info', num: 12, age: null, name: 'issue 12' })];
const now = [mk(0, { sev: 'info', name: 'codex', age: 60000 }), mk(1, { sev: 'warning', name: 'claude', age: 3000 })];

test('default order is the original order; the reverse direction reverses it', () => {
  assert.deepEqual(sortListRows(needs).map(r => r.i), [0, 1, 2]);
  assert.deepEqual(sortListRows(needs, 'default', 'desc').map(r => r.i), [2, 1, 0]);
});
test('Needs you: number sorts numerically and rows without a number go last in either direction', () => {
  assert.deepEqual(sortListRows(needs, 'number', 'asc').map(r => r.num), [7, 112, null]);
  assert.deepEqual(sortListRows(needs, 'number', 'desc').map(r => r.num), [112, 7, null]);
});
test('names sort case-insensitively and a missing name is last', () => {
  assert.deepEqual(sortListRows(needs, 'name', 'asc').map(r => r.name), ['Approve plan', 'Fix the tick', 'Reboot needed']);
  assert.deepEqual(sortListRows([mk(0), mk(1, { name: 'b' }), mk(2, { name: 'A' })], 'name', 'asc').map(r => r.i), [2, 1, 0]);
});
test('Warnings: most urgent first is severity descending, ties keep the order given; ascending reverses the levels', () => {
  assert.deepEqual(sortListRows(warnings, 'severity', 'desc').map(r => r.i), [3, 1, 2, 0]);
  assert.deepEqual(sortListRows(warnings, 'severity', 'asc').map(r => r.i), [0, 1, 2, 3]);
});
test('Watching: severity puts the item that needs you first; age sorts newest first ascending, unknown age last', () => {
  assert.deepEqual(sortListRows(watching, 'severity', 'desc').map(r => r.num), [8, 12, 40]);
  assert.deepEqual(sortListRows(watching, 'age', 'asc').map(r => r.num), [40, 8, 12]);
  assert.deepEqual(sortListRows(watching, 'age', 'desc').map(r => r.num), [8, 40, 12]);
});
test('Now: age sorts by elapsed time', () => assert.deepEqual(sortListRows(now, 'age', 'desc').map(r => r.name), ['codex', 'claude']));
test('an unknown sort key falls back to the default order; the input is not changed', () => {
  const before = needs.map(r => r.i);
  assert.deepEqual(sortListRows(needs, 'bogus', 'asc').map(r => r.i), [0, 1, 2]);
  assert.deepEqual(needs.map(r => r.i), before);
});
test('search: what the row shows, case-insensitive, every word, and #number finds the number', () => {
  assert.deepEqual(filterListRows(needs, 'FIX').map(r => r.i), [0]);
  assert.deepEqual(filterListRows(needs, '#7').map(r => r.i), [1]);
  assert.deepEqual(filterListRows(needs, '112').map(r => r.i), [0]);
  assert.deepEqual(filterListRows(needs, 'approve 7').map(r => r.i), [1]);
  assert.deepEqual(filterListRows(needs, 'approve fix').map(r => r.i), [], 'all words must match');
  assert.deepEqual(filterListRows(needs, '   ').map(r => r.i), [0, 1, 2], 'blank search shows everything');
});
test('N of M while filtered, plain count otherwise, and a plain message when nothing matches', () => {
  const v = listView(warnings, { q: 'ci', key: 'severity', dir: 'desc' });
  assert.equal(v.count, 1); assert.equal(v.total, 4); assert.equal(v.filtered, true); assert.equal(v.none, false);
  assert.equal(footerText(warnings, v.shown, 'warnings', v.filtered), '1 of 4 warnings · 1 warning');
  assert.equal(footerText(warnings, warnings, 'warnings'), '4 warnings · 1 action · 2 warning');
  assert.equal(footerText([mk(0)], [mk(0)], 'items'), '1 item');
  const none = listView(warnings, { q: 'zzz' });
  assert.equal(none.none, true); assert.equal(none.count, 0); assert.equal(noMatchText('zzz'), 'Nothing matches “zzz”.');
  assert.equal(listView([], { q: 'x' }).none, false, 'an empty list is not a "no match"');
});
test('the search box returns as soon as the list reaches the minimum', () => {
  assert.equal(searchVisible(LIST_MIN_SEARCH - 1), false); assert.equal(searchVisible(LIST_MIN_SEARCH), true);
});
test('saved state is sanitised: unknown sort, bad types, search without a box', () => {
  const opt = { sorts: ['default', 'number'], defaultSort: { key: 'default', dir: 'asc' } };
  assert.deepEqual(sanitizeListState({ key: 'evil', dir: 'desc', q: 5, top: -3, open: 'x' }, opt), { q: '', key: 'default', dir: 'asc', top: 0, open: [] });
  assert.equal(sanitizeListState({ q: 'abc', key: 'number', dir: 'desc', top: 40.4 }, opt).q, 'abc');
  assert.equal(sanitizeListState({ q: 'abc' }, { ...opt, searchable: false }).q, '');
  assert.deepEqual(DIRECTION_WORDS.severity, ['Least urgent first', 'Most urgent first']);
});

// ---- rendering: every Overview list uses the shared component
const BARE = /<ul class="(?:panel-list|watch-list|since-list)[^"]*">/g;
const lists = html => [...html.matchAll(/<div class="dlist[^"]*" data-dlist="([^"]+)"/g)].map(m => m[1]);
// A list element that is not inside a .dlist: strip every dlist block (they never nest) and look for a bare one.
const outsideDlist = html => { const main = /<main[\s\S]*<\/main>/.exec(html)[0]; return main.replace(/<div class="dlist[\s\S]*?<div class="dl-foot[^>]*>[^<]*<\/div><\/div>/g, ''); };

test('Overview: Now, Next, Needs you, Later, Warnings, Watching and the Since sections all use the shared list; no bare list remains', async () => {
  const html = page(await overviewView({ needs: 5, warnings: 5, later: 3, next: 3, watching: 2, since: 4 }));
  const ids = lists(html);
  for (const id of ['now', 'next', 'needs', 'later', 'warnings', 'watching']) assert.ok(ids.includes(id), `${id} is a shared list`);
  assert.ok(ids.some(i => i.startsWith('since-')), 'the Since sections are shared lists too');
  assert.deepEqual(outsideDlist(html).match(BARE) || [], [], 'a plain unbounded list on the Overview must use dlist()');
});
test('Overview: a bare panel-list on the page fails the check (negative control)', () => {
  const sample = '<main><div class="dlist" data-dlist="x"><ul class="panel-list dl-scroll"></ul><div class="dl-foot">1 item</div></div><ul class="panel-list"><li>x</li></ul></main>';
  assert.equal((outsideDlist(`<html>${sample}</html>`).match(BARE) || []).length, 1);
});
test('Overview with 50 Needs you rows: all 50 rows and their buttons and links are still there, in one bounded list', async () => {
  const html = page(await overviewView({ needs: 50 }));
  const block = /<div class="dlist[^"]*" data-dlist="needs"[\s\S]*?<div class="dl-foot[^>]*>([^<]*)<\/div>/.exec(html);
  assert.equal((block[0].match(/<li /g) || []).length, 50);
  assert.match(block[1], /^50 items · 50 action$/);
  assert.match(block[0], /class="dl-q"/, 'a long list has the search box'); assert.match(block[0], /class="dl-key"/);
  assert.match(block[0], /href="\/work\/issue\/100"/, 'row links survive');
  assert.equal((block[0].match(/data-copy="note \d+"/g) || []).length, 50, 'every row keeps its Copy for overseer button');
});
test('Overview with 0 rows: no list box at all, only the empty states', async () => {
  const html = page(await overviewView({}));
  assert.ok(!lists(html).includes('needs')); assert.match(html, /Nothing needs you/); assert.match(html, /No warnings/);
});
test('a short list has no search box but keeps its sort and footer; sort controls need two rows', async () => {
  const html = page(await overviewView({ needs: 3 }));
  const block = /<div class="dlist[^"]*" data-dlist="needs"[\s\S]*?<div class="dl-foot/.exec(html)[0];
  assert.doesNotMatch(block, /dl-q/); assert.match(block, /dl-key/);
  const one = /<div class="dlist[^"]*" data-dlist="needs"[\s\S]*?<div class="dl-foot/.exec(page(await overviewView({ needs: 1 })))[0];
  assert.doesNotMatch(one, /dl-key|dl-bar/);
});
test('defaults: Needs you keeps the planner order (most urgent first); Warnings are rendered most urgent first', async () => {
  const html = page(await overviewView({ needs: 3, warnings: 8 }));
  assert.match(/data-dlist="needs"[^>]*data-default-key="default"/.exec(html)[0], /default-key="default"/);
  const w = /<div class="dlist[^"]*" data-dlist="warnings"[\s\S]*?<div class="dl-foot/.exec(html)[0];
  assert.match(w, /data-default-key="severity" data-default-dir="desc"/);
  const sev = [...w.matchAll(/<li [^>]*data-sev="(\w+)"/g)].map(m => m[1]);
  assert.deepEqual(sev, [...sev].sort((a, b) => ({ action: 3, warning: 2, info: 1 }[b] - { action: 3, warning: 2, info: 1 }[a])), 'warning rows come before info rows');
  assert.match(w, /<option value="severity" selected>/);
});
test('the controls are labelled, the list is a keyboard-reachable scroll region, and nothing leaks into row ids', async () => {
  const html = page(await overviewView({ needs: 9 }));
  const block = /<div class="dlist[^"]*" data-dlist="needs"[\s\S]*?<div class="dl-foot/.exec(html)[0];
  assert.match(block, /aria-label="Search Needs you"/); assert.match(block, /<ul class="panel-list dl-scroll" tabindex="0" aria-label="Needs you">/);
  assert.match(block, /id="att-homeowner-0"/, 'the existing row ids (links to #att-…) are kept');
});
test('CSS: the list height is capped, scrolls inside the card, shrinks on a phone, and a resized or expanded card gives it room', () => {
  assert.match(css, /\.dl-scroll\{max-height:var\(--dl-max\);overflow-y:auto/);
  assert.match(css, /\.dlist\{[^}]*--dl-max:clamp\(/);
  assert.match(css, /@media\(max-width:639px\)\{\s*\.dlist\{--dl-max:clamp\(/);
  assert.match(css, /\.card\[style\*="--h:"\] \.dlist\{--dl-max:/); assert.match(css, /\.card\.expanded \.dlist\{--dl-max:/);
  assert.match(css, /html:not\(\.js\) \.dl-bar\{display:none\}/, 'without script the dead controls are not shown');
});

// ---- the browser side, on a small fake DOM: state must survive the page's refresh (a reload today; a swapped-in list with PR #531)
class El {
  constructor(tag = 'div', data = {}) { this.tagName = tag.toUpperCase(); this.dataset = data; this.children = []; this.parent = null; this.hidden = false; this.scrollTop = 0; this.value = ''; this.open = false; this.q = {}; this.on = {}; this.text = ''; this.attrs = {}; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(' '); }
  set textContent(v) { this.text = v; this.children = []; }
  append(...ns) { for (const n of ns) { for (const c of n.isFrag ? [...n.children] : [n]) { c.parent?.children.splice(c.parent.children.indexOf(c), 1); c.parent = this; this.children.push(c); } if (n.isFrag) n.children = []; } }
  querySelector(sel) { return this.q[sel] ?? null; }
  querySelectorAll(sel) { return this.qa?.[sel]?.() ?? []; }
  closest(sel) { for (let n = this; n; n = n.parent) if (n.is?.(sel)) return n; return null; }
  addEventListener(type, fn) { (this.on[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.on[type] || []) fn({ key: '', preventDefault() {} }); }
  setAttribute(k, v) { this.attrs[k] = v; }
  focus() { this.focused = true; }
}
function fakeList({ rows = 10, id = 'needs' } = {}) {
  const ul = new El('ul'), foot = new El(), none = new El(), input = new El('input'), clear = new El('button'), select = new El('select'), dir = new El('button');
  const span = new El('span'), use = new El('use'); dir.q = { span, use }; dir.hidden = true;
  const detailsOf = [];
  for (let i = 0; i < rows; i++) {
    const li = new El('li', { key: `att-${i}`, i: String(i), sev: 'action', num: String(100 + i), name: `Item ${i}` }); li.text = `Item ${i} decision for #${100 + i}`;
    const d = new El('details'); li.append(d); d.is = s => s === 'details'; li.is = s => s === 'li'; detailsOf.push(d); ul.append(li);
  }
  ul.qa = { 'details[open]': () => detailsOf.filter(d => d.open), details: () => detailsOf };
  detailsOf.forEach(d => { d.dataset = {}; });
  const el = new El('div', { dlist: id, sorts: 'default,number,name', defaultKey: 'default', defaultDir: 'asc', defaultLabel: 'Most urgent first', noun: 'items' });
  el.q = { ':scope > .dl-scroll': ul, '[data-dl-foot]': foot, '.dl-none': none, '.dl-q': input, '.dl-clear': clear, '.dl-key': select, '.dl-dir': dir };
  select.value = 'default';
  return { el, ul, foot, none, input, clear, select, dir, detailsOf };
}
const memory = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), keys: () => [...m.keys()] }; };
async function loadUi() {
  globalThis.location = { pathname: '/' }; globalThis.addEventListener = () => {};
  globalThis.document = { createDocumentFragment: () => Object.assign(new El(), { isFrag: true }) };
  return import('../supervisor/dashui/lists-ui.mjs');
}
const visible = ul => ul.children.filter(l => !l.hidden).map(l => l.dataset.key);

test('browser: search, "N of M", clear, no-match message, and sort re-order the rows without losing any', async () => {
  const { initList } = await loadUi(), store = memory(), L = fakeList();
  initList(L.el, store);
  assert.equal(L.foot.textContent, '10 items · 10 action'); assert.equal(visible(L.ul).length, 10);
  L.input.value = 'item 3'; L.input.fire('input');
  assert.deepEqual(visible(L.ul), ['att-3']); assert.equal(L.foot.textContent, '1 of 10 items · 1 action'); assert.equal(L.clear.hidden, false);
  L.input.value = '#105'; L.input.fire('input'); assert.deepEqual(visible(L.ul), ['att-5']);
  L.input.value = 'nothing like this'; L.input.fire('input');
  assert.equal(L.none.hidden, false); assert.match(L.none.textContent, /^Nothing matches/); assert.equal(L.foot.textContent, '0 of 10 items');
  L.clear.fire('click'); assert.equal(L.input.value, ''); assert.equal(visible(L.ul).length, 10); assert.equal(L.none.hidden, true);
  L.select.value = 'number'; L.select.fire('change'); L.dir.fire('click');
  assert.deepEqual(L.ul.children.map(l => l.dataset.key).slice(0, 2), ['att-9', 'att-8'], 'number, reversed: highest first');
  assert.equal(L.ul.children.length, 10, 'no row was lost');
  assert.equal(L.dir.q.span.textContent, 'Highest first'); assert.match(L.dir.attrs['aria-label'], /Highest first/);
});
test('browser: a refresh keeps search text, sort, scroll position inside the list and open details', async () => {
  const { initList } = await loadUi(), store = memory(), a = fakeList();
  initList(a.el, store);
  a.select.value = 'name'; a.select.fire('change'); a.input.value = 'item'; a.input.fire('input');
  a.detailsOf[4].open = true; a.detailsOf[4].dataset = {}; a.ul.scrollTop = 140; a.ul.fire('scroll'); a.ul.fire('toggle');
  await new Promise(r => setTimeout(r, 200));   // the debounced save
  const b = fakeList();   // the refreshed page: the same list, freshly rendered in its default state
  initList(b.el, store);
  assert.equal(b.input.value, 'item'); assert.equal(b.select.value, 'name'); assert.equal(b.ul.scrollTop, 140);
  assert.equal(b.detailsOf[4].open, true, 'the open details is open again'); assert.equal(b.detailsOf.filter(d => d.open).length, 1);
  assert.equal(b.foot.textContent, '10 of 10 items · 10 action');
});
test('browser: state belongs to its page and its list; another list or page starts from its default', async () => {
  const { initList } = await loadUi(), store = memory(), a = fakeList();
  initList(a.el, store); a.input.value = 'item 2'; a.input.fire('input');
  const other = fakeList({ id: 'warnings' }); initList(other.el, store);
  assert.equal(other.input.value, ''); assert.equal(visible(other.ul).length, 10);
  globalThis.location = { pathname: '/work' }; const elsewhere = fakeList(); initList(elsewhere.el, store);
  assert.equal(elsewhere.input.value, ''); assert.equal(visible(elsewhere.ul).length, 10);
});
test('browser: bad saved state (garbage, unknown sort) is ignored and a list is initialised only once', async () => {
  const { initList } = await loadUi(), store = memory(); store.setItem('dash.dl./.needs', '{not json');
  const a = fakeList(); initList(a.el, store); assert.equal(a.foot.textContent, '10 items · 10 action');
  store.setItem('dash.dl./.needs', JSON.stringify({ key: 'bogus', q: 'x'.repeat(500), top: 'far' }));
  const b = fakeList(); initList(b.el, store); initList(b.el, store);
  assert.equal(b.input.value.length, 200); assert.equal(b.select.value, 'default'); assert.equal(b.ul.scrollTop, 0); assert.equal(b.ul.on.scroll.length, 1, 'bound once');
});
