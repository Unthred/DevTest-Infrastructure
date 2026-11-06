// Issue #676: realGit.currentBranch and realGit.unpushedCommits against real git repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { realGit } from '../supervisor/realgit.mjs';

const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
function world(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'realgit-')); t.after(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const origin = path.join(d, 'origin.git'), wt = path.join(d, 'wt');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, wt], { stdio: 'ignore' });
  g(wt, 'config', 'user.email', 'a@example.invalid'); g(wt, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(wt, 'f'), 'x'); g(wt, 'add', 'f'); g(wt, 'commit', '-qm', 'i'); g(wt, 'push', '-q', 'origin', 'HEAD:main');
  g(wt, 'checkout', '-qb', 'claude/issue-1-x');
  return { d, origin, wt, git: realGit(wt) };
}
const commit = (wt, name) => { fs.writeFileSync(path.join(wt, name), name); g(wt, 'add', name); g(wt, 'commit', '-qm', name); };

test('currentBranch: the branch name on a branch, null when detached or missing', async t => {
  const w = world(t);
  assert.equal(await w.git.currentBranch(w.wt), 'claude/issue-1-x');
  g(w.wt, 'checkout', '-q', '--detach');
  assert.equal(await w.git.currentBranch(w.wt), null);
  assert.equal(await w.git.currentBranch(path.join(w.d, 'nope')), null);
});

test('unpushedCommits: counts commits no remote has, and 0 once pushed', async t => {
  const w = world(t);
  assert.equal(await w.git.unpushedCommits(w.wt), 0);
  commit(w.wt, 'a'); commit(w.wt, 'b');
  assert.equal(await w.git.unpushedCommits(w.wt), 2);
  const fresh = realGit(w.wt);
  g(w.wt, 'push', '-q', 'origin', 'HEAD');
  assert.equal(await fresh.unpushedCommits(w.wt), 0);
  assert.equal(await w.git.unpushedCommits(path.join(w.d, 'nope')), null);
});

test('unpushedCommits: a failed fetch still lets the count run, and keeps the hold', async t => {
  const w = world(t);
  commit(w.wt, 'a');
  fs.renameSync(w.origin, w.origin + '.gone');   // fetch now fails (exit 128)
  assert.equal(await w.git.unpushedCommits(w.wt), 1);
});

test('unpushedCommits: fetch refreshes remote refs, at most once per ttl per worktree', async t => {
  const w = world(t);
  commit(w.wt, 'a');
  // Another clone pushes the same commit to the origin: only a fetch lets this worktree see it.
  const other = path.join(w.d, 'other'); execFileSync('git', ['clone', '-q', w.origin, other], { stdio: 'ignore' });
  g(w.wt, 'push', '-q', 'origin', 'HEAD:refs/heads/claude/issue-1-x'); g(w.wt, 'update-ref', '-d', 'refs/remotes/origin/claude/issue-1-x');
  let clock = 1000; const git = realGit(w.wt, { now: () => clock, fetchTtlMs: 30000 });
  assert.equal(await git.unpushedCommits(w.wt), 0, 'the first call fetches and sees the pushed branch');
  g(w.wt, 'update-ref', '-d', 'refs/remotes/origin/claude/issue-1-x');
  clock += 1000;
  assert.equal(await git.unpushedCommits(w.wt), 1, 'inside the ttl no second fetch runs');
  clock += 40000;
  assert.equal(await git.unpushedCommits(w.wt), 0, 'after the ttl it fetches again');
});
