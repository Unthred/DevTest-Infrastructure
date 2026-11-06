// Real-git adapter for the team (extracted from cli.mjs so tests can import it; cli.mjs runs main() on import).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rangeEqual } from './rangediff.mjs';
import { checkRebase } from './rebasecheck.mjs';
import { SupervisorError, WorktreeUnusable, gitCommonDir } from './core.mjs';

export function realGit(repoPath, { now = Date.now, fetchTtlMs = 30000 } = {}) {
  const fetched = new Map();   // issue #676: worktree -> time of its last fetch attempt, so one tick fetches a worktree once
  const git = (...args) => { const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new SupervisorError(`git ${args[0]} failed`); return r.stdout.trim(); };
  return {
    // range-diff equality (issue #79); refs are fetched first so both heads and the base are present
    rangeEqual: async ({ base, oldHead, newHead }) => { git('fetch', '--quiet', 'origin'); return rangeEqual({ repoPath, base, oldHead, newHead }); },
    // issue #158: the commits a rebase carried and the ones it dropped (by patch-id), checked again by the dispatcher after the job
    checkRebase: async ({ base, oldHead, newHead }) => { git('fetch', '--quiet', 'origin'); return checkRebase({ repoPath, base, oldHead, newHead }); },
    // issue #302: true only when git can prove the worktree has no uncommitted work (tracked or untracked); anything else is false/null
    isClean: async wt => { if (!fs.existsSync(wt)) return null; const r = spawnSync('git', ['-C', wt, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8', timeout: 60000 }); return r.status === 0 ? r.stdout.trim() === '' : null; },
    // issue #610: the branch the worktree has checked out (null when detached or unknown)
    currentBranch: async wt => { if (!fs.existsSync(wt)) return null; const r = spawnSync('git', ['-C', wt, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', timeout: 60000 }); return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null; },
    // issue #629: save a job's worktree before it is closed: commit uncommitted work (ignored files stay out) and push HEAD to a new branch under saved/,
    // which never matches an agent branch prefix. Returns { ref } when something was pushed, { missing: true } when there is no worktree.
    saveWork: async (wt, { branch, id }) => {
      if (!fs.existsSync(wt)) return { missing: true };
      const run = (...args) => spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', timeout: 120000 });
      const dirty = run('status', '--porcelain', '--untracked-files=all');
      if (dirty.status !== 0) throw new SupervisorError('git status failed in the job worktree');
      if (dirty.stdout.trim()) {
        if (run('add', '-A').status !== 0 || run('-c', 'user.name=Foreman', '-c', 'user.email=foreman@localhost', 'commit', '-q', '-m', `Save unfinished work of job ${id}`).status !== 0) throw new SupervisorError('the job worktree could not be committed');
      }
      run('fetch', '--quiet', 'origin');
      const n = Number(run('rev-list', '--count', 'HEAD', '--not', '--remotes').stdout.trim());
      if (!Number.isSafeInteger(n)) throw new SupervisorError('git could not tell what is unpushed');
      if (n === 0) return {};
      const ref = `saved/${id}-${String(branch || 'work').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)}`;
      if (run('push', '-q', 'origin', `HEAD:refs/heads/${ref}`).status !== 0) throw new SupervisorError('the job work could not be pushed to a saved branch');
      return { ref };
    },
    // issue #583: commits in the worktree's HEAD that no remote branch has; null when it cannot be told (callers then keep the hold)
    unpushedCommits: async wt => { if (!fs.existsSync(wt)) return null; if (!(now() - (fetched.get(wt) ?? -Infinity) < fetchTtlMs)) { fetched.set(wt, now()); spawnSync('git', ['-C', wt, 'fetch', '--quiet', 'origin'], { encoding: 'utf8', timeout: 20000 }); } /* issue #610: best effort; a failed fetch leaves stale refs, which only keeps the hold. Issue #676: attempted at most once per ttl per worktree (a failure is not retried inside it) and bounded to 20 s */ const r = spawnSync('git', ['-C', wt, 'rev-list', '--count', 'HEAD', '--not', '--remotes'], { encoding: 'utf8', timeout: 60000 }); const n = Number(r.stdout.trim()); return r.status === 0 && Number.isSafeInteger(n) ? n : null; },
    // issue #495: existing worktree directories and local branches a new implement job would reuse unreset
    leftoversFor: async ({ worktrees, branchPrefixes }) => {
      const out = worktrees.filter(w => fs.existsSync(w)).map(w => `a worktree at ${w}`);
      for (const pre of branchPrefixes) { const r = spawnSync('git', ['-C', repoPath, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${pre}*`], { encoding: 'utf8', timeout: 60000 }); if (r.status !== 0) throw new SupervisorError('git for-each-ref failed'); out.push(...r.stdout.split('\n').filter(Boolean).map(b => `the local branch ${b}`)); }
      return out;
    },
    worktreeFor: async branch => { const out = git('worktree', 'list', '--porcelain').split('\n\n'); const hit = out.find(b => b.includes(`branch refs/heads/${branch}`)); return hit ? hit.split('\n')[0].replace('worktree ', '') : null; },
    ensureWorktree: async ({ path: wt, branch, base }) => {
      if (fs.existsSync(wt)) {
        // An existing directory is reused only if it is a linked worktree of THIS repository (resolved from its own absolute path).
        let common = null;
        try { common = gitCommonDir(wt); } catch { /* not a git checkout at all */ }
        if (common !== fs.realpathSync(path.join(repoPath, '.git'))) throw new WorktreeUnusable(`${wt} is not a linked worktree of ${repoPath}`, wt);
        return wt;
      }
      git('fetch', '--quiet', 'origin');
      const exists = spawnSync('git', ['-C', repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
      if (exists) git('worktree', 'add', wt, branch); else git('worktree', 'add', '-b', branch, wt, base);
      return wt;
    }
  };
}
