// Issue #431: the periodic refresh must not reload the page. Pure plan logic, and checks on the wiring in app.js.
// (The browser layout-shift test is a separate issue, #494.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { planRefresh, refreshBlocked } from '../supervisor/dashui/logic.mjs';

const appJs = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
const render = fs.readFileSync(new URL('../supervisor/dashrender.mjs', import.meta.url), 'utf8');

test('planRefresh: an unchanged page plans nothing', () => {
  const p = planRefresh({ 'card:a': '1', 'card:b': '2' }, { 'card:a': '1', 'card:b': '2' });
  assert.deepEqual(p, { added: [], removed: [], changed: [], sameSet: true });
});
test('planRefresh: only a region whose markup differs is changed', () => {
  const p = planRefresh({ 'card:a': '1', 'card:b': '2' }, { 'card:a': '1', 'card:b': '3' });
  assert.deepEqual(p.changed, ['card:b']); assert.equal(p.sameSet, true);
});
test('planRefresh: an added or removed card is reported, not treated as a reason to reload', () => {
  const add = planRefresh({ 'card:a': '1' }, { 'card:a': '1', 'card:b': '2' });
  assert.deepEqual([add.added, add.removed, add.changed, add.sameSet], [['card:b'], [], [], false]);
  const del = planRefresh({ 'card:a': '1', 'card:b': '2' }, { 'card:a': '1' });
  assert.deepEqual([del.added, del.removed, del.changed, del.sameSet], [[], ['card:b'], [], false]);
});
test('planRefresh: a changed set plus a changed existing card in the same refresh updates that card too', () => {
  const p = planRefresh({ 'card:a': '1', 'card:b': '2', 'card:c': '3' }, { 'card:a': '1x', 'card:c': '3', 'card:d': '4' });
  assert.deepEqual(p.added, ['card:d']); assert.deepEqual(p.removed, ['card:b']); assert.deepEqual(p.changed, ['card:a']); assert.equal(p.sameSet, false);
  const swap = planRefresh({ 'card:a': '1' }, { 'card:z': '1' });
  assert.deepEqual([swap.added, swap.removed], [['card:z'], ['card:a']], 'same count, different card');
});
test('planRefresh: status-bar items are planned by position the same way', () => {
  assert.deepEqual(planRefresh({ 'stat:0': 'a', 'stat:1': 'b' }, { 'stat:0': 'a', 'stat:1': 'c', 'stat:2': 'd' }).changed, ['stat:1']);
});
test('refreshBlocked: typing, a drag or resize, or a text selection holds the swap back; otherwise it runs', () => {
  assert.equal(refreshBlocked({}), false);
  for (const k of ['typing', 'dragging', 'selecting']) assert.equal(refreshBlocked({ [k]: true }), true, k);
});

test('no refresh path calls reload: not the timer, not a changed card set, not a failed fetch', () => {
  const start = appJs.indexOf('async function refreshInPlace('), end = appJs.indexOf("const secs = Number($('meta[name=refresh-seconds]')");
  assert.ok(start > 0 && end > start);
  const block = appJs.slice(appJs.indexOf('function rewire('), end);
  assert.doesNotMatch(block, /location\.(reload|assign|replace)|history\.go|\.reload\(/);
  const timer = appJs.slice(end, end + 200);
  assert.match(timer, /setInterval\(refreshInPlace,/);
  assert.doesNotMatch(timer, /reload/);
  assert.doesNotMatch(appJs, /setInterval\([^)]*reload/);
  assert.match(appJs.slice(start, end), /catch \{[^}]*next tick/, 'a failed fetch is ignored and retried at the next tick');
});
test('the refresh waits while the viewer is busy and keeps focus, scroll and expanded cards', () => {
  const fn = appJs.slice(appJs.indexOf('async function refreshInPlace('), appJs.indexOf("const secs = Number($('meta[name=refresh-seconds]')"));
  assert.match(fn, /refreshBlocked\(/); assert.match(fn, /getSelection\(\)/); assert.match(fn, /scrollTo\(scrollX, y\)/);
  assert.match(appJs, /\.focus\(\{ preventScroll: true \}\)/);
  assert.match(appJs, /swapNodes = c => \[\.\.\.c\.children\]\.filter\(n => !n\.matches\('header, \.resize'\)\)/, 'the card element and its header stay, so expanded/collapsed state survives');
});
test('without script the <noscript> meta refresh is unchanged', () => {
  assert.match(render, /<noscript><meta http-equiv="refresh" content="\$\{refreshSeconds\}"><\/noscript>/);
});
test('a card title with a live count is part of the card region and is updated in place', () => {
  assert.match(appJs, /m\['card:' \+ c\.dataset\.card\] = \(c\.querySelector\(':scope > header h2'\)\?\.outerHTML/, 'a changed title marks the card changed');
  assert.match(appJs, /lh\.textContent = fh\.textContent/, 'the title text is updated without replacing the bound header buttons');
  assert.equal(planRefresh({ 'card:needs': '<h2>Needs you</h2>body' }, { 'card:needs': '<h2>Needs you (2)</h2>body' }).changed[0], 'card:needs');
});
