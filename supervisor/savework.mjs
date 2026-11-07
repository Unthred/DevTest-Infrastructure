// issue #629 / #713 / #802: save a job's worktree before it is closed.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';
import { secretShapedInFile } from './inbox.mjs';

// Returns the file path (or true) of the first added line that looks like a credential. Header lines are told apart from content by
// position (everything between "diff --git" and the first "@@"), so an added line that itself starts with "++" is still scanned.
export function secretInDiff(diff) {
  let inHeader = false, file = '';
  for (const l of String(diff).split('\n')) {
    if (l.startsWith('diff --git ') || l.startsWith('diff --cc ')) { inHeader = true; file = ''; continue; }
    if (inHeader) {
      if (l.startsWith('@@')) inHeader = false;
      else if (l.startsWith('+++ b/')) file = l.slice(6);
      continue;
    }
    if (l.startsWith('+') && secretShapedInFile(l.slice(1))) return file || true;
  }
  return false;
}

export async function saveWork(wt, { branch, id }) {
  if (!fs.existsSync(wt)) return { missing: true };
  const run = (...args) => spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 256 * 1024 * 1024 });
  const dirty = run('status', '--porcelain', '--untracked-files=all');
  if (dirty.status !== 0) throw new SupervisorError('git status failed in the job worktree');
  run('fetch', '--quiet', 'origin');
  // The index as the agent left it, so a refusal can put it back (a plain reset dropped pre-staged files).
  const before = run('write-tree');
  const refuse = message => {
    if (before.status === 0) run('read-tree', before.stdout.trim()); else run('reset', '-q');
    throw new SupervisorError(message);
  };
  const hasChanges = Boolean(dirty.stdout.trim());
  if (hasChanges && run('add', '-A').status !== 0) refuse('the job worktree could not be staged');
  // Nothing secret-shaped is committed or published. The scan covers the staged work and every commit not yet on a remote,
  // and reads binary files as text too.
  const staged = run('diff', '--cached', '--text', '--no-color', '--unified=0');
  const unpushed = run('log', '-m', '-p', '--text', '--no-color', '--unified=0', '--format=', 'HEAD', '--not', '--remotes');
  if (staged.status !== 0 || unpushed.status !== 0) refuse('the work could not be checked for secrets');
  const hit = secretInDiff(staged.stdout) || secretInDiff(unpushed.stdout);
  if (hit) refuse(`${hit === true ? 'the job worktree' : hit} holds secret-shaped text, so it is not saved; remove it first`);
  if (hasChanges && run('-c', 'user.name=Foreman', '-c', 'user.email=foreman@localhost', 'commit', '-q', '-m', `Save unfinished work of job ${id}`).status !== 0) throw new SupervisorError('the job worktree could not be committed');
  const n = Number(run('rev-list', '--count', 'HEAD', '--not', '--remotes').stdout.trim());
  if (!Number.isSafeInteger(n)) throw new SupervisorError('git could not tell what is unpushed');
  if (n === 0) return {};
  const ref = `saved/${id}-${String(branch || 'work').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)}`;
  if (run('push', '-q', 'origin', `HEAD:refs/heads/${ref}`).status !== 0) throw new SupervisorError('the job work could not be pushed to a saved branch');
  return { ref };
}
