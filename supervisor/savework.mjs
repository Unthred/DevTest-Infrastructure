// issue #629 / #713: save a job's worktree before it is closed.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';
import { secretShaped } from './inbox.mjs';

export async function saveWork(wt, { branch, id }) {
  if (!fs.existsSync(wt)) return { missing: true };
  const run = (...args) => spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', timeout: 120000 });
  const dirty = run('status', '--porcelain', '--untracked-files=all');
  if (dirty.status !== 0) throw new SupervisorError('git status failed in the job worktree');
  if (dirty.stdout.trim()) {
    if (run('add', '-A').status !== 0) throw new SupervisorError('the job worktree could not be staged');
    // issue #713: nothing secret-shaped is committed or published; the files are unstaged again and the save is refused
    const added = run('diff', '--cached', '--no-color', '--unified=0');
    if (added.status !== 0) { run('reset', '-q'); throw new SupervisorError('the staged work could not be checked for secrets'); }
    if (added.stdout.split('\n').some(l => l.startsWith('+') && !l.startsWith('+++') && secretShaped(l.slice(1)))) { run('reset', '-q'); throw new SupervisorError('the job worktree holds secret-shaped text, so it is not saved; remove it first'); }
    if (run('-c', 'user.name=Foreman', '-c', 'user.email=foreman@localhost', 'commit', '-q', '-m', `Save unfinished work of job ${id}`).status !== 0) throw new SupervisorError('the job worktree could not be committed');
  }
  run('fetch', '--quiet', 'origin');
  const n = Number(run('rev-list', '--count', 'HEAD', '--not', '--remotes').stdout.trim());
  if (!Number.isSafeInteger(n)) throw new SupervisorError('git could not tell what is unpushed');
  if (n === 0) return {};
  const ref = `saved/${id}-${String(branch || 'work').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)}`;
  if (run('push', '-q', 'origin', `HEAD:refs/heads/${ref}`).status !== 0) throw new SupervisorError('the job work could not be pushed to a saved branch');
  return { ref };
}
