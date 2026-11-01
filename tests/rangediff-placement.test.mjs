// Issue #128: rangeEqual placement check and a whitespace-only regression that imports rangeEqual alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rangeEqual } from '../supervisor/rangediff.mjs';

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdp-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x' };
  const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  return { dir, g, w: (f, s) => fs.writeFileSync(path.join(dir, f), s) };
}
const block = 'a\nb\nc\nd\ne\nf\ng\n';
const withX = (n, header = '') => { const parts = [block, block, block]; parts[n] = 'a\nb\nc\nd\nX\ne\nf\ng\n'; return header + parts.join('-\n'); };

test('real git: a rebase that puts a hunk in a different repeated block does not compare equal; the genuine rebase does', t => {
  const { g, w } = repo(t);
  w('f.txt', [block, block, block].join('-\n')); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat'); w('f.txt', withX(0)); g('commit', '-qam', 'feature'); const old = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main'); w('f.txt', ['# one\n# two\n', block, block, block].join('-\n').replace('-\n', '')); // header lines above all blocks
  g('commit', '-qam', 'main moves');
  g('checkout', '-q', 'feat'); g('rebase', '-q', 'main'); const clean = g('rev-parse', 'HEAD');
  assert.equal(rangeEqual({ repoPath: g('rev-parse', '--show-toplevel'), base: 'main', oldHead: old, newHead: clean }), true);
  // same commit message and identical hunk text, but the line is added in the second block
  g('checkout', '-q', '--detach', 'main'); const main = fs.readFileSync(path.join(g('rev-parse', '--show-toplevel'), 'f.txt'), 'utf8');
  const parts = main.split('-\n'); // [header+block, block, block] after the join above
  assert.equal(parts.length, 3);
  parts[1] = 'a\nb\nc\nd\nX\ne\nf\ng\n';
  w('f.txt', parts.join('-\n')); g('commit', '-qam', 'feature'); const moved = g('rev-parse', 'HEAD');
  assert.equal(rangeEqual({ repoPath: g('rev-parse', '--show-toplevel'), base: 'main', oldHead: old, newHead: moved }), false);
});

test('real git: a hunk misplaced when main did not move is refused too', t => {
  const { dir, g, w } = repo(t);
  w('f.txt', [block, block, block].join('-\n')); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat'); w('f.txt', withX(0)); g('commit', '-qam', 'feature'); const a = g('rev-parse', 'HEAD');
  g('checkout', '-q', 'main'); g('checkout', '-q', '--detach', 'main'); w('f.txt', withX(2)); g('commit', '-qam', 'feature'); const b = g('rev-parse', 'HEAD');
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: a, newHead: b }), false);
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: a, newHead: a }), true);
});

test('real git: a whitespace-only difference alone makes rangeEqual false', t => {
  const { dir, g, w } = repo(t);
  w('p.py', 'def get(u):\n    pass\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat'); w('p.py', 'def get(u):\n    if u:\n        return 1\n    return 2\n'); g('commit', '-qam', 'feature'); const old = g('rev-parse', 'HEAD');
  g('checkout', '-q', '--detach', 'main'); w('p.py', 'def get(u):\n    if u:\n        return 1\n        return 2\n'); g('commit', '-qam', 'feature'); const indent = g('rev-parse', 'HEAD');
  g('checkout', '-q', '--detach', 'main'); w('p.py', 'def get(u):\n    if u:\n        return 1\n    return 2 \n'); g('commit', '-qam', 'feature'); const trail = g('rev-parse', 'HEAD');
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: indent }), false);
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: trail }), false);
  assert.equal(rangeEqual({ repoPath: dir, base: 'main', oldHead: old, newHead: old }), true);
});
