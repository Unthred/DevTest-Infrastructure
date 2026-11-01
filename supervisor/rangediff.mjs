// Issue #79: whether two heads carry the same commits above a base, one for one (what `git range-diff` shows as `=`):
// the same patch, byte for byte, and the same message, in the same order. Read-only; never writes to the repository.
// Patches are compared as exact text, not by `git patch-id`, because patch-id ignores whitespace and an indentation
// change is a behaviour change in Python or YAML. Only what a clean rebase legitimately changes is dropped: the blob
// hashes on `index` lines and the line numbers in hunk headers.
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';

// Fixed output: no external diff or textconv (which could hide content), binary payloads included, no rename guessing.
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];

export function normalisePatch(text) {
  return text.split('\n').filter(l => !/^index [0-9a-f]+\.\.[0-9a-f]+/.test(l))
    .map(l => l.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/, '@@')).join('\n');
}

export function rangeEqual({ repoPath, base, oldHead, newHead }) {
  const run = (args) => {
    const r = spawnSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', timeout: 60000, maxBuffer: 64 << 20 });
    if (r.status !== 0) throw new SupervisorError(`git ${args[0]} failed`);
    return r.stdout;
  };
  // A merge commit's `show` is a combined diff that hides evil-merge hunks, so carry nothing across one.
  const hasMerge = head => run(['rev-list', '--min-parents=2', '-n', '1', `${base}..${head}`]).trim() !== '';
  if (hasMerge(oldHead) || hasMerge(newHead)) return false;
  // The net change against the base must match exactly too; an empty net change carries nothing.
  const net = head => normalisePatch(run(['diff', ...DIFF_FLAGS, `${base}...${head}`]));
  const oldNet = net(oldHead);
  if (oldNet.trim() === '' || oldNet !== net(newHead)) return false;
  const side = head => run(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean)
    .map(c => `${normalisePatch(run(['show', '--format=', ...DIFF_FLAGS, c]))}\n\0${run(['log', '-1', '--format=%B', c])}`);
  const a = side(oldHead), b = side(newHead);
  return a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
}
