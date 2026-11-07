import test from 'node:test';
import assert from 'node:assert/strict';
import { runGuarded } from '../tools/test-guard.mjs';

const node = process.execPath;
test('a command that cleans up passes', () => {
  const r = runGuarded([node, '-e', "const fs=require('fs'),p=require('path');const d=fs.mkdtempSync(p.join(process.env.TMPDIR,'x-'));fs.rmSync(d,{recursive:true})"], { stdio: 'ignore' });
  assert.deepEqual(r.left, []); assert.equal(r.exit, 0);
});
test('a command that leaks into TMPDIR fails the guard and names the leak', () => {
  const r = runGuarded([node, '-e', "require('fs').mkdtempSync(require('path').join(process.env.TMPDIR,'leak-'))"], { stdio: 'ignore' });
  assert.equal(r.left.length, 1); assert.match(r.left[0], /^leak-/); assert.equal(r.exit, 1);
});
test('a failing command keeps its own exit code', () => {
  assert.equal(runGuarded([node, '-e', 'process.exit(3)'], { stdio: 'ignore' }).exit, 3);
});
