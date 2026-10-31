// Dashboard v2 polish (issue #58): resizing, card sizing, back navigation, scrollbars, dockable navigation, version badge.
// Pure logic is tested directly (the browser runs the same module); pages through the real request handler; the early script in a sandbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { CARD_LIMITS, DOCKS, ROW_STEP, applyLayout, breakpointOf, dockFromPoint, dockOf, effectiveDock, limitsOf, resizeBox, restorableScroll, spanLimits, trail } from '../supervisor/dashui/logic.mjs';
import { codeVersion, readVersion } from '../supervisor/dashdata.mjs';
import { currentView, handler } from '../supervisor/dashserver.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const H = n => String(n).repeat(40).slice(0, 40);
const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
const earlyJs = fs.readFileSync(new URL('../supervisor/dashui/early.js', import.meta.url), 'utf8');

const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } }
};
const cache = () => ({ tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [],
  pulls: [{ number: 41, title: 'PR forty-one', headRefName: 'claude/issue-30-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }],
  issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [], prerequisites: [5] }, { number: 5, title: 'Five', state: 'OPEN', labels: [], prerequisites: [] }] });
async function serve(t, { link } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash58-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache()));
  if (link) fs.symlinkSync(`versions/${link}`, path.join(root, 'current'));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => NOW }));
  return { root, get: p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject)) };
}
const PAGES = ['/', '/agents', '/agents/claude', '/work', '/work/pr/41', '/work/issue/30', '/activity', '/usage', '/reviews', '/system'];

// ---- 1. resizing: pure geometry
const box = { span: 6, h: 200, natH: 160, colW: 100, type: 'panel' };
test('resize: every edge and corner changes the right dimension, snapped to whole columns and to the row step', () => {
  assert.deepEqual(resizeBox({ ...box, edge: 'e', dx: 140, dy: 999 }), { span: 7, h: 200 }, 'east: width only, 1.4 columns rounds to 1');
  assert.deepEqual(resizeBox({ ...box, edge: 'e', dx: 160, dy: 0 }), { span: 8, h: 200 }, '1.6 columns rounds to 2');
  assert.deepEqual(resizeBox({ ...box, edge: 'w', dx: -200, dy: 50 }), { span: 8, h: 200 }, 'west: dragging left grows the card');
  assert.deepEqual(resizeBox({ ...box, edge: 's', dx: 500, dy: 85 }), { span: 6, h: 280 }, 'south: height only, 285 snaps to 280');
  assert.deepEqual(resizeBox({ ...box, edge: 'n', dx: 0, dy: -80 }), { span: 6, h: 280 }, 'north: dragging up grows the card');
  assert.deepEqual(resizeBox({ ...box, edge: 'se', dx: 100, dy: 40 }), { span: 7, h: 240 });
  assert.deepEqual(resizeBox({ ...box, edge: 'nw', dx: -100, dy: -40 }), { span: 7, h: 240 });
  assert.deepEqual(resizeBox({ ...box, edge: 'ne', dx: 100, dy: -40 }), { span: 7, h: 240 });
  assert.deepEqual(resizeBox({ ...box, edge: 'sw', dx: -100, dy: 40 }), { span: 7, h: 240 });
  assert.ok(ROW_STEP > 0); for (let dy = -300; dy <= 300; dy += 7) assert.equal(resizeBox({ ...box, edge: 's', dx: 0, dy }).h % ROW_STEP, 0, `dy ${dy}`);
});
test('resize: limits per card type; the content height is a floor, so nothing is ever clipped', () => {
  assert.equal(resizeBox({ ...box, edge: 'e', dx: -900, dy: 0 }).span, CARD_LIMITS.panel.minSpan, 'cannot go below the minimum width');
  assert.equal(resizeBox({ ...box, edge: 'e', dx: 9000, dy: 0 }).span, CARD_LIMITS.panel.maxSpan);
  assert.equal(resizeBox({ ...box, edge: 's', dx: 0, dy: -900 }).h, 160, 'shrinking stops at the content height (160 is already a multiple of the step)');
  assert.equal(resizeBox({ ...box, natH: 175, edge: 's', dx: 0, dy: -900 }).h, 200, 'content 175 rounds the floor up to the next step');
  assert.equal(resizeBox({ ...box, edge: 's', dx: 0, dy: 99999 }).h, CARD_LIMITS.panel.maxH);
  assert.equal(resizeBox({ ...box, natH: 5000, edge: 's', dx: 0, dy: 10 }).h, 5000, 'a card whose content is taller than the maximum stays as tall as its content');
  // KPI tiles and charts keep their content height; only the width changes
  for (const type of ['kpi', 'chart']) { const r = resizeBox({ ...box, type, edge: 'se', dx: 100, dy: 400 }); assert.equal(r.h, null, type); assert.ok(r.span >= CARD_LIMITS[type].minSpan && r.span <= CARD_LIMITS[type].maxSpan); }
  assert.equal(resizeBox({ ...box, type: 'kpi', edge: 'e', dx: 9000 }).span, 4);
  assert.equal(resizeBox({ ...box, type: 'kpi', edge: 'e', dx: -9000 }).span, 2);
  // an unknown type falls back to the general limits; an unknown edge changes nothing
  assert.equal(limitsOf('nonsense'), CARD_LIMITS.info);
  assert.deepEqual(resizeBox({ ...box, edge: 'x', dx: 300, dy: 300 }), { span: 6, h: 200 });
});
test('resize: tablet has six columns, so the limits are halved and stay inside the grid', () => {
  for (const type of Object.keys(CARD_LIMITS)) { const l = spanLimits(type, 'tablet'); assert.ok(l.min >= 2 && l.max <= 6 && l.min <= l.max, type); assert.equal(spanLimits(type, 'desktop').cols, 12); }
  assert.equal(resizeBox({ ...box, edge: 'e', dx: 9000, bp: 'tablet' }).span, 6); assert.equal(resizeBox({ ...box, edge: 'e', dx: -9000, bp: 'tablet' }).span, 2);
});
test('layout: saved sizes are validated and kept per breakpoint; a phone applies the order only', () => {
  const ids = ['a', 'b'], saved = { order: ['b', 'a', 'gone'], span: { a: 8, b: 99, gone: 3 }, h: { a: 240, b: 7, gone: 80, c: 'x' } };
  assert.deepEqual(applyLayout(ids, saved, 'desktop'), { order: ['b', 'a'], span: { a: 8 }, h: { a: 240 } });
  assert.deepEqual(applyLayout(ids, saved, 'phone'), { order: ['b', 'a'], span: {}, h: {} });
});
test('every card the pages render has a default size inside its own type limits, and resize handles that match its type', async t => {
  const s = await serve(t); let seen = 0;
  for (const u of PAGES) {
    const body = (await s.get(u)).body;
    for (const m of body.matchAll(/<(?:section|a) class="card[^"]*" data-card="([^"]+)" data-type="(\w+)" data-span="(\d+)"/g)) {
      seen++; const [, id, type, span] = m, l = CARD_LIMITS[type]; assert.ok(l, `${u} ${id}: known type ${type}`);
      assert.ok(Number(span) >= l.minSpan && Number(span) <= l.maxSpan, `${u} ${id}: span ${span} within ${l.minSpan}-${l.maxSpan}`);
    }
    for (const sec of body.split('<section ').slice(1)) {
      const type = /data-type="(\w+)"/.exec(sec)[1], edges = [...sec.matchAll(/data-edge="(\w+)"/g)].map(x => x[1]), movable = sec.includes('data-handle');
      if (!movable) { assert.deepEqual(edges, [], `${u} fixed card has no handles`); continue; }
      const want = CARD_LIMITS[type].vlock ? ['e', 'w', 'ne', 'nw', 'se', 'sw'] : ['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'];
      assert.deepEqual(edges, want, `${u} ${type}`); assert.match(sec, /class="resize wide-only rz-key" tabindex="0" role="slider"/);
    }
  }
  assert.ok(seen >= 15, `looked at ${seen} cards`);
});
test('the resize script reflows live from the real element, snaps via the shared logic, and leaves phones alone', () => {
  assert.match(appJs, /pointermove/); assert.match(appJs, /resizeBox\(/); assert.match(appJs, /naturalHeight/); assert.match(appJs, /bpNow\(\) === 'phone'/);
  assert.doesNotMatch(appJs, /ghost|outline-only|cloneNode/, 'the real content is resized, not an outline');
  assert.match(css, /\.rz-n,\.rz-s\{[^}]*cursor:ns-resize/); assert.match(css, /\.rz-ne\{[^}]*cursor:nesw-resize/); assert.match(css, /min-height:var\(--h,0\)/, 'a saved height is a minimum, never a clip');
  assert.match(css, /\.resize,\.wide-only\{display:none!important\}/);
});

// ---- 2. card sizing: defaults fit their content, equal KPI tiles, charts fill their card
test('sizing: no card has a fixed height or an inner scroll at its default size', () => {
  assert.doesNotMatch(css, /body\.overview \.card\.(panel|chart-card)\{[^}]*(height|overflow)/, 'the old fixed panel and chart heights are gone');
  assert.doesNotMatch(css, /\.card\.chart-card\{[^}]*overflow:hidden/);
  assert.doesNotMatch(css, /max-height:340px/, 'charts are not capped below the card');
  assert.match(css, /figure\.chart svg\{width:100%;height:auto;display:block;flex:none\}/, 'the drawing takes the full width of its card and keeps its proportions');
  assert.match(css, /\.cards\{[^}]*align-items:stretch/); assert.match(css, /\.cards\.fit\{align-items:start\}/);
});
test('sizing: KPI tiles share one shape (a sparkline slot even when there is no sparkline), so their heights match', async t => {
  const s = await serve(t); const body = (await s.get('/')).body;
  const tiles = body.split('<a class="card kpi"').slice(1).map(x => x.slice(0, x.indexOf('</a>')));
  assert.equal(tiles.length, 6); for (const tile of tiles) { assert.equal((tile.match(/class="spark-slot"/g) || []).length, 1); assert.match(tile, /data-type="kpi"/); }
  assert.match(css, /\.kpi \.spark-slot\{[^}]*min-height:calc\(28px \+ var\(--sp1\)\)/);
  assert.doesNotMatch(css, /body\.overview \.card\.kpi/, 'no overview-only KPI size that differs between tiles');
});
test('sizing: work-page queue cards fit their content and an empty queue is a short message', async t => {
  const s = await serve(t); const body = (await s.get('/work')).body;
  assert.match(body, /<div class="cards fit" data-layout="work">/);
  assert.match(body, /data-card="wq-claude"[^>]*data-type="queue"|data-type="queue"[^>]*data-card="wq-claude"/);
  assert.match(css, /\.empty\{[^}]*padding:var\(--sp5\) var\(--sp3\)/);
});

// ---- 3. back navigation
test('trail: Overview > section > item, the last step is the current page and is not a link; Overview has none', () => {
  assert.deepEqual(trail('overview'), []);
  assert.deepEqual(trail('work'), [['/', 'Overview'], [null, 'Work']]);
  assert.deepEqual(trail('usage'), [['/', 'Overview'], [null, 'Usage & cost']]);
  assert.deepEqual(trail('pr', [['/work', 'Work'], [null, 'PR #41']]), [['/', 'Overview'], ['/work', 'Work'], [null, 'PR #41']]);
});
test('every page except Overview has a breadcrumb trail and a Back control that works without script', async t => {
  const s = await serve(t);
  for (const u of PAGES) {
    const body = (await s.get(u)).body;
    if (u === '/') { assert.doesNotMatch(body, /class="pagehead"|data-back/, 'Overview is the root'); continue; }
    assert.match(body, /<nav class="crumbs" aria-label="Breadcrumb"><ol><li><a href="\/">Overview<\/a>/, u);
    assert.equal((body.match(/aria-current="page">[^<]+<\/span><\/li><\/ol>/g) || []).length, 1, `${u}: exactly one current step, last`);
    assert.match(body, /<a class="btn back" href="\/[^"]*" data-back>/, u);
  }
  const pr = (await s.get('/work/pr/41')).body;
  assert.match(pr, /Overview<\/a><span class="sep"[^>]*>›<\/span><\/li><li><a href="\/work">Work<\/a><span class="sep"[^>]*>›<\/span><\/li><li><span aria-current="page">PR #41<\/span>/);
  assert.match(pr, /<a class="btn back" href="\/work" data-back>/, 'Back goes to the parent page without script');
  assert.match((await s.get('/agents/claude')).body, /<a class="btn back" href="\/agents" data-back>/);
  assert.match((await s.get('/work')).body, /<a class="btn back" href="\/" data-back>/);
});
test('a missing drill-down still has a trail and a Back control (404)', async t => {
  const s = await serve(t); const r = await s.get('/work/pr/999');
  assert.equal(r.status, 404); assert.match(r.body, /Overview<\/a>/); assert.match(r.body, /data-back/); assert.match(r.body, /aria-current="page">Not found/);
});
test('back, filters and scroll: state is in the URL, Back uses the real history, and scroll is restored (clamped, ignoring bad values)', async t => {
  const s = await serve(t); const body = (await s.get('/work?issues.sort=number&issues.dir=desc&issues.q=th&issues.page=1')).body;
  assert.match(body, /aria-sort="descending"/); assert.match(body, /value="th"/);
  assert.match(appJs, /history\.back\(\)/); assert.match(appJs, /referrer/); assert.match(appJs, /origin === location\.origin/, 'history.back only for our own pages; otherwise the plain link');
  assert.match(appJs, /sessionStorage/); assert.match(appJs, /back_forward/); assert.match(appJs, /pagehide/);
  assert.equal(restorableScroll(320, 1000), 320); assert.equal(restorableScroll(5000, 1000), 1000); assert.equal(restorableScroll(300, -50), 0);
  for (const bad of [NaN, -5, 0, 'x', null, undefined, Infinity]) assert.equal(restorableScroll(bad, 1000), 0, String(bad));
});

// ---- 4. scrollbars
test('scrollbars: thin, themed, hidden until hover or scrolling, same standard properties for Chrome, Edge and Firefox', () => {
  assert.match(css, /\*\{scrollbar-width:thin;scrollbar-color:transparent transparent\}/);
  assert.match(css, /\*:hover,\*:focus-within,\.is-scrolling\{scrollbar-color:var\(--thumb\) transparent\}/);
  assert.match(css, /--thumb:color-mix\(in srgb,var\(--mut\)/, 'the thumb follows the theme token');
  assert.match(css, /@media\(hover:none\)\{\*\{scrollbar-color:var\(--thumb\) transparent\}\}/, 'touch devices keep an indicator');
  assert.doesNotMatch(css, /::-webkit-scrollbar|overflow:\s*overlay|scrollbar-width:\s*none/, 'no engine-specific styling, and the bar is never removed (keyboard and touch scrolling are untouched)');
  assert.doesNotMatch(css, /overflow:hidden[^}]*;[^}]*scroll/i);
  assert.match(appJs, /is-scrolling/); assert.match(appJs, /capture: true, passive: true/, 'scroll listeners are passive so scrolling is never blocked');
  assert.doesNotMatch(appJs, /preventDefault\(\)[^;]*wheel|addEventListener\('(wheel|touchmove|keydown)'[^)]*scroll/);
});

// ---- 5. dockable navigation
test('dock: names, per-breakpoint choice, phone always bottom, nearest-edge picking', () => {
  assert.deepEqual(DOCKS, ['top', 'bottom', 'left', 'right']);
  assert.equal(dockOf('left'), 'left'); for (const bad of ['LEFT', 'middle', '', null, undefined, 3, {}]) assert.equal(dockOf(bad), 'top', String(bad));
  assert.equal(effectiveDock('left', 'desktop'), 'left'); assert.equal(effectiveDock('left', 'tablet'), 'left'); assert.equal(effectiveDock('left', 'phone'), 'bottom'); assert.equal(effectiveDock('junk', 'phone'), 'bottom');
  assert.equal(dockFromPoint(500, 10, 1000, 800), 'top'); assert.equal(dockFromPoint(500, 790, 1000, 800), 'bottom');
  assert.equal(dockFromPoint(10, 400, 1000, 800), 'left'); assert.equal(dockFromPoint(990, 400, 1000, 800), 'right');
  assert.equal(dockFromPoint(5, 5, 1000, 800), 'left', 'a corner picks the nearer edge in proportion to the window'); assert.equal(dockFromPoint(1, 1, 0, 0), 'top'); assert.equal(dockFromPoint(NaN, NaN, 1000, 800), 'top');
});
test('dock markup: a drag handle, a four-way setting, a rail collapse control, all hidden on a phone, and the early script in the head', async t => {
  const s = await serve(t); const body = (await s.get('/')).body;
  assert.match(body, /data-dock-handle/); assert.match(body, /data-nav-collapse/);
  for (const d of DOCKS) assert.match(body, new RegExp(`data-dock="${d}"[^>]*aria-label="Dock navigation ${d}"`));
  assert.match(body, /<script src="\/static\/early\.js"><\/script><\/head>/);
  assert.match(css, /@media\(max-width:639px\)\{\.dockbar,\.dock-handle,\.nav-collapse\{display:none!important\}\}/, 'a phone keeps the fixed bottom tab bar and no dock controls');
  for (const d of DOCKS.filter(x => x !== 'top')) assert.ok(css.includes(`html[data-dock=${d}]`), d);
  assert.match(css, /html\[data-dock=left\] \.nav,html\[data-dock=right\] \.nav\{[^}]*flex-direction:column/, 'left and right are a vertical rail');
  assert.match(css, /html\[data-rail=collapsed\]\[data-dock=left\] \.nav a span/, 'collapsed rail keeps icons; the label stays available to screen readers');
  assert.match(css, /\.dock-zones/); assert.match(appJs, /dockFromPoint\(/); assert.match(appJs, /'dash\.dock\.' \+ bpNow\(\)/);
  assert.match(appJs, /key === 'Escape'|ev\.key === 'Escape'/, 'a dock drag can be cancelled');
});
test('early.js: applies the saved dock for the current breakpoint; bad or missing values fall back; the phone is always bottom', () => {
  const run = (width, store) => {
    const dataset = {}, ls = { getItem: k => (k in store ? store[k] : null) };
    vm.runInNewContext(earlyJs, { window: { innerWidth: width }, localStorage: ls, document: { documentElement: { dataset } }, JSON });
    return dataset;
  };
  assert.deepEqual(run(1400, {}), { dock: 'top' });
  assert.equal(run(1400, { 'dash.dock.desktop': '"left"' }).dock, 'left'); assert.equal(run(800, { 'dash.dock.tablet': '"right"' }).dock, 'right');
  assert.equal(run(1400, { 'dash.dock.tablet': '"right"' }).dock, 'top', 'a choice saved for another breakpoint does not leak');
  assert.equal(run(400, { 'dash.dock.phone': '"left"', 'dash.dock.tablet': '"left"' }).dock, 'bottom');
  assert.equal(run(1400, { 'dash.dock.desktop': '"sideways"' }).dock, 'top'); assert.equal(run(1400, { 'dash.dock.desktop': '{broken' }).dock, 'top');
  assert.equal(run(1400, { 'dash.navrail': 'true' }).rail, 'collapsed'); assert.equal(run(1400, { 'dash.navrail': 'false' }).rail, undefined);
  assert.equal(breakpointOf(1100), 'desktop'); assert.equal(breakpointOf(640), 'tablet'); assert.equal(breakpointOf(639), 'phone');
  assert.match(earlyJs, /w >= 1100.*w >= 640/, 'same breakpoint edges as logic.mjs');
  assert.doesNotMatch(earlyJs, /fetch|XMLHttpRequest|sendBeacon|innerHTML|eval\(/);
});
test('early.js is served from the fixed whitelist; unknown static names are still refused', async t => {
  const s = await serve(t); const r = await s.get('/static/early.js');
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /javascript/); assert.equal(r.body, earlyJs);
  assert.match(r.headers['content-security-policy'], /script-src 'self'/);
  for (const bad of ['/static/../dashserver.mjs', '/static/early.js/x', '/static/other.js', '/static/early.JS']) assert.equal((await s.get(bad)).status, 404, bad);
});

// ---- 6. version badge (also #57)
test('codeVersion: the commit a process was loaded from, only from a versions/<40 hex> path', () => {
  assert.equal(codeVersion(`file:///mnt/cache/ai-supervisor/versions/${H(7)}/supervisor/dashdata.mjs`), H(7));
  for (const u of ['file:///mnt/user/projects/x/supervisor/dashdata.mjs', `file:///a/versions/${H(7).slice(1)}/s.mjs`, `file:///a/versions/${'Z'.repeat(40)}/s.mjs`]) assert.equal(codeVersion(u), null, u);
});
test('version: installed is what the current link points at, so a manual upgrade shows at once', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ver58-')); fs.mkdirSync(path.join(root, 'team'));
  const rec = rs => fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), rs.map(r => JSON.stringify(r)).join('\n') + '\n');
  const link = sha => { try { fs.unlinkSync(path.join(root, 'current')); } catch { /* none yet */ } fs.symlinkSync(`versions/${sha}`, path.join(root, 'current')); };
  try {
    assert.equal(readVersion(root, { running: null }), null, 'nothing recorded and no link: unknown');
    link(H(2)); assert.deepEqual(pick(readVersion(root, { running: null })), { installed: H(2), main: H(2), drift: false }, 'link only');
    rec([{ at: NOW - 1000, from: H(1), to: H(2), result: 'upgraded' }]); assert.equal(readVersion(root, { running: null }).drift, false);
    // records say main moved on and the upgrade was refused: real drift
    rec([{ at: NOW - 1000, from: H(1), to: H(2), result: 'upgraded' }, { at: NOW + 1000, from: H(2), to: H(3), result: 'refused' }]);
    fs.lutimesSync(path.join(root, 'current'), new Date(NOW - 5000), new Date(NOW - 5000));
    assert.deepEqual(pick(readVersion(root, { running: null })), { installed: H(2), main: H(3), drift: true });
    // a manual upgrade to H(3) AFTER that record: installed is H(3), no drift claimed
    link(H(3)); fs.lutimesSync(path.join(root, 'current'), new Date(NOW + 60000), new Date(NOW + 60000));
    assert.deepEqual(pick(readVersion(root, { running: null })), { installed: H(3), main: H(3), drift: false });
    // a manual upgrade to a commit the records never mention, after the newest record: still no false drift
    link(H(4)); fs.lutimesSync(path.join(root, 'current'), new Date(NOW + 90000), new Date(NOW + 90000));
    assert.deepEqual(pick(readVersion(root, { running: null })), { installed: H(4), main: H(4), drift: false });
    // negative: a link that is not versions/<sha> is ignored, the records are used
    fs.unlinkSync(path.join(root, 'current')); fs.symlinkSync('elsewhere', path.join(root, 'current'));
    assert.equal(readVersion(root, { running: null }).installed, H(2), 'falls back to the commit the records say is installed');
    assert.equal(readVersion(root, { running: 'not-a-sha' }).running, null); assert.equal(readVersion(root, { running: H(9) }).running, H(9));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
const pick = v => ({ installed: v.installed, main: v.main, drift: v.drift });
test('version badge: matches the installed link, flags a server still running older code, and drift stays a warning', async t => {
  const s = await serve(t, { link: H(5) });
  const view = await currentView({ root: s.root, config, now: NOW });
  assert.equal(view.version.installed, H(5));
  const page = v => renderRoute({ ...view, version: v }, { page: 'overview' }).html;
  assert.match(page({ installed: H(5), main: H(5), drift: false, running: H(5) }), /sev-ok[^>]*>[^]*?5555555 = main/);
  assert.match(page({ installed: H(5), main: H(5), drift: false, running: null }), /5555555 = main/, 'unknown running code is not an alarm');
  const stale = page({ installed: H(5), main: H(5), drift: false, running: H(4) });
  assert.match(stale, /sev-warning[^>]*>[^]*?5555555 installed, 4444444 running: restart needed/); assert.doesNotMatch(stale, /= main/);
  assert.match(page({ installed: H(5), main: H(6), drift: true, running: H(5) }), /5555555 → 6666666 deploy needed/);
  assert.match(page(null), /Version<\/span><span class="badge sev-info[^>]*>[^]*?unknown/);
  assert.doesNotMatch((await s.get('/system')).body, /undefined|NaN/);
});
