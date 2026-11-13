// The column rules shared by the Jobs and Inbox tables (issues #1220, #1219).
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WIDTH, MIN_WIDTH, bindResize, clampWidth, sanitizeColumns } from '../supervisor/dashui/table-columns.mjs';

const KEYS = ['a', 'b', 'c'];

test('sanitizeColumns drops unknown keys, clamps widths and never hides every column', () => {
  assert.deepEqual(sanitizeColumns({ hidden: ['b', 'zz', 'b'], widths: { a: 1, c: 99999, zz: 100, b: 'wide' } }, KEYS), { hidden: ['b'], widths: { a: MIN_WIDTH, c: MAX_WIDTH } });
  assert.deepEqual(sanitizeColumns({ hidden: KEYS }, KEYS).hidden, []);
  assert.deepEqual(sanitizeColumns(null, KEYS), { hidden: [], widths: {} });
  assert.equal(clampWidth(120.4), 120);
});

test('bindResize: an arrow key widens and narrows the column, within the limits, and saves', () => {
  const listeners = {};
  const root = { addEventListener: (type, fn) => { listeners[type] = fn; }, ownerDocument: { addEventListener() {}, removeEventListener() {} } };
  const state = { widths: { a: 100 } };
  let applied = 0, committed = 0;
  bindResize(root, state, { apply: () => { applied += 1; }, commit: () => { committed += 1; } });
  const grip = { dataset: { grip: 'a' }, closest: () => ({ getBoundingClientRect: () => ({ width: 100 }) }) };
  const press = key => listeners.keydown({ key, target: { closest: () => grip }, preventDefault() {} });
  press('ArrowRight');
  assert.equal(state.widths.a, 116);
  press('ArrowLeft');
  press('ArrowLeft');
  assert.equal(state.widths.a, 84);
  press('x');
  assert.deepEqual([applied, committed], [3, 3]);
});

test('bindResize keeps working when the caller replaces state.widths after a column toggle', () => {
  const listeners = {};
  const root = { addEventListener: (type, fn) => { listeners[type] = fn; }, ownerDocument: { addEventListener() {}, removeEventListener() {} } };
  const state = { widths: { a: 100 } };
  bindResize(root, state, { apply() {}, commit() {} });
  state.widths = { a: 100, b: 60 };   // what the Jobs column toggle and a saved view do
  const grip = { dataset: { grip: 'b' }, closest: () => ({ getBoundingClientRect: () => ({ width: 60 }) }) };
  listeners.keydown({ key: 'ArrowRight', target: { closest: () => grip }, preventDefault() {} });
  assert.equal(state.widths.b, 76);
});
