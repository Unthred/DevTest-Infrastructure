// Issue #431: a refresh must not make the page flicker. Pure logic, the early layout script run against a small fake DOM, the
// browser measurement verdict, and the wiring. The real-browser measurement is tests/dashboard-refresh-browser.mjs (Tower only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { planRefresh, refreshBlocked, applyLayout } from '../supervisor/dashui/logic.mjs';
import { judgeRefresh, MAX_SHIFT_PX } from '../browser/refresh-shift.mjs';

const read = f => fs.readFileSync(new URL(`../supervisor/dashui/${f}`, import.meta.url), 'utf8');
const appJs = read('app.js'), layoutJs = read('layout-early.js'), earlyJs = read('early.js'), css = read('style.css');

test('planRefresh: only regions whose markup differs are replaced; a changed set of regions asks for a reload', () => {
  assert.deepEqual(planRefresh({ 'card:a': '1', 'card:b': '2' }, { 'card:a': '1', 'card:b': '2' }), { ok: true, changed: [] });
  assert.deepEqual(planRefresh({ 'card:a': '1', 'card:b': '2' }, { 'card:a': '1', 'card:b': '3' }), { ok: true, changed: ['card:b'] });
  assert.equal(planRefresh({ 'card:a': '1' }, { 'card:a': '1', 'card:b': '2' }).ok, false, 'a card appeared');
  assert.equal(planRefresh({ 'card:a': '1', 'card:b': '2' }, { 'card:a': '1' }).ok, false, 'a card vanished');
  assert.equal(planRefresh({ 'card:a': '1' }, { 'card:z': '1' }).ok, false, 'same count, different card');
});
test('refreshBlocked: typing, a drag or a text selection holds the swap back', () => {
  assert.equal(refreshBlocked({}), false);
  for (const k of ['typing', 'dragging', 'selecting']) assert.equal(refreshBlocked({ [k]: true }), true, k);
});

// ---- layout-early.js against a fake DOM, compared with applyLayout in logic.mjs
function fakeCard(id) {
  const props = {}, classes = new Set();
  return { id, style: { setProperty: (k, v) => { props[k] = String(v); }, alignSelf: '' }, props, classes, classList: { add: c => classes.add(c), contains: c => classes.has(c) }, getAttribute: k => (k === 'data-card' ? id : null), hasAttribute: k => k === 'data-card' };
}
function runEarly({ ids, saved, width, page = 'overview', grid = true }) {
  const cards = ids.map(fakeCard);
  const g = { children: [...cards], getAttribute: () => page, appendChild(c) { this.children = this.children.filter(x => x !== c); this.children.push(c); } };
  for (const c of cards) c.classList.contains = x => c.classes.has(x) || x === 'card';
  const ls = { getItem: k => (saved && k === `dash.layout.${page}.${width >= 1100 ? 'desktop' : width >= 640 ? 'tablet' : 'phone'}` ? JSON.stringify(saved) : null) };
  vm.runInNewContext(layoutJs, { window: { innerWidth: width }, localStorage: ls, location: { pathname: '/x' }, JSON, Array, Number,
    document: { querySelector: () => (grid ? g : null), querySelectorAll: sel => (sel === '.card[data-card]' ? cards : []) } });
  return { order: g.children.map(c => c.id), cards };
}
test('layout-early.js applies the saved order, sizes and collapsed cards the way applyLayout does, before app.js runs', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const saved = { order: ['c', 'zz', 'a'], span: { a: 8, b: 99, c: 3 }, h: { c: 240, d: 5 }, collapsed: ['b', 'gone'] };
  for (const [width, bp] of [[1440, 'desktop'], [800, 'tablet'], [390, 'phone']]) {
    const r = runEarly({ ids, saved, width }), want = applyLayout(ids, saved, bp);
    assert.deepEqual(r.order, want.order, `${bp} order`);
    const prop = bp === 'tablet' ? '--tspan' : '--span';
    for (const c of r.cards) {
      assert.equal(c.props[prop], bp === 'phone' || !want.span[c.id] ? undefined : String(want.span[c.id]), `${bp} span ${c.id}`);
      assert.equal(c.props['--h'], want.h[c.id] ? want.h[c.id] + 'px' : undefined, `${bp} height ${c.id}`);
      assert.equal(c.classes.has('collapsed'), want.collapsed.includes(c.id), `${bp} collapsed ${c.id}`);
    }
  }
});
test('layout-early.js: no saved layout, corrupt storage or a failing store leaves the server order and never throws', () => {
  assert.deepEqual(runEarly({ ids: ['a', 'b'], saved: null, width: 1440 }).order, ['a', 'b']);
  const cards = ['a', 'b'].map(fakeCard);
  assert.doesNotThrow(() => vm.runInNewContext(layoutJs, { window: { innerWidth: 1440 }, localStorage: { getItem: () => '{not json' }, location: { pathname: '/' }, JSON, document: { querySelector: () => null, querySelectorAll: sel => (sel === '.card[data-card]' ? cards : []) } }));
  assert.doesNotThrow(() => vm.runInNewContext(layoutJs, { window: { innerWidth: 1440 }, localStorage: { getItem() { throw new Error('denied'); } }, location: { pathname: '/' }, JSON, document: { querySelector: () => null, querySelectorAll: sel => (sel === '.card[data-card]' ? cards : []) } }));
  assert.ok(cards.every(c => !c.classes.size));
  assert.doesNotMatch(layoutJs, /fetch|XMLHttpRequest|sendBeacon|innerHTML|eval\(/);
});
test('layout-early.js uses the same breakpoint edges as logic.mjs and the same size limits', () => {
  assert.match(layoutJs, /w >= 1100.*w >= 640/); assert.match(layoutJs, /s >= 1 && s <= 12/); assert.match(layoutJs, /h >= 40 && h <= 4000/);
});

// ---- the verdict the browser gate applies
const card = (id, x = 0, y = 0) => ({ id, x, y, w: 300, h: 200 });
const good = { before: { scrollY: 120, cards: [card('a'), card('b', 300)] }, after: { markerKept: true, expandedKept: true, scrollY: 120, cards: [card('a'), card('b', 300)] }, firstFrameOrder: ['b', 'a'], savedOrder: ['b', 'a'] };
test('judgeRefresh passes an in-place refresh and states its limit', () => {
  assert.equal(MAX_SHIFT_PX, 2);
  const v = judgeRefresh(good); assert.equal(v.ok, true); assert.equal(v.shift, 0);
  assert.equal(judgeRefresh({ ...good, after: { ...good.after, cards: [card('a', 2), card('b', 300)] } }).ok, true, 'within the limit');
});
test('judgeRefresh fails a full reload, a moved card, a collapsed card, a moved scroll and a late layout', () => {
  const bad = patch => judgeRefresh({ ...good, ...patch, after: { ...good.after, ...(patch.after || {}) } });
  assert.match(bad({ after: { markerKept: false } }).problems.join(), /reloaded/, 'the current full reload loses the document');
  assert.match(bad({ after: { cards: [card('a', 0, 40), card('b', 300)] } }).problems.join(), /moved or resized by 40px/);
  assert.match(bad({ after: { cards: [card('a')] } }).problems.join(), /vanished/);
  assert.match(bad({ after: { expandedKept: false } }).problems.join(), /expanded card/);
  assert.match(bad({ after: { scrollY: 0 } }).problems.join(), /scroll position/);
  assert.match(bad({ firstFrameOrder: ['a', 'b'] }).problems.join(), /first animation frame/);
  assert.match(bad({ firstFrameOrder: null }).problems.join(), /first animation frame/);
});

// ---- wiring
test('the periodic refresh no longer reloads the document, and the page without script still refreshes', () => {
  assert.doesNotMatch(appJs, /setInterval\([^)]*location\.reload/);
  assert.match(appJs, /setInterval\(refreshInPlace/);
  assert.match(appJs, /planRefresh\(served, now\)/);
  const render = fs.readFileSync(new URL('../supervisor/dashrender.mjs', import.meta.url), 'utf8');
  assert.match(render, /<noscript><meta http-equiv="refresh" content="\$\{refreshSeconds\}"><\/noscript>/, 'without script the meta refresh stays');
  assert.match(render, /<\/main><script src="\/static\/layout-early\.js"><\/script>/, 'the layout script runs right after the cards, before first paint');
});
test('times are hidden, keeping their space, until converted; early.js lifts that after 3 s if scripts never run', () => {
  assert.match(css, /html\.js time\[data-local\]:not\(\.lz\)[^{]*\{ visibility: hidden; \}/);
  assert.match(earlyJs, /classList\.add\('js'\)/); assert.match(earlyJs, /classList\.remove\('js'\), ?3000|remove\('js'\);? ?\}, 3000/);
  assert.match(appJs, /el\.classList\.add\('lz'\)/);
});

// ---- a swapped card body gets its handlers again, and the refresh never reloads
test('initLegends wires only the given scope, so a card body swapped by a refresh gets working legend buttons again', async () => {
  const { initLegends } = await import('../supervisor/dashui/legend.mjs');
  const mk = tag => ({ tag, attrs: {}, kids: [], listeners: {}, classes: new Set(), hidden: false,
    setAttribute(k, v) { this.attrs[k] = String(v); }, append(...n) { this.kids.push(...n); }, addEventListener(t, f) { this.listeners[t] = f; },
    classList: { toggle() {}, contains: () => false }, contains() { return false; }, closest() { return null; }, dataset: {}, querySelector() { return null; }, querySelectorAll() { return []; } });
  const button = mk('button'); button.dataset = { series: 'a' };
  const legend = mk('div'), fig = mk('div');
  legend.querySelectorAll = () => [button]; fig.querySelector = sel => (sel === '.legend' ? legend : null); fig.querySelectorAll = sel => (sel === '[data-series]' ? [button] : []);
  const scope = mk('div'); scope.querySelectorAll = sel => (sel === 'figure.chart' ? [fig] : []);
  const elsewhere = mk('div'); elsewhere.querySelectorAll = () => { throw new Error('the whole document must not be scanned'); }; elsewhere.createElement = mk;
  initLegends({ document: elsewhere, store: { get: () => null, set() {}, del() {} }, legendKey: 'k', scope });
  assert.equal(typeof button.listeners.click, 'function', 'the legend button in the new card body has its click handler');
});
test('refreshInPlace never reloads the document: a changed card set is handled in place and the swapped controls are wired again', () => {
  const fn = appJs.slice(appJs.indexOf('function rewire('), appJs.indexOf("const secs = Number($('meta[name=refresh-seconds]')"));
  assert.doesNotMatch(fn, /location\.(reload|assign|replace)/, 'no reload on a changed card set or on an error');
  assert.match(fn, /initLegends\(\{[^}]*scope\b/); assert.match(fn, /bindTable\(region\)/); assert.match(fn, /bindCopy\(scope\)/);
  assert.match(fn, /bindAddedCard\(fresh\)/, 'a card that appeared is wired like the initial ones');
  assert.match(appJs, /function bindTable\(region\)/);
});

// ---- local time before first paint, and focus across a card swap (review of PR #436)
test('layout-early.js puts times in local time before first paint, the way formatLocal does; app.js skips converted nodes', async () => {
  const { formatLocal } = await import('../supervisor/dashui/logic.mjs');
  const mk = (attrs, text) => { const cls = new Set(), a = { ...attrs }; return { textContent: text, classList: { add: c => cls.add(c), contains: c => cls.has(c) }, getAttribute: k => a[k] ?? null, hasAttribute: k => k in a, setAttribute: (k, v) => { a[k] = v; }, cls }; };
  const t = mk({ datetime: '2026-11-03T12:30:00.000Z' }, '2026-11-03 12:30 UTC');
  const s = mk({ 'data-lms': String(Date.parse('2026-11-03T12:30:00.000Z')), 'data-tpl': 'at {t}', 'data-tonly': '' }, 'x');
  const doc = { querySelectorAll: sel => sel.startsWith('time') ? [t] : sel === '[data-lms]' ? [s] : [], documentElement: {} };
  vm.runInNewContext(layoutJs, { document: doc, window: { innerWidth: 1200 }, localStorage: { getItem: () => null }, location: { pathname: '/' }, Intl, Date, Number, isFinite, Array, JSON });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const ms = Date.parse('2026-11-03T12:30:00.000Z');
  assert.equal(t.textContent, formatLocal(ms, zone)); assert.ok(t.cls.has('lz'));
  assert.equal(s.textContent, 'at ' + formatLocal(ms, zone).slice(11)); assert.ok(s.cls.has('lz'));
  assert.match(appJs, /classList\.contains\('lz'\)\) continue/);
});
test('a refreshed card body gets keyboard focus back on the same element', () => {
  assert.match(appJs, /document\.activeElement/); assert.match(appJs, /\.focus\(\{ preventScroll: true \}\)/);
  assert.ok(appJs.indexOf('focusAt') < appJs.indexOf('old[0].replaceWith') && appJs.indexOf('.focus({ preventScroll: true })') > appJs.indexOf('rewire(live);'));
});
