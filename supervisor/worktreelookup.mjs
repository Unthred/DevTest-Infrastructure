import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { redact } from './redact.mjs';
import { WorktreeUnusable } from './core.mjs';

// issue #1276: a failed git call says what git printed: stderr on one line, redacted, at most 300 characters.
export function gitFailure(subcommand, result) {
  const said = String(result.stderr || '').replace(/\s+/g, ' ').trim();
  return said ? `git ${subcommand} failed: ${redact(said, 300)}` : `git ${subcommand} failed`;
}
// The branch whose rebase is stopped in a worktree (null when none). A worktree in that state is listed by git as detached.
export function rebaseOfBranch(worktree) {
  const dir = spawnSync('git', ['-C', worktree, 'rev-parse', '--git-dir'], { encoding: 'utf8', timeout: 60000 });
  if (dir.status !== 0) return null;
  const gitDir = path.resolve(worktree, dir.stdout.trim());
  for (const kind of ['rebase-merge', 'rebase-apply']) {
    try { return fs.readFileSync(path.join(gitDir, kind, 'head-name'), 'utf8').trim().replace(/^refs\/heads\//, '') || null; } catch { /* not this kind */ }
  }
  return null;
}
// The worktree for a branch from `git worktree list --porcelain`: checked out there, or detached with a rebase of that branch in progress.
export function worktreeForBranch(listing, branch) {
  for (const block of listing.split('\n\n')) {
    const lines = block.split('\n');
    const dir = lines[0].replace('worktree ', '');
    if (lines.includes(`branch refs/heads/${branch}`)) return dir;
    if (lines.includes('detached') && rebaseOfBranch(dir) === branch) return dir;
  }
  return null;
}
// Asking for a worktree for a branch whose rebase is stopped in a worktree is a condition to fix there; git worktree add would be refused.
export function refuseStuckRebase(listing, branch) {
  const stuck = worktreeForBranch(listing, branch);
  if (!stuck || rebaseOfBranch(stuck) !== branch) return;
  throw new WorktreeUnusable(`a rebase of ${branch} is stopped in ${stuck}`, stuck, 'continue or abort the rebase in that worktree');
}
