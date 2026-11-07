// Refresh in place (issue #930): the pure rules. The DOM behaviour (nothing moves, closes or clears) is checked in real Chromium by tests/refresh-browser.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TYPING_HOLD_MS, busyReason, diffRegions, serverClasses, stamp } from '../supervisor/dashui/refresh.mjs';
import { STATIC } from '../supervisor/dashserver.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { overviewView } from './helpers/lists-fixture.mjs';

const read = f => fs.readFileSync(new URL(`../supervisor/dashui/${f}`, import.meta.url), 'utf8');
const m = o => new Map(Object.entries(o));

test('diff: only a card whose content changed is reported; equal maps change nothing', () => {
  const prev = m({ 'c:a': '1', 'c:b': '2', stats: 's' });
  assert.deepEqual(diffRegions(prev, m({ 'c:a': '1', 'c:b': '2', stats: 's' })), { changed: [], added: [], removed: [], any: false });
  const d = diffRegions(prev, m({ 'c:a': '1', 'c:b': '3', stats: 's' }));
  assert.deepEqual(d.changed, ['c:b']); assert.equal(d.any, true);
});
test('diff: a new card is added, a vanished card is removed, and an empty page against a full one removes all', () => {
  const d = diffRegions(m({ 'c:a': '1', 'c:b': '2' }), m({ 'c:a': '1', 'c:c': '9' }));
  assert.deepEqual([d.added, d.removed, d.changed], [['c:c'], ['c:b'], []]);
  assert.deepEqual(diffRegions(m({ 'c:a': '1' }), m({})).removed, ['c:a']);
});

const idle = { layoutEditing: false, dragging: false, dialogOpen: false, expanded: false, menuOpen: false, fieldFocused: false, sinceKey: null, selecting: false };
test('busy: an idle viewer is never held up', () => assert.equal(busyReason(idle), null));
test('busy: each interaction holds the update, and says why', () => {
  assert.equal(busyReason({ ...idle, layoutEditing: true }), 'layout editing');
  assert.equal(busyReason({ ...idle, dragging: true }), 'dragging');
  assert.equal(busyReason({ ...idle, dialogOpen: true }), 'dialog open');
  assert.equal(busyReason({ ...idle, expanded: true }), 'card expanded');
  assert.equal(busyReason({ ...idle, menuOpen: true }), 'menu open');
  assert.equal(busyReason({ ...idle, selecting: true }), 'text selected');
  assert.equal(busyReason({ ...idle, fieldFocused: true, sinceKey: 500 }), 'typing');
});
test('busy: a focused field only holds while the viewer is typing; a long-idle focus does not hold forever', () => {
  assert.equal(busyReason({ ...idle, fieldFocused: true, sinceKey: TYPING_HOLD_MS + 1 }), null);
  assert.equal(busyReason({ ...idle, fieldFocused: true, sinceKey: null }), null, 'focused but never typed');
  assert.equal(busyReason({ ...idle, fieldFocused: false, sinceKey: 100 }), null, 'typed, then left the field');
});
test('busy: a manual refresh skips the typing and selection holds but never a dialog, a drag or the layout editor', () => {
  assert.equal(busyReason({ ...idle, fieldFocused: true, sinceKey: 1, selecting: true }, { manual: true }), null);
  for (const k of ['layoutEditing', 'dragging', 'dialogOpen', 'expanded', 'menuOpen']) assert.notEqual(busyReason({ ...idle, [k]: true }, { manual: true }), null, k);
});

test('server classes ignore what the page script adds, so a layout class is never synced away', () => {
  assert.deepEqual(serverClasses('card hc-action collapsed expanded lay-active measuring chart-card'), ['card', 'chart-card', 'hc-action']);
  assert.deepEqual(serverClasses(''), []);
});
test('the indicator time is hh:mm:ss with zero padding', () => assert.equal(stamp(new Date(2026, 0, 2, 3, 4, 5)), '03:04:05'));

test('the browser module is served, makes one same-origin GET, sends nothing and never reloads', () => {
  assert.deepEqual(STATIC['/static/refresh.mjs'], ['refresh.mjs', 'text/javascript; charset=utf-8']);
  const js = read('refresh.mjs');
  assert.equal((js.match(/fetchFn\(/g) || []).length, 1);
  assert.match(js, /fetchFn\(doc\.defaultView\.location\.href, \{ headers: \{ accept: 'text\/html' \}, credentials: 'same-origin', cache: 'no-store' \}\)/);
  assert.doesNotMatch(js, /method:|body:|sendBeacon|XMLHttpRequest|WebSocket|eval\(|new Function|document\.write|location\.reload|location\.assign/);
  assert.doesNotMatch(read('app.js'), /location\.reload\(/);
});
test('every page keeps the no-script meta refresh, plus the interval the script reads', async () => {
  const html = renderRoute(await overviewView({ needs: 2 }), { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  assert.match(html, /<noscript><meta http-equiv="refresh" content="60"><\/noscript><meta name="refresh-seconds" content="60">/);
  const watch = renderRoute(await overviewView({ needs: 2 }), { page: 'overview' }, { query: new URLSearchParams(), pathname: '/', refreshSeconds: 0 }).html;
  assert.doesNotMatch(watch, /refresh-seconds/);
});
test('the card shell keeps what the swap relies on: a header first, then the body, ids on every card', async () => {
  const html = renderRoute(await overviewView({ needs: 2 }), { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  const cards = [...html.matchAll(/<section class="card [^"]*" data-card="([^"]+)"[^>]*><header>/g)].map(x => x[1]);
  assert.ok(cards.length > 5); assert.equal(new Set(cards).size, cards.length, 'card ids are unique');
});

test('rows are kept by item id, and an Undo compares with the live page (issue #930 review)', () => {
  const src = read('refresh.mjs');
  assert.match(src, /export function retainRows/);   // a row unchanged on the server stays the same element
  assert.match(src, /live = false/);                  // a refresh can compare with the page as it is now
  assert.match(read('app.js'), /refresher\?\.refresh\(true, \{ live: true \}\)/);
  assert.doesNotMatch(read('app.js'), /\.refresh-now'\)/);
});
