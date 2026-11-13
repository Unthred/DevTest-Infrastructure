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
  const widths = { a: 100 };
  let applied = 0, committed = 0;
  bindResize(root, widths, { apply: () => { applied += 1; }, commit: () => { committed += 1; } });
  const grip = { dataset: { grip: 'a' }, closest: () => ({ getBoundingClientRect: () => ({ width: 100 }) }) };
  const press = key => listeners.keydown({ key, target: { closest: () => grip }, preventDefault() {} });
  press('ArrowRight');
  assert.equal(widths.a, 116);
  press('ArrowLeft');
  press('ArrowLeft');
  assert.equal(widths.a, 84);
  press('x');
  assert.deepEqual([applied, committed], [3, 3]);
});
