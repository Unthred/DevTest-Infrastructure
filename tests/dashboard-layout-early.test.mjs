// Saved card layout applied before the first paint (issue #492): layout-early.js runs right after <main>, in a sandbox with a small DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { applyLayout, breakpointOf, formatLocal, timeOnly } from '../supervisor/dashui/logic.mjs';
import { handler } from '../supervisor/dashserver.mjs';

const code = fs.readFileSync(new URL('../supervisor/dashui/layout-early.js', import.meta.url), 'utf8');
const IDS = ['a', 'b', 'c', 'd'];

function fakeCard(id) {
  const classes = new Set(['card']), style = {}, el = {
    id, parent: null, style: { setProperty: (k, v) => { style[k] = String(v); }, get alignSelf() { return style.alignSelf; }, set alignSelf(v) { style.alignSelf = v; } },
    classList: { contains: c => classes.has(c), add: c => classes.add(c) },
    hasAttribute: n => n === 'data-card', getAttribute: n => (n === 'data-card' ? id : null), classes, set: style
  };
  return el;
}
function run({ width, saved, ids = IDS, grid = true, page = '/' }) {
  let g; const cards = ids.map(fakeCard); g = { children: cards, gclasses: new Set(), gstyle: {}, classList: { add(c) { g.gclasses.add(c); } }, style: { setProperty(k, v) { g.gstyle[k] = String(v); } }, getAttribute: n => (n === 'data-layout' ? 'overview' : null), appendChild(c) { const i = this.children.indexOf(c); this.children.splice(i, 1); this.children.push(c); } };
  const store = { ...saved };
  vm.runInNewContext(code, {
    window: { innerWidth: width }, location: { pathname: page }, JSON, Number, Array,
    localStorage: { getItem: k => (k in store ? store[k] : null) },
    document: { querySelector: s => (grid && s === '.cards[data-layout]' ? g : null), querySelectorAll: s => (s === '.card[data-card]' ? cards : []) }
  });
  return { grid: g, order: g.children.map(c => c.id), cards: Object.fromEntries(cards.map(c => [c.id, c])) };
}
const key = bp => `dash.layout.overview.${bp}`;
const SAVED = { order: ['c', 'a', 'zzz'], span: { a: 5, b: 99, c: 2.5, zzz: 4 }, h: { a: 240, b: 10, c: 5000, d: 'x' }, collapsed: ['b', 'nope', 7] };

for (const [bp, width] of [['desktop', 1400], ['tablet', 800], ['phone', 400]]) {
  test(`layout-early.js applies the saved order, sizes and collapsed cards on ${bp}`, () => {
    const r = run({ width, saved: { [key(bp)]: JSON.stringify(SAVED) } });
    const want = applyLayout(IDS, SAVED, bp);
    assert.equal(breakpointOf(width), bp);
    assert.deepEqual(r.order, want.order, 'same order as logic.mjs applyLayout');
    for (const id of IDS) {
      assert.equal(r.cards[id].classes.has('collapsed'), want.collapsed.includes(id), `collapsed ${id}`);
      const prop = bp === 'tablet' ? '--tspan' : '--span';
      assert.equal(r.cards[id].set[prop], want.span[id] ? String(want.span[id]) : undefined, `span ${id}`);
      if (bp !== 'desktop') assert.equal(r.cards[id].set['--span'], undefined);
      assert.equal(r.cards[id].set['--h'], want.h[id] ? `${want.h[id]}px` : undefined, `height ${id}`);
    }
    if (bp === 'phone') assert.deepEqual(Object.values(r.cards).flatMap(c => Object.keys(c.set)), [], 'a phone applies order and collapsed only');
    else assert.equal(r.cards.a.set['--h'], '240px');
  });
  test(`layout-early.js ignores a layout saved for another breakpoint (${bp})`, () => {
    const other = { desktop: 'tablet', tablet: 'phone', phone: 'desktop' }[bp];
    const r = run({ width, saved: { [key(other)]: JSON.stringify(SAVED) } });
    assert.deepEqual(r.order, IDS); assert.equal(r.cards.b.classes.has('collapsed'), false);
  });
}

test('layout-early.js survives corrupt or hostile saved data and leaves the server order', () => {
  const bad = ['{broken', 'null', '"str"', '42', '[]', '{"order":"abc","span":7,"h":null,"collapsed":"b"}', '{"order":[1,{},null],"span":{"a":"5"},"h":{"a":-1},"collapsed":[{}]}', ''];
  for (const width of [1400, 800, 400]) for (const raw of bad) {
    const bp = breakpointOf(width), r = run({ width, saved: { [key(bp)]: raw } });
    assert.deepEqual(r.order, IDS, `${bp} ${raw}`);
    for (const c of Object.values(r.cards)) { assert.equal(c.classes.has('collapsed'), false, raw); assert.deepEqual(c.set, {}, raw); }
  }
  assert.doesNotThrow(() => run({ width: 1400, saved: {} }), 'nothing saved');
});

test('layout-early.js: a storage that throws, and a page without a card grid', () => {
  assert.doesNotThrow(() => vm.runInNewContext(code, { window: { innerWidth: 1400 }, location: { pathname: '/' }, JSON, localStorage: { getItem() { throw new Error('denied'); } }, document: { querySelector: () => null, querySelectorAll: () => [] } }));
  const r = run({ width: 1400, grid: false, page: '/system', saved: {} });
  assert.deepEqual(r.order, IDS);
});

test('layout-early.js on a page with no grid still collapses cards, keyed by the path', () => {
  const cards = ['x', 'y'].map(fakeCard);
  vm.runInNewContext(code, { window: { innerWidth: 1400 }, location: { pathname: '/system' }, JSON, Array, Number,
    localStorage: { getItem: k => (k === 'dash.layout./system.desktop' ? '{"collapsed":["y"]}' : null) },
    document: { querySelector: () => null, querySelectorAll: () => cards } });
  assert.deepEqual(cards.map(c => c.classes.has('collapsed')), [false, true]);
});

test('layout-early.js sends nothing and is served; every page loads it after <main> and before app.js', async t => {
  assert.doesNotMatch(code, /fetch|XMLHttpRequest|sendBeacon|innerHTML|eval\(/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash492-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1] } } };
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => Date.UTC(2026, 9, 31, 12) }));
  const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject));
  const js = await get('/static/layout-early.js');
  assert.equal(js.status, 200); assert.match(js.headers['content-type'], /javascript/); assert.equal(js.body, code);
  for (const p of ['/', '/agents', '/work', '/activity', '/usage', '/reviews', '/system']) {
    const { body: html } = await get(p);
    const m = html.indexOf('</main>'), l = html.indexOf('<script src="/static/layout-early.js"></script>'), a = html.indexOf('/static/app.js');
    assert.ok(m > 0 && l > m && a > l, `${p}: after </main>, before app.js`);
  }
});

// ---- the free layout (v: 2): a saved place and size per card
import { COLS, cleanRect, sanitizeLayout } from '../supervisor/dashui/grid.mjs';
const FREE = { v: 2, pos: { a: { x: 0, y: 0, w: 12, h: 10 }, b: { x: 12, y: 0, w: 99, h: 2 }, c: { x: 'x', y: 0, w: 4, h: 4 }, zzz: { x: 0, y: 0, w: 4, h: 4 } }, hidden: ['d', 'nope'], collapsed: ['a'] };
for (const [bp, width] of [['desktop', 1400], ['tablet', 800]]) {
  test(`layout-early.js applies a free layout on ${bp} the same way grid.mjs reads it`, () => {
    const r = run({ width, saved: { [key(bp)]: JSON.stringify(FREE) } }), cols = COLS[bp], want = sanitizeLayout(FREE, IDS, cols);
    assert.ok(r.grid.gclasses.has('free')); assert.equal(r.grid.gstyle['--cols'], String(cols));
    for (const id of IDS) {
      const set = r.cards[id].set, pre = FREE.pos[id], rect = cleanRect(pre, cols);   // overlaps are settled later, by app.js
      if (want.hidden.includes(id)) { assert.ok(r.cards[id].classes.has('lay-hidden')); continue; }
      if (!rect) { assert.equal(set['--cx'], undefined, `${id}: a bad rectangle is left for app.js to place`); continue; }
      assert.deepEqual([set['--cx'], set['--cy'], set['--cw'], set['--ch']], [rect.x, rect.y, rect.w, rect.h].map(String), id);
    }
    assert.ok(r.cards.a.classes.has('collapsed'), 'collapsed cards still apply');
  });
}
test('layout-early.js: a free layout is ignored on a phone, a pinned card is never hidden, and bad v2 data leaves the flow', () => {
  const ph = run({ width: 400, saved: { 'dash.layout.overview.phone': JSON.stringify(FREE) } });
  assert.ok(!ph.grid.gclasses.has('free')); assert.deepEqual(Object.values(ph.cards).flatMap(c => Object.keys(c.set)), []);
  for (const raw of ['{"v":2}', '{"v":2,"pos":[]}', '{"v":2,"pos":"x"}', '{"v":3,"pos":{}}']) { const r = run({ width: 1400, saved: { [key('desktop')]: raw } }); assert.ok(!r.grid.gclasses.has('free'), raw); }
});
// ---- local time before the first paint (issue #493)
function fakeEl(attrs, text, classes = []) {
  const cl = new Set(classes), a = { ...attrs };
  return { textContent: text, classList: { contains: c => cl.has(c), add: c => cl.add(c) }, hasAttribute: n => n in a, getAttribute: n => (n in a ? a[n] : null), setAttribute: (n, v) => { a[n] = v; }, a, cl };
}
function runTimes(times, svgs) {
  vm.runInNewContext(code, { window: { innerWidth: 1400 }, location: { pathname: '/' }, JSON, Number, Array, Date, isFinite, Intl,
    localStorage: { getItem: () => null },
    document: { querySelector: () => null, querySelectorAll: s => (s === 'time[data-local]' ? times : s === '[data-lms]' ? svgs : []) } });
}
test('layout-early.js puts server times in local time before the first paint, and app.js then changes no text', () => {
  const ms = Date.UTC(2026, 6, 1, 12, 30);   // BST in London
  const t = fakeEl({ datetime: new Date(ms).toISOString() }, '2026-07-01 12:30 UTC');
  const bad = fakeEl({ datetime: 'nonsense' }, 'x');
  const s = fakeEl({ 'data-lms': String(ms), 'data-tpl': 'at {t}' }, 'at 2026-07-01 12:30 UTC');
  const so = fakeEl({ 'data-lms': String(ms), 'data-tonly': '' }, '12:30');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  runTimes([t, bad], [s, so]);
  assert.equal(t.textContent, formatLocal(ms, tz));
  assert.ok(t.cl.has('lz'));
  assert.match(t.a.title, /2026-07-01 12:30 UTC \(stored in UTC\)/);
  assert.equal(bad.textContent, 'x', 'an unreadable time is left as it was');
  assert.equal(s.textContent, `at ${formatLocal(ms, tz)}`);
  assert.equal(so.textContent, timeOnly(ms, tz));
});
test('layout-early.js local time matches logic.mjs in a non-UTC zone', () => {
  for (const zone of ['Asia/Kolkata', 'America/New_York', 'Europe/London']) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs'; import vm from 'node:vm'; import { formatLocal } from ${JSON.stringify(new URL('../supervisor/dashui/logic.mjs', import.meta.url).href)};
      const code = fs.readFileSync(${JSON.stringify(new URL('../supervisor/dashui/layout-early.js', import.meta.url).pathname)}, 'utf8');
      const ms = Date.UTC(2026, 0, 15, 23, 45); const el = { textContent: 'u', classList: { contains: () => false, add() {} }, getAttribute: () => new Date(ms).toISOString(), setAttribute() {} };
      vm.runInNewContext(code, { window: { innerWidth: 1400 }, location: { pathname: '/' }, JSON, Number, Array, Date, isFinite, Intl, localStorage: { getItem: () => null }, document: { querySelector: () => null, querySelectorAll: s => (s === 'time[data-local]' ? [el] : []) } });
      process.stdout.write(el.textContent + '|' + formatLocal(ms, Intl.DateTimeFormat().resolvedOptions().timeZone));`], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
    const [a, b] = r.stdout.split('|');
    assert.equal(a, b, `${zone}: ${r.stderr}`);
    assert.notEqual(a, '', zone);
  }
  assert.match(spawnSync(process.execPath, ['-e', 'process.stdout.write(new Intl.DateTimeFormat("en-GB",{hour:"2-digit",timeZoneName:"short"}).format(0))'], { env: { ...process.env, TZ: 'Asia/Kolkata' }, encoding: 'utf8' }).stdout, /GMT\+5:30|IST/);
});
test('every page hides until local time is applied, then shows final text: no visible time text changes after the first paint', () => {
  const src = fs.readFileSync(new URL('../supervisor/dashrender.mjs', import.meta.url), 'utf8');
  assert.ok(src.indexOf('</main><p id="tznote"') > 0 && src.indexOf('</p><script src="/static/layout-early.js">') > 0, 'note and times are final before the reveal');
  const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
  const fb = /html\.tzp body \{ visibility: hidden; animation: tzreveal 0s linear (\d+(?:\.\d+)?)s forwards/.exec(css);
  assert.ok(fb, 'hidden until revealed, with a CSS fallback');
  assert.ok(Number(fb[1]) >= 10, 'the fallback waits long enough that a slow layout-early.js does not flash UTC text first (issue #839)');
  // Simulate the page: <html> .tzp from early.js, then layout-early.js, then app.js's own localizeTimes. Record every visible text change.
  const ms = Date.UTC(2026, 6, 1, 12, 30), tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const cl = new Set(), visible = () => !cl.has('tzp'), changes = [];
  const track = (attrs, text, classes = []) => {
    const c = new Set(classes), a = { ...attrs }; let t = text;
    return { get textContent() { return t; }, set textContent(v) { if (visible() && v !== t) changes.push(v); t = v; }, classList: { contains: x => c.has(x), add: x => c.add(x) },
      hasAttribute: n => n in a, getAttribute: n => (n in a ? a[n] : null), setAttribute: (n, v) => { a[n] = v; }, set title(v) {} };
  };
  const t1 = track({ datetime: new Date(ms).toISOString() }, '2026-07-01 12:30 UTC'), s1 = track({ 'data-lms': String(ms), 'data-tpl': 'at {t}' }, 'at 12:30');
  const note = track({}, "Times are shown in UTC (your browser's time zone is applied when scripts run). Data is stored in UTC.");
  const docEl = { dataset: {}, classList: { add: c => cl.add(c), remove: c => cl.delete(c) } };
  const doc = { documentElement: docEl, getElementById: i => (i === 'tznote' ? note : null), querySelector: () => null,
    querySelectorAll: q => (q === 'time[data-local]' ? [t1] : q === '[data-lms]' ? [s1] : []) };
  const ctx = { window: { innerWidth: 1400 }, location: { pathname: '/' }, JSON, Number, Array, Date, isFinite, Intl, localStorage: { getItem: () => null }, document: doc };
  vm.runInNewContext(fs.readFileSync(new URL('../supervisor/dashui/early.js', import.meta.url), 'utf8'), ctx);
  assert.ok(cl.has('tzp'), 'early.js hides the page');
  vm.runInNewContext(code, ctx);
  assert.ok(visible(), 'layout-early.js reveals the page');
  assert.equal(t1.textContent, formatLocal(ms, tz)); assert.match(note.textContent, /your time zone/);
  // app.js: run its real localizeTimes and tznote code on the converted page
  const app = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  const from = app.indexOf('const zone = Intl'), to = app.indexOf('// The cooldown notice');
  assert.ok(from > 0 && to > from);
  const $$ = (q, scope) => scope.querySelectorAll(q), $ = q => (q === '#tznote' ? note : null);
  vm.runInNewContext(app.slice(from, to), { ...ctx, $, $$, formatLocal, timeOnly, document: doc });
  assert.deepEqual(changes, [], 'no text changes once the page is visible');
});
