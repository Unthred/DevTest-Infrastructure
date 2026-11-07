// Issue #708: readLastSnapshot reads only a tail of the history yet agrees with readSnapshots(...).at(-1).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLastSnapshot, readSnapshots } from '../supervisor/dashdata.mjs';

const file = root => path.join(root, 'dashboard', 'snapshots.jsonl');
function root(t) { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'lastsnap-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); fs.mkdirSync(path.join(r, 'dashboard'), { recursive: true }); return r; }

test('no file gives null; an empty file gives null', t => {
  const r = root(t); assert.equal(readLastSnapshot(r), null);
  fs.writeFileSync(file(r), ''); assert.equal(readLastSnapshot(r), null);
});
test('returns the newest snapshot, skipping a torn last line', t => {
  const r = root(t);
  fs.writeFileSync(file(r), `${JSON.stringify({ at: 1, plan: [] })}\n${JSON.stringify({ at: 2, plan: [{ type: 'x' }] })}\n{"at": 3, "pl`);
  assert.equal(readLastSnapshot(r).at, 2);
  assert.deepEqual(readLastSnapshot(r), readSnapshots(r).at(-1));
});
test('a history larger than the tail window still returns the last line', t => {
  const r = root(t); const pad = 'p'.repeat(2000);
  const lines = Array.from({ length: 600 }, (_, i) => JSON.stringify({ at: i + 1, pad }));
  fs.writeFileSync(file(r), lines.join('\n') + '\n');
  assert.ok(fs.statSync(file(r)).size > 512 * 1024);
  assert.equal(readLastSnapshot(r).at, 600);
});
