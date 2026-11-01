// Issue #79: whether two heads carry the same commits above a base, one for one (what `git range-diff` shows as `=`):
// same patch (git patch-id --stable) and same message, in the same order. Read-only; never writes to the repository.
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';

export function rangeEqual({ repoPath, base, oldHead, newHead }) {
  const run = (args, input) => {
    const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20, input });
    if (r.status !== 0) throw new SupervisorError(`git ${args[0]} failed`);
    return r.stdout;
  };
  const side = head => run(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean)
    .map(c => `${run(['patch-id', '--stable'], run(['show', '--format=', c])).split(' ')[0]}\n${run(['log', '-1', '--format=%B', c])}`);
  const a = side(oldHead), b = side(newHead);
  return a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
}
