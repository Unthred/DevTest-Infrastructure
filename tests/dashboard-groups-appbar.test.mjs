// Issue #927: card groups (grid.mjs), the card picker and layout bar wiring, and app bar editing (appbar.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { addGroup, cleanGroups, compactGroups, groupOf, overlaps, placeGroup, removeGroups, sanitizeLayout, toSaved, withoutCard } from '../supervisor/dashui/grid.mjs';
import { addBarItem, barToSaved, moveBarItem, removeBarItem, sanitizeBar } from '../supervisor/dashui/appbar.mjs';
import { STATIC } from '../supervisor/dashserver.mjs';

const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
const appJs = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
const R = (x, y, w, h) => ({ x, y, w, h });
const noOverlap = pos => { const v = Object.values(pos); return v.every((a, i) => v.slice(i + 1).every(b => !overlaps(a, b))); };

test('cleanGroups: unknown ids, repeats, single members and a card in two groups are all dropped', () => {
  const on = { a: 1, b: 1, c: 1, d: 1 };
  assert.deepEqual(cleanGroups([['a', 'b'], ['b', 'c', 'd']], on), [['a', 'b'], ['c', 'd']], 'b stays in the first group only');
  assert.deepEqual(cleanGroups([['a', 'zzz']], on), [], 'one real member is not a group');
  assert.deepEqual(cleanGroups([['a', 'a']], on), []);
  for (const bad of [null, 'x', 4, {}, [null, 'a', [], 7]]) assert.deepEqual(cleanGroups(bad, on), [], JSON.stringify(bad));
  assert.deepEqual(cleanGroups([['__proto__', 'a']], on), []);
});

test('addGroup absorbs existing groups; removeGroups and withoutCard dissolve them', () => {
  const g0 = [['a', 'b']];
  assert.deepEqual(addGroup(g0, ['b', 'c']).map(g => [...g].sort()), [['a', 'b', 'c']], 'a card is never in two groups');
  assert.deepEqual(addGroup(g0, ['c']), g0, 'one card is not a group');
  assert.deepEqual(addGroup([], ['a', 'b']), [['a', 'b']]);
  assert.deepEqual(removeGroups([['a', 'b'], ['c', 'd']], ['d']), [['a', 'b']]);
  assert.deepEqual(removeGroups([['a', 'b']], ['z']), [['a', 'b']]);
  assert.deepEqual(withoutCard([['a', 'b', 'c']], 'c'), [['a', 'b']]);
  assert.deepEqual(withoutCard([['a', 'b']], 'b'), [], 'a group of one dissolves');
  assert.equal(groupOf([['a', 'b']], 'b').length, 2); assert.equal(groupOf([['a', 'b']], 'x'), null);
  const keep = [['a', 'b']]; addGroup(keep, ['b', 'c']); assert.deepEqual(keep, [['a', 'b']], 'input is not mutated');
});

test('placeGroup moves the block as one, keeps relative places, clamps to the grid and pushes others clear', () => {
  const pos = { a: R(0, 0, 6, 6), b: R(6, 0, 6, 6), c: R(0, 6, 12, 4), x: R(12, 0, 6, 6) };
  const out = placeGroup(pos, ['a', 'b'], 3, 2, 24);
  assert.deepEqual([out.a, out.b], [R(3, 2, 6, 6), R(9, 2, 6, 6)], 'both moved by the same amount');
  assert.ok(noOverlap(out));
  assert.deepEqual(out.x.x, 12, 'x was pushed down, not sideways');
  assert.ok(out.x.y >= 8);
  const edge = placeGroup(pos, ['a', 'b'], -50, -50, 24);
  assert.deepEqual([edge.a, edge.b], [pos.a, pos.b], 'cannot leave the top left corner');
  const right = placeGroup(pos, ['a', 'b'], 99, 0, 24);
  assert.equal(right.b.x + right.b.w, 24, 'right edge of the block stops at the grid edge');
  assert.equal(right.b.x - right.a.x, 6);
  assert.deepEqual(placeGroup(pos, ['nope'], 3, 3, 24), pos, 'unknown members change nothing');
  assert.equal(pos.a.x, 0, 'pure: the input is untouched');
});

test('compactGroups closes gaps with a group as one block', () => {
  const pos = { a: R(0, 10, 6, 4), b: R(6, 14, 6, 4), c: R(12, 30, 6, 4) };
  const alone = compactGroups(pos, []);
  assert.equal(alone.a.y, 0); assert.equal(alone.b.y, 0, 'ungrouped cards each slide to the top');
  const grouped = compactGroups(pos, [['a', 'b']]);
  assert.equal(grouped.a.y, 0); assert.equal(grouped.b.y, 4, 'the group keeps its relative offset');
  assert.equal(grouped.c.y, 0);
  assert.ok(noOverlap(grouped));
  const blocked = compactGroups({ top: R(6, 0, 6, 8), a: R(0, 20, 6, 4), b: R(6, 24, 6, 4) }, [['a', 'b']]);
  assert.ok(noOverlap(blocked)); assert.equal(blocked.b.y - blocked.a.y, 4, 'offset kept when one member is blocked');
  assert.equal(blocked.b.y, 8, 'the block stops where its blocked member rests');
});

test('the saved layout keeps groups, drops ones that no longer hold, and an old save without groups still loads', () => {
  const ids = ['a', 'b', 'c'], pos = { a: R(0, 0, 6, 6), b: R(6, 0, 6, 6), c: R(12, 0, 6, 6) };
  const st = { pos, hidden: [], groups: [['a', 'b']] };
  const saved = JSON.parse(JSON.stringify(toSaved(st, [])));
  assert.deepEqual(saved.groups, [['a', 'b']]);
  assert.deepEqual(sanitizeLayout(saved, ids, 24).groups, [['a', 'b']], 'the group survives a reload');
  assert.deepEqual(sanitizeLayout({ v: 2, pos, hidden: [] }, ids, 24).groups, []);
  assert.deepEqual(sanitizeLayout({ v: 2, pos, hidden: ['b'], groups: [['a', 'b']] }, ids, 24).groups, [], 'a removed card leaves the group; one left is no group');
  assert.deepEqual(sanitizeLayout({ v: 2, pos, hidden: [], groups: [['a', 'ghost']] }, ids, 24).groups, []);
  assert.deepEqual(sanitizeLayout({ v: 2, pos, hidden: [], groups: 'junk' }, ids, 24).groups, []);
});

test('the layout bar sits on the right, and the picker, box select and group controls are wired', () => {
  assert.match(css, /\.layoutbar\{justify-content:flex-end\}/);
  assert.ok(!appJs.includes('Hidden cards'), 'the hidden cards list is replaced by the card picker');
  for (const w of ['Cards (', "'Remove'", "'Add'", 'startBox', 'lay-box', 'placeGroup', 'compactGroups', 'addGroup', 'removeGroups']) assert.ok(appJs.includes(w), w);
  assert.match(css, /\.lay-box\{/); assert.match(css, /\.lay-selected/);
});

test('app bar: order, removal and adding back; bad saved data falls back to the server order', () => {
  const items = ['health', 'agents', 'last-tick', 'next-tick'];
  assert.deepEqual(sanitizeBar(null, items), { order: items, removed: [] });
  for (const bad of [4, 'x', [], { v: 2 }, { v: 1, order: 'x', removed: 7 }]) assert.deepEqual(sanitizeBar(bad, items), { order: items, removed: [] }, JSON.stringify(bad));
  assert.deepEqual(sanitizeBar({ v: 1, order: ['next-tick', 'zzz', 'health'], removed: ['agents', 'agents'] }, items), { order: ['next-tick', 'health', 'last-tick'], removed: ['agents'] }, 'unknown dropped, unlisted keep server order, removed are not in the order');
  assert.deepEqual(sanitizeBar({ v: 1, order: ['theme', 'brand'], removed: ['sticky'] }, items), { order: items, removed: [] }, 'fixed items are not editable');
  let s = sanitizeBar(null, items);
  s = moveBarItem(s, 'agents', -1); assert.deepEqual(s.order, ['agents', 'health', 'last-tick', 'next-tick']);
  assert.equal(moveBarItem(s, 'agents', -1), s, 'already first'); assert.equal(moveBarItem(s, 'next-tick', 1), s, 'already last');
  assert.equal(moveBarItem(s, 'nope', 1), s);
  s = removeBarItem(s, 'health'); assert.deepEqual(s, { order: ['agents', 'last-tick', 'next-tick'], removed: ['health'] });
  assert.equal(removeBarItem(s, 'health'), s, 'removing twice changes nothing');
  s = addBarItem(s, 'health'); assert.deepEqual(s, { order: ['agents', 'last-tick', 'next-tick', 'health'], removed: [] });
  assert.equal(addBarItem(s, 'agents'), s, 'adding one that is on the bar changes nothing');
  assert.deepEqual(sanitizeBar(JSON.parse(JSON.stringify(barToSaved(s))), items), s, 'round trip');
});

test('the app bar renders named items, an Edit bar button, and the module is served', async () => {
  const { renderPage } = await import('../supervisor/dashrender.mjs').then(m => ({ renderPage: m.renderPage || null }));
  assert.ok(STATIC['/static/appbar.mjs']);
  const src = fs.readFileSync(new URL('../supervisor/dashrender.mjs', import.meta.url), 'utf8');
  for (const id of ['brand', 'health', 'agents', 'last-tick', 'next-tick', 'page-data']) assert.ok(src.includes(`data-bar="${id}"`), id);
  assert.ok(src.includes('id="barEdit"'));
  assert.match(css, /\.statusbar>\.bar-removed\{display:none!important\}/);
  assert.ok(appJs.includes("from './appbar.mjs'")); void renderPage;
});
