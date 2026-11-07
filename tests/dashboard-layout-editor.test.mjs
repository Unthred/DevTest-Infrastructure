// The free card layout (pure logic in supervisor/dashui/grid.mjs) and how the pages wire it. The browser behaviour (drag, resize,
// hide, reload, refresh during a drag) is checked by tests/layout-browser.mjs in the pinned Chromium on Tower.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { COLS, MAX_H, MIN_H, MIN_W, PINNED, ROW_GAP, ROW_PITCH, ROW_PX, UNDO_LIMIT, bottom, canHide, cleanRect, compact, dragRect, edgeAt, firstFit, fromBoxes, history, isOldLayout, overlaps, placeCard, resizeRect, rowsFor, sanitizeLayout, settleAll, toSaved, withoutPinned } from '../supervisor/dashui/grid.mjs';

const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
const R = (x, y, w, h) => ({ x, y, w, h });
const noOverlap = pos => { const v = Object.entries(pos); for (let i = 0; i < v.length; i++) for (let j = i + 1; j < v.length; j++) if (overlaps(v[i][1], v[j][1])) return false; return true; };

test('cleanRect: integers only, inside the grid, at least the minimum size, anything else is null', () => {
  assert.deepEqual(cleanRect(R(0, 0, 10, 10), 24), R(0, 0, 10, 10));
  assert.deepEqual(cleanRect(R(30, -4, 99, 1), 24), R(0, 0, 24, MIN_H), 'clamped into the grid and up to the minimum');
  assert.deepEqual(cleanRect(R(20, 0, 8, 6), 24), R(16, 0, 8, 6), 'a card cannot hang over the right edge');
  assert.equal(cleanRect(R(0, 0, 4, 9999), 24).h, MAX_H);
  assert.equal(cleanRect(R(0, 0, 1, 1), 12).w, MIN_W);
  for (const bad of [null, undefined, 4, 'x', [], {}, R(1.5, 0, 4, 4), R(0, NaN, 4, 4), R('0', 0, 4, 4), { x: 0, y: 0, w: 4 }]) assert.equal(cleanRect(bad, 24), null, JSON.stringify(bad));
});

test('the only limits are a usable header and the grid itself: no per-type widths, no height locks', () => {
  for (const [w, h] of [[MIN_W, MIN_H], [24, 4], [3, 400], [24, 400]]) assert.deepEqual(cleanRect(R(0, 0, w, h), 24), R(0, 0, w, h));
  assert.ok(MIN_W * 1 <= 3 && MIN_H * ROW_PITCH - ROW_GAP <= 100, 'a minimum card is about 84 px tall and a few columns wide');
});

test('placeCard: cards that collide are pushed down as little as possible; the rest never move', () => {
  const pos = { a: R(0, 0, 12, 10), b: R(12, 0, 12, 10), c: R(0, 10, 12, 6), d: R(12, 30, 12, 4) };
  const out = placeCard(pos, 'b', R(0, 0, 12, 10), 24);   // b lands on a
  assert.deepEqual(out.b, R(0, 0, 12, 10));
  assert.deepEqual(out.a, R(0, 10, 12, 10), 'a goes straight down, just below b');
  assert.deepEqual(out.c, R(0, 20, 12, 6), 'and what a lands on is pushed in turn');
  assert.deepEqual(out.d, pos.d, 'a card that is not in the way stays put');
  assert.ok(noOverlap(out)); assert.deepEqual(pos.a, R(0, 0, 12, 10), 'the input is not changed');
});
test('placeCard: moving into empty space moves nothing else; gaps are allowed', () => {
  const pos = { a: R(0, 0, 8, 8), b: R(16, 0, 8, 8) };
  const out = placeCard(pos, 'a', R(4, 30, 8, 8), 24);
  assert.deepEqual(out, { a: R(4, 30, 8, 8), b: pos.b });
});
test('placeCard: a preview is computed from the start layout, so moving back undoes the pushing', () => {
  const start = { a: R(0, 0, 12, 10), b: R(12, 0, 12, 10) };
  assert.notDeepEqual(placeCard(start, 'b', R(0, 4, 12, 10), 24).a, start.a);
  assert.deepEqual(placeCard(start, 'b', start.b, 24), start);
});
test('placeCard: an unknown card or a bad rectangle changes nothing; a resize pushes too', () => {
  const pos = { a: R(0, 0, 12, 10), b: R(0, 10, 12, 10) };
  assert.deepEqual(placeCard(pos, 'zzz', R(0, 0, 4, 4), 24), pos);
  assert.deepEqual(placeCard(pos, 'a', { x: 'q' }, 24), pos);
  const grown = placeCard(pos, 'a', R(0, 0, 12, 16), 24);
  assert.deepEqual(grown.b, R(0, 16, 12, 10));
});
test('placeCard never leaves two cards overlapping (random moves and resizes)', () => {
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (const cols of [24, 12]) {
    let pos = {}; for (let i = 0; i < 9; i++) pos['c' + i] = firstFit(pos, 3 + rnd(10), 4 + rnd(12), cols);
    assert.ok(noOverlap(pos));
    for (let n = 0; n < 300; n++) {
      const id = 'c' + rnd(9), r = pos[id];
      const t = rnd(2) ? dragRect(r, rnd(9) - 4, rnd(13) - 6, cols) : resizeRect(r, ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'][rnd(8)], rnd(9) - 4, rnd(13) - 6, cols);
      pos = placeCard(pos, id, t, cols);
      assert.ok(noOverlap(pos), `step ${n}`); for (const v of Object.values(pos)) assert.deepEqual(cleanRect(v, cols), v);
    }
  }
});

test('compact (auto-tidy) closes gaps upward only and never changes columns or order', () => {
  const pos = { a: R(0, 7, 8, 4), b: R(0, 30, 8, 4), c: R(8, 20, 8, 4), d: R(0, 12, 8, 4) };
  const out = compact(pos);
  assert.deepEqual(out, { a: R(0, 0, 8, 4), d: R(0, 4, 8, 4), b: R(0, 8, 8, 4), c: R(8, 0, 8, 4) });
  assert.deepEqual(compact(out), out, 'idempotent');
  assert.deepEqual(compact({}), {});
});
test('firstFit: the first free spot top to bottom, left to right; a full row goes below', () => {
  assert.deepEqual(firstFit({}, 8, 6, 24), R(0, 0, 8, 6));
  assert.deepEqual(firstFit({ a: R(0, 0, 8, 6) }, 8, 6, 24), R(8, 0, 8, 6));
  assert.deepEqual(firstFit({ a: R(0, 0, 24, 6) }, 8, 6, 24), R(0, 6, 8, 6));
  assert.deepEqual(firstFit({ a: R(0, 0, 12, 6), b: R(0, 6, 24, 6) }, 12, 6, 24), R(12, 0, 12, 6), 'fills the gap beside a');
  assert.equal(firstFit({}, 99, 99, 12).w, 12);
});

test('resizeRect: every edge and corner moves the right sides, the opposite side stays put, minimum and grid respected', () => {
  const r = R(6, 6, 10, 10), end = r.x + r.w, base = r.y + r.h;
  assert.deepEqual(resizeRect(r, 'e', 3, 99, 24), R(6, 6, 13, 10));
  assert.deepEqual(resizeRect(r, 's', 99, 3, 24), R(6, 6, 10, 13));
  const w = resizeRect(r, 'w', -4, 0, 24); assert.deepEqual(w, R(2, 6, 14, 10)); assert.equal(w.x + w.w, end, 'dragging the west edge outward keeps the east edge');
  const n = resizeRect(r, 'n', 0, -4, 24); assert.deepEqual(n, R(6, 2, 10, 14)); assert.equal(n.y + n.h, base);
  assert.deepEqual(resizeRect(r, 'se', 2, 2, 24), R(6, 6, 12, 12)); assert.deepEqual(resizeRect(r, 'nw', -2, -2, 24), R(4, 4, 12, 12));
  assert.deepEqual(resizeRect(r, 'ne', 2, -2, 24), R(6, 4, 12, 12)); assert.deepEqual(resizeRect(r, 'sw', -2, 2, 24), R(4, 6, 12, 12));
  assert.deepEqual(resizeRect(r, 'e', -99, 0, 24).w, MIN_W, 'shrinks to the minimum and stops');
  const wMin = resizeRect(r, 'w', 99, 0, 24); assert.equal(wMin.w, MIN_W); assert.equal(wMin.x + wMin.w, end);
  assert.equal(resizeRect(r, 'e', 99, 0, 24).x + resizeRect(r, 'e', 99, 0, 24).w, 24, 'cannot leave the grid');
  assert.equal(resizeRect(r, 'w', -99, 0, 24).x, 0); assert.equal(resizeRect(r, 'n', 0, -99, 24).y, 0);
  assert.equal(resizeRect(r, 's', 0, -99, 24).h, MIN_H); assert.equal(resizeRect(r, 's', 0, 99999, 24).h, MAX_H);
  assert.deepEqual(resizeRect(r, 'x', 5, 5, 24), r, 'unknown edge');
});
test('dragRect keeps the size and stays inside the grid', () => {
  assert.deepEqual(dragRect(R(2, 2, 6, 6), 3, 5, 24), R(5, 7, 6, 6));
  assert.deepEqual(dragRect(R(2, 2, 6, 6), -9, -9, 24), R(0, 0, 6, 6));
  assert.deepEqual(dragRect(R(2, 2, 6, 6), 99, 0, 12), R(6, 2, 6, 6));
});
test('edgeAt: corners, edges and the body of a card; a small card keeps a body to grab', () => {
  const box = { left: 100, top: 100, right: 300, bottom: 250, width: 200, height: 150 };
  assert.equal(edgeAt(box, 150, 175), ''); assert.equal(edgeAt(box, 101, 175), 'w'); assert.equal(edgeAt(box, 299, 175), 'e');
  assert.equal(edgeAt(box, 150, 101), 'n'); assert.equal(edgeAt(box, 150, 249), 's');
  assert.equal(edgeAt(box, 101, 101), 'nw'); assert.equal(edgeAt(box, 299, 101), 'ne'); assert.equal(edgeAt(box, 101, 249), 'sw'); assert.equal(edgeAt(box, 299, 249), 'se');
  assert.equal(edgeAt(box, 10, 10), '', 'outside');
  const tiny = { left: 0, top: 0, right: 30, bottom: 30, width: 30, height: 30 }; assert.equal(edgeAt(tiny, 15, 15), '');
});

test('sanitizeLayout: bad or old saved data falls back safely', () => {
  const ids = ['a', 'b', 'c'];
  for (const bad of [null, undefined, 0, 'x', [], {}, { v: 1, pos: {} }, { v: 3, pos: {} }, { v: 2 }, { v: 2, pos: [] }, { v: 2, pos: 'x' }, { order: ['a'], span: { a: 6 }, h: { a: 200 } }]) assert.equal(sanitizeLayout(bad, ids, 24), null, JSON.stringify(bad));
  const out = sanitizeLayout({ v: 2, pos: { a: R(0, 0, 8, 8), b: R(1.5, 0, 8, 8), c: 'x', gone: R(0, 0, 8, 8) }, hidden: ['c', 'zzz', 7, 'c'] }, ids, 24);
  assert.deepEqual(out, { pos: { a: R(0, 0, 8, 8) }, hidden: ['c'] }, 'unknown cards and bad rectangles dropped, hidden cleaned and de-duplicated');
  const cl = sanitizeLayout({ v: 2, pos: { a: R(-5, -5, 999, 2), b: R(0, 0, 4, 4) }, hidden: [] }, ids, 12);
  assert.deepEqual(cl.pos.a, R(0, 0, 12, MIN_H)); assert.ok(noOverlap(cl.pos), 'overlapping saved rectangles are settled');
});
test('sanitizeLayout never hides a pinned card or anything needing action', () => {
  assert.deepEqual(PINNED.slice().sort(), ['approvals', 'breaker', 'needs']);
  const ids = ['approvals', 'needs', 'breaker', 'a'];
  const out = sanitizeLayout({ v: 2, pos: {}, hidden: ['approvals', 'needs', 'breaker', 'a'] }, ids, 24);
  assert.deepEqual(out.hidden, ['a']);
  assert.equal(canHide('needs'), false); assert.equal(canHide('x', true), false, 'a card the server marks data-pin'); assert.equal(canHide('x'), true);
});
test('sanitizeLayout drops a hidden id for a card the server now marks data-pin', () => {
  const out = sanitizeLayout({ v: 2, pos: {}, hidden: ['a', 'b'] }, ['a', 'b'], 24, ['a']);
  assert.deepEqual(out.hidden, ['b']);
});
test('app.js does not bind the name history (it would hide window.history)', () => {
  const src = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  const imp = src.match(/import \{([^}]*)\} from '\.\/grid\.mjs'/)[1].split(',').map(x => x.trim());
  assert.ok(!imp.includes('history'), 'import history as layoutHistory');
  assert.ok(!/\b(const|let|var|function)\s+history\b/.test(src));
  // any other binding (parameter, destructuring, catch, import from another module): outside strings and comments, the bare
  // word history may only be used as history.x, or be the one import 'history as layoutHistory'
  const code = src.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
  const bare = [...code.matchAll(/(?<![.\w$])history\b(?!\s*\.)/g)].map(m => code.slice(m.index, m.index + 24));
  assert.deepEqual(bare, ['history as layoutHistory'], 'only the aliased import may name history without a member access');
  assert.match(src, /history\.scrollRestoration\s*=\s*'manual'/);
});
test('app.js reads the pinned cards on every apply() and every paintFree(), so no restored snapshot paints a pinned card hidden', () => {
  assert.match(appJs, /else st = withoutPinned\(st, pinnedIds\)/);
  assert.match(appJs, /function paintFree\(\) \{\s*st = withoutPinned\(st, pinnedNow\(\)\)/);
});
test('withoutPinned: an undo/redo snapshot with a now-pinned card hidden is cleaned, others are kept', () => {
  const h = history();
  h.push({ pos: { a: R(0, 0, 8, 8) }, hidden: ['b', 'c'] });   // an earlier state with b hidden
  const redone = h.undo({ pos: { a: R(0, 0, 8, 8) }, hidden: ['c'] });   // restoring it (undo or redo alike)
  assert.deepEqual(redone.hidden, ['b', 'c']);
  const cleaned = withoutPinned(redone, ['b']);
  assert.deepEqual(cleaned.hidden, ['c'], 'b is pinned now, c still hidden');
  assert.deepEqual(redone.hidden, ['b', 'c'], 'the snapshot itself is not mutated');
  assert.deepEqual(cleaned.pos, redone.pos);
  assert.equal(withoutPinned(redone, ['x']), redone, 'nothing pinned in the list returns the same object');
  assert.equal(withoutPinned(redone), redone); assert.equal(withoutPinned(null, ['b']), null);
  assert.deepEqual(withoutPinned({ pos: {}, hidden: ['b'] }, ['b']).hidden, []);
});
test('isOldLayout tells the old order/span/h form from the new one', () => {
  assert.equal(isOldLayout({ order: ['a'] }), true); assert.equal(isOldLayout({ span: {} }), true); assert.equal(isOldLayout({ v: 2, order: [] }), false);
  assert.equal(isOldLayout(null), false); assert.equal(isOldLayout({ collapsed: ['a'] }), false);
});
test('toSaved / sanitizeLayout round trip and keep collapsed out of the free state', () => {
  const st = { pos: { a: R(0, 0, 8, 8) }, hidden: [] }, saved = toSaved(st, ['a']);
  assert.deepEqual(saved, { v: 2, pos: st.pos, hidden: [], collapsed: ['a'] });
  assert.deepEqual(sanitizeLayout(JSON.parse(JSON.stringify(saved)), ['a'], 24), st);
});

test('fromBoxes converts a flow layout (an old saved arrangement, as drawn) into cells without losing the arrangement', () => {
  // desktop, 1224 px grid: column pitch (1224 + 12) / 24 = 51.5. Old layout: a 6 wide + b 6 wide in row 1 (card 140 px tall), c 12 wide below.
  const colPitch = 51.5, g = 12;
  const wpx = span => span * 2 * colPitch - g;
  const boxes = [
    { id: 'a', left: 0, top: 0, width: wpx(6), height: 140 },
    { id: 'b', left: 12 * colPitch, top: 0, width: wpx(6), height: 140 },
    { id: 'c', left: 0, top: 152, width: wpx(12), height: 300 }
  ];
  const pos = fromBoxes(boxes, { colPitch, cols: 24 });
  assert.deepEqual(pos.a, R(0, 0, 12, 7), '140 px snaps to 7 rows (156 px)'); assert.deepEqual(pos.b, R(12, 0, 12, 7)); assert.deepEqual(pos.c, R(0, 7, 24, 13), 'c was drawn at 152 px, row 6.3, which snaps to 7: right under a, as before');
  assert.ok(pos.c.h * ROW_PITCH - ROW_GAP >= 290, 'about as tall as it looked'); assert.ok(noOverlap(pos));
  // a column of cards that touched in the flow still touch, and the error does not add up down the column
  const col = fromBoxes(Array.from({ length: 8 }, (_, i) => ({ id: 'c' + i, left: 0, top: i * (141 + 12), width: 400, height: 141 })), { colPitch, cols: 24 });
  for (let i = 1; i < 8; i++) assert.equal(col['c' + i].y, col['c' + (i - 1)].y + col['c' + (i - 1)].h, 'touching');
  assert.ok(Math.abs(col.c7.y * ROW_PITCH - 7 * 153) <= 20, 'no drift down the column ' + col.c7.y);
  // tablet: 12 columns, the same widths in cells
  const tp = fromBoxes([{ id: 'a', left: 0, top: 0, width: 3 * 2 * 55 - 12, height: 100 }, { id: 'b', left: 6 * 55, top: 0, width: 3 * 2 * 55 - 12, height: 100 }], { colPitch: 55, cols: 12 });
  assert.deepEqual([tp.a.x, tp.a.w, tp.b.x, tp.b.w], [0, 6, 6, 6]);
  // garbage in, nothing out
  assert.deepEqual(fromBoxes([{ id: 'x', left: NaN, top: 0, width: 5, height: 5 }], { colPitch, cols: 24 }), {});
  assert.deepEqual(fromBoxes(boxes, { colPitch: 0, cols: 24 }), {});
});
test('rowsFor rounds content up to whole rows and respects the minimum', () => {
  assert.equal(rowsFor(0), MIN_H); assert.equal(rowsFor(NaN), MIN_H); assert.equal(rowsFor(84), 4); assert.equal(rowsFor(85), 4, 'sub-pixel tolerance'); assert.equal(rowsFor(86), 5); assert.equal(rowsFor(1e9), MAX_H);
  assert.ok(rowsFor(300) * ROW_PITCH - ROW_GAP >= 300);
});
test('settleAll and bottom', () => {
  const out = settleAll({ a: R(0, 0, 8, 8), b: R(4, 2, 8, 8) });
  assert.ok(noOverlap(out)); assert.deepEqual(out.a, R(0, 0, 8, 8)); assert.equal(bottom(out), 16); assert.equal(bottom({}), 0);
});

test('undo and redo: one step each, new changes clear redo, and the stack is bounded', () => {
  const h = history(), s0 = { pos: { a: R(0, 0, 8, 8) }, hidden: [] }, s1 = { pos: { a: R(2, 0, 8, 8) }, hidden: [] }, s2 = { pos: {}, hidden: ['a'] };
  assert.equal(h.canUndo, false); assert.equal(h.undo(s0), null); assert.equal(h.redo(s0), null);
  h.push(s0); h.push(s1);
  assert.equal(h.canUndo, true);
  assert.deepEqual(h.undo(s2), s1); assert.equal(h.canRedo, true); assert.deepEqual(h.undo(s1), s0); assert.equal(h.canUndo, false);
  assert.deepEqual(h.redo(s0), s1); assert.deepEqual(h.redo(s1), s2);
  h.undo(s2); h.push(s0); assert.equal(h.canRedo, false, 'a new change clears redo');
  const snap = { pos: { a: R(0, 0, 8, 8) }, hidden: [] }, h2 = history(); h2.push(snap); snap.pos.a.x = 9;
  assert.equal(h2.undo(snap).pos.a.x, 0, 'snapshots are copies');
  const h3 = history(); for (let i = 0; i < UNDO_LIMIT + 20; i++) h3.push({ pos: {}, hidden: [String(i)] });
  let n = 0; while (h3.undo({ pos: {}, hidden: [] })) n++; assert.equal(n, UNDO_LIMIT);
  h3.clear(); assert.equal(h3.canUndo, false);
});

test('the stylesheet and grid.mjs agree on the grid; desktop 24 columns, tablet 12, a rows pitch of 24 px', () => {
  assert.equal(COLS.desktop, 24); assert.equal(COLS.tablet, 12); assert.equal(ROW_PX, 12); assert.equal(ROW_GAP, 12);
  assert.match(css, new RegExp(`--row:${ROW_PX}px;--row-gap:${ROW_GAP}px`));
  assert.match(css, /@media\(min-width:1100px\)\{\.cards\.free\{grid-template-columns:repeat\(24,/); assert.match(css, /\.cards\.free\{grid-template-columns:repeat\(12,/);
  assert.match(css, /\.cards\.free>\.card\{grid-column:calc\(var\(--cx\) \+ 1\) \/ span var\(--cw\);grid-row:calc\(var\(--cy\) \+ 1\) \/ span var\(--ch\)/);
});
test('free layout content adapts and is never cut off: cards scroll, charts and KPI tiles scale', () => {
  assert.match(css, /\.cards\.free>\.card\{[^}]*overflow:auto/, 'a small card scrolls its content');
  assert.doesNotMatch(css, /header\{position:sticky/, 'a sticky header could cover a whole small card');
  assert.match(css, /\.cards\.free>\.card figure\.chart svg\{flex:1 1 0;min-height:0;height:100%\}/, 'a chart fills the card height');
  assert.match(css, /\.cards\.free \.dl-scroll\{max-height:none/, 'a list uses the card scroll, not a second one');
  assert.match(css, /@container \(max-height:100px\)/); assert.match(css, /\.cards\.free>\.card\.kpi\{[^}]*overflow:auto/);
  assert.doesNotMatch(css, /\.card\.chart-card\{[^}]*max-height/);
});
test('layout mode: the whole card is the handle, contents are inert, a phone gets no editor', () => {
  assert.match(css, /\.cards\.editing>\.card>\*\{pointer-events:none\}/);
  assert.match(css, /\.wide-only,\.layoutbar\{display:none!important\}/);
  assert.match(css, /@media\(min-width:640px\)\{\[data-move\]\{display:none\}\}/, 'the earlier/later buttons are for the phone only');
  for (const w of ['Edit layout', 'Done', 'Undo', 'Redo', 'Tidy up', 'Reset to default', 'Hidden cards']) assert.ok(appJs.includes(w), w);
  assert.match(appJs, /bpNow\(\) === 'phone'/);
});
test('the periodic refresh never runs while the layout is being edited, so a drag or an unsaved change is not lost', () => {
  assert.match(appJs, /setInterval\(\(\) => \{ if \(document\.body\.classList\.contains\('layout-editing'\)\) return; saveScroll\(\); location\.reload\(\); \}/);
  assert.match(appJs, /document\.body\.classList\.add\('layout-editing'\)/); assert.match(appJs, /document\.body\.classList\.remove\('layout-editing'\)/);
});
test('keyboard: arrows move a focused card, Shift+arrows resize, Ctrl+Z undoes; the pointer path is cancelled by Escape', () => {
  assert.match(appJs, /ArrowLeft: \[-1, 0\]/); assert.match(appJs, /e\.shiftKey \? resizeRect/); assert.match(appJs, /e\.key\.toLowerCase\(\) === 'z'/); assert.match(appJs, /e\.key === 'Escape' && act/);
  assert.match(appJs, /aria-live/, 'changes are announced');
});
test('everything saved stays in the browser: the editor adds no request and no server write path', () => {
  const grid = fs.readFileSync(new URL('../supervisor/dashui/grid.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(grid, /fetch|XMLHttpRequest|sendBeacon|localStorage|document|window/);
  const editor = appJs.slice(appJs.indexOf('if (grid) {'), appJs.indexOf('// dockable navigation'));
  assert.doesNotMatch(editor, /fetch\(|XMLHttpRequest|sendBeacon|innerHTML|\.submit\(/);
});
