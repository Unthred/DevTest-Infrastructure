// Saved card layout applied before the first paint (issue #492): layout-early.js runs right after <main>, in a sandbox with a small DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { applyLayout, breakpointOf } from '../supervisor/dashui/logic.mjs';
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
  const cards = ids.map(fakeCard), g = { children: cards, getAttribute: n => (n === 'data-layout' ? 'overview' : null), appendChild(c) { const i = this.children.indexOf(c); this.children.splice(i, 1); this.children.push(c); } };
  const store = { ...saved };
  vm.runInNewContext(code, {
    window: { innerWidth: width }, location: { pathname: page }, JSON, Number, Array,
    localStorage: { getItem: k => (k in store ? store[k] : null) },
    document: { querySelector: s => (grid && s === '.cards[data-layout]' ? g : null), querySelectorAll: s => (s === '.card[data-card]' ? cards : []) }
  });
  return { order: g.children.map(c => c.id), cards: Object.fromEntries(cards.map(c => [c.id, c])) };
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
