// tools/ci/validate-no-handover-edit.sh (D-023): a branch that changes the handover fails; other changes and docs/handover-* pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../tools/ci/validate-no-handover-edit.sh', import.meta.url).pathname;
const H = 'docs/ai/CURRENT_HANDOVER.md';
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const put = (dir, f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nohov-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main'); put(dir, H, 'one\n'); put(dir, 'a.txt', 'a\n'); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'feature');
  return { dir, base };
}
const commit = (dir, f, s) => { put(dir, f, s); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', 'change'); };
const run = (r, env = {}) => spawnSync('bash', [script, r.base, 'HEAD'], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, HEAD_REF: '', ...env } });

test('a branch without handover changes passes', t => {
  const r = repo(t); commit(r.dir, 'a.txt', 'b\n');
  const o = run(r); assert.equal(o.status, 0, o.stderr); assert.match(o.stdout, /OK/);
});
test('a branch that edits the handover fails and says how to revert', t => {
  const r = repo(t); commit(r.dir, 'a.txt', 'b\n'); commit(r.dir, H, 'two\n');
  const o = run(r); assert.equal(o.status, 1); assert.match(o.stderr, /edits docs\/ai\/CURRENT_HANDOVER\.md/); assert.match(o.stderr, /D-023/);
});
test('an edit that is reverted within the branch passes; a deletion fails', t => {
  const r = repo(t); commit(r.dir, H, 'two\n'); commit(r.dir, H, 'one\n');
  assert.equal(run(r).status, 0);
  const d = repo(t); fs.rmSync(path.join(d.dir, H)); git(d.dir, 'add', '-A'); git(d.dir, 'commit', '-q', '-m', 'rm');
  assert.equal(run(d).status, 1);
});
test('handover changes that arrived on main after the branch point are not blamed on the branch', t => {
  const r = repo(t); commit(r.dir, 'a.txt', 'b\n');
  git(r.dir, 'checkout', '-q', 'main'); commit(r.dir, H, 'main edit\n'); git(r.dir, 'checkout', '-q', 'feature');
  const o = spawnSync('bash', [script, 'main', 'feature'], { cwd: r.dir, encoding: 'utf8' }); assert.equal(o.status, 0, o.stderr);
});
test('docs/handover-* head branches are exempt; look-alikes are not', t => {
  const r = repo(t); commit(r.dir, H, 'two\n');
  assert.equal(run(r, { HEAD_REF: 'docs/handover-2026-11-01' }).status, 0);
  assert.equal(run(r, { HEAD_REF: 'claude/docs/handover-x' }).status, 1);
  assert.equal(run(r, { HEAD_REF: 'docs/handoverx' }).status, 1);
});
test('a bad ref fails closed', t => {
  const r = repo(t);
  const o = spawnSync('bash', [script, 'nope', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }); assert.equal(o.status, 1); assert.match(o.stderr, /not a commit/);
});
