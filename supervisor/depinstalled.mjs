// Issue #1103: the two outside-world facts a dependency check needs: which version is installed, and whether a commit is in it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// The installed version: the `current` link under the state root points at versions/<sha>. Null when nothing is installed.
export function installedShaOf(root) {
  try {
    const m = /^versions\/([0-9a-f]{40})$/.exec(fs.readlinkSync(path.join(root, 'current')));
    return m ? m[1] : null;
  } catch { return null; }
}

// Whether commit `a` is in commit `b`. A yes never changes, so it is remembered; a no is asked again (the install may move on).
export function gitAncestor(repoPath) {
  const yes = new Set();
  return (a, b) => {
    if (!repoPath || !/^[0-9a-f]{40}$/.test(a) || !/^[0-9a-f]{40}$/.test(b)) return false;
    const key = `${a}:${b}`;
    if (yes.has(key)) return true;
    const r = spawnSync('git', ['-C', repoPath, 'merge-base', '--is-ancestor', a, b], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0) { yes.add(key); return true; }
    if (r.status === 1) return false;
    throw new Error('git could not compare the commits');   // unknown, not "not installed"
  };
}
