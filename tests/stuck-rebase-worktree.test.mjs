import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

process.env.AI_SUPERVISOR_IMPORT_ONLY = '1';
const { realGit } = await import('../supervisor/cli.mjs');
const { worktreeForBranch } = await import('../supervisor/worktreelookup.mjs');
const { WorktreeUnusable } = await import('../supervisor/core.mjs');

const BRANCH = 'claude/issue-1154-v2-item-24';
const run = (cwd, env, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];

// A repository with a linked worktree whose rebase of BRANCH stopped at an edit step, two of four commands done.
function fixture() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'stuck-'));
  made.push(dir);
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  run(repo, {}, 'init', '-q', '-b', 'main');
  const commit = (cwd, name) => {
    fs.writeFileSync(path.join(cwd, name), name);
    run(cwd, {}, 'add', name);
    run(cwd, {}, ...ident, 'commit', '-q', '-m', name);
  };
  commit(repo, 'base');
  const wt = path.join(dir, 'DevTest-Infrastructure-claude-1154');
  run(repo, {}, 'worktree', 'add', '-q', '-b', BRANCH, wt);
  for (const n of ['one', 'two', 'three', 'four']) commit(wt, n);
  const editor = path.join(dir, 'seq.sh');
  fs.writeFileSync(editor, '#!/bin/sh\nsed -i "2s/^pick/edit/" "$1"\n', { mode: 0o755 });
  run(wt, { GIT_SEQUENCE_EDITOR: editor }, ...ident, 'rebase', '-i', 'main');
  return { dir, repo, wt };
}

test('a worktree stopped in a rebase of the branch is found by the lookup', async () => {
  const { repo, wt } = fixture();
  assert.ok(fs.existsSync(path.join(run(wt, {}, 'rev-parse', '--absolute-git-dir'), 'rebase-merge')));
  assert.equal(await realGit(repo).worktreeFor(BRANCH), fs.realpathSync(wt));
});

test('ensureWorktree raises WorktreeUnusable naming the stuck worktree and adds nothing', async () => {
  const { dir, repo, wt } = fixture();
  const before = fs.readdirSync(dir).sort();
  const wanted = path.join(dir, 'DevTest-Infrastructure-claude-fix-1175');
  await assert.rejects(realGit(repo).ensureWorktree({ path: wanted, branch: BRANCH, base: `origin/${BRANCH}` }), error => {
    assert.ok(error instanceof WorktreeUnusable);
    assert.equal(error.worktree, fs.realpathSync(wt));
    assert.match(error.message, /rebase of claude\/issue-1154-v2-item-24 is stopped/);
    assert.match(error.required, /continue or abort/);
    return true;
  });
  assert.ok(!fs.existsSync(wanted));
  assert.deepEqual(fs.readdirSync(dir).sort(), before);
});

test('the not-a-linked-worktree case keeps its message', async () => {
  const { dir, repo } = fixture();
  const clone = path.join(dir, 'clone');
  fs.mkdirSync(clone);
  run(clone, {}, 'init', '-q');
  const message = `${clone} is not a linked worktree of ${repo}`;
  await assert.rejects(realGit(repo).ensureWorktree({ path: clone, branch: 'x', base: 'main' }), error => {
    return error instanceof WorktreeUnusable && error.message === message && error.required === null;
  });
});

test('a branch checked out normally is found', async () => {
  const { dir, repo } = fixture();
  const other = path.join(dir, 'normal');
  run(repo, {}, 'worktree', 'add', '-q', '-b', 'plain', other);
  assert.equal(await realGit(repo).worktreeFor('plain'), fs.realpathSync(other));
});

test('a detached worktree with no rebase, or a head-name that is empty or another branch, matches nothing', async () => {
  const { dir, repo, wt } = fixture();
  const det = path.join(dir, 'detached');
  run(repo, {}, 'worktree', 'add', '-q', '--detach', det);
  const listing = () => run(repo, {}, 'worktree', 'list', '--porcelain');
  assert.equal(worktreeForBranch(listing(), 'detached-branch'), null);
  const headName = path.join(run(wt, {}, 'rev-parse', '--absolute-git-dir'), 'rebase-merge', 'head-name');
  fs.writeFileSync(headName, '\n');
  assert.equal(worktreeForBranch(listing(), BRANCH), null);
  fs.writeFileSync(headName, 'refs/heads/some/other\n');
  assert.equal(worktreeForBranch(listing(), BRANCH), null);
  assert.equal(worktreeForBranch(listing(), 'some/other'), fs.realpathSync(wt));
});

test('a failing git call carries one line of what git printed, at most 300 characters', async () => {
  const { repo } = fixture();
  await assert.rejects(realGit(repo).ensureWorktree({ path: path.join(repo, '..', 'nope'), branch: 'zz', base: 'origin/does-not-exist' }), error => {
    assert.match(error.message, /^git fetch failed|^git worktree failed: .+/);
    assert.ok(!error.message.includes('\n'));
    assert.ok(error.message.length <= 'git worktree failed: '.length + 300);
    assert.match(error.message, /fatal|invalid|not a valid|origin/i);
    return true;
  });
});
