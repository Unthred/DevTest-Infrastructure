// The guarded commands a rebase job calls (the prompt names exactly these). Returns true when `command` was one of them.
import { SupervisorError } from './core.mjs';
import { prepareRebase, pushRebase } from './rebasecheck.mjs';
import { recordStop, readRefusal } from './rebaserefusal.mjs';

export const REBASE_USAGE = 'rebase-prepare --worktree DIR --branch B | rebase-push --worktree DIR --branch B --base BASE --old SHA | rebase-stop --worktree DIR --old SHA --reason TEXT';

const need = (a, flags, usage) => { if (!flags.every(f => a[f])) throw new SupervisorError(`usage: ${usage}`); };

export function rebaseCommand(command, a) {
  if (command === 'rebase-prepare') {
    need(a, ['worktree', 'branch'], 'rebase-prepare --worktree DIR --branch BRANCH');
    console.log(JSON.stringify(prepareRebase({ worktree: a.worktree, branch: a.branch }), null, 2));
  } else if (command === 'rebase-push') {
    need(a, ['worktree', 'branch', 'base', 'old'], 'rebase-push --worktree DIR --branch BRANCH --base BASE --old OLD_HEAD');
    const result = pushRebase({ worktree: a.worktree, branch: a.branch, base: a.base, oldHead: a.old });
    console.log(JSON.stringify(result, null, 2));
    if (!result.pushed) process.exitCode = 3;
  } else if (command === 'rebase-stop') {   // issue #1207
    need(a, ['worktree', 'old', 'reason'], 'rebase-stop --worktree DIR --old OLD_HEAD --reason TEXT');
    recordStop(a.worktree, { oldHead: a.old, message: a.reason });
    // recordStop is best effort; tell the agent when no note was written instead of reporting success.
    const written = readRefusal(a.worktree, a.old);
    console.log(JSON.stringify({ stopped: Boolean(written) }));
    if (!written) process.exitCode = 3;
  } else return false;
  return true;
}
