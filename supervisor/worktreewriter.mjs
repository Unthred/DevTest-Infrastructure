// Issue #351 follow-up: who wrote a pull request head that an inbox job pushed to a branch of its own choosing. The job's recorded
// branch (claude/inbox-<id>) then does not match the PR branch, so no job record is found by branch or number. The evidence accepted
// here is git's own bookkeeping in the job's worktree, which Foreman created and recorded: the HEAD reflog has a `commit` entry (written by
// git, not by the agent) for this exact head SHA, made inside the job's run window. Nothing the writer says about itself is read: not a
// commit message, PR text or the job summary. A later commit by anyone else has another SHA and no entry, so it starts unknown again.
// Local `git reflog` read only; no model call, no network.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SHA = /^[0-9a-f]{40}$/;
// Reflog subjects git writes when the working tree's owner makes a commit. A reset, checkout, pull, rebase or branch move is not authorship.
const AUTHORED = /^(?:commit(?: \((?:amend|merge|initial)\))?|cherry-pick|revert):/;
const SLACK_MS = 120000;     // reflog times are whole seconds and the job record is written a moment around the first command

const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 15000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } });
const commonDir = cwd => { const d = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(); return fs.realpathSync(d); };

// Returns { head, at } when the worktree's HEAD reflog shows a commit entry for `head` inside [from, to], else null.
// `repoPath`, when given, must be the repository the worktree belongs to (a reused or foreign directory proves nothing).
export function findWorktreeWriter({ worktree, head, from, to, repoPath = null }) {
  if (!SHA.test(head || '') || !path.isAbsolute(worktree || '') || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  try {
    if (!fs.statSync(worktree).isDirectory()) return null;
    if (repoPath && commonDir(worktree) !== commonDir(repoPath)) return null;
    const out = git(worktree, ['reflog', 'show', '--date=raw', '--format=%H%x09%gd%x09%gs', 'HEAD']);
    for (const line of out.split('\n')) {
      const [h, sel, subject] = line.split('\t');
      const m = /^HEAD@\{(\d+) [+-]\d{4}\}$/.exec(sel || '');
      if (h !== head || !m || !AUTHORED.test(subject || '')) continue;
      const at = Number(m[1]) * 1000;
      if (at >= from - SLACK_MS && at <= to + SLACK_MS) return { head, at };
    }
  } catch { /* unreadable, missing or not a repository: no evidence */ }
  return null;
}
