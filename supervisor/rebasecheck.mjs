// Issue #158: a rebase must never drop a commit silently. Read-only comparison by patch-id (`git patch-id --stable`) of the
// commits on the old remote head that are not on the base against the rebased result, plus the two guarded steps a rebase job
// runs: prepare (fetch, then start from the REMOTE head, never a cached local branch) and push (verify, then
// --force-with-lease against the head that was fetched). Nothing here reads comment text or touches another branch.
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';

const SHA = /^[0-9a-f]{40}$/;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

function runner(repo) {
  return (args, input) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, input });
    if (r.status !== 0) throw new SupervisorError(`git ${args[0]} failed`);
    return r.stdout;
  };
}

// [{ sha, subject, patchId }] for the non-merge commits in `range`, oldest first. `--cherry-pick` (with a symmetric range) leaves
// out a commit whose patch main already has, so a commit that landed upstream is not counted as lost.
function listCommits(run, range, { cherry = false } = {}) {
  const revs = run(['rev-list', '--reverse', '--no-merges', ...(cherry ? ['--cherry-pick', '--right-only'] : []), range]).split('\n').filter(Boolean);
  const out = [];
  for (const sha of revs) {
    const patch = run(['show', '--format=', '--no-ext-diff', '--no-textconv', '--binary', '--no-renames', sha]);
    const id = patch.trim() === '' ? null : run(['patch-id', '--stable'], patch).trim().split(/\s+/)[0] || null;
    out.push({ sha, subject: run(['log', '-1', '--format=%s', sha]).trim(), patchId: id });
  }
  return out;
}

// What the rebase carries: the commit list of the new head, and the old-head commits (not on the base) missing from it.
export function checkRebase({ repoPath, base, oldHead, newHead }) {
  if (!SHA.test(oldHead) || !SHA.test(newHead)) throw new SupervisorError('rebase check needs two full commit ids');
  const run = runner(repoPath);
  const old = listCommits(run, `${base}...${oldHead}`, { cherry: true });
  const now = listCommits(run, `${base}..${newHead}`);
  const have = new Map();
  for (const c of now) have.set(c.patchId, (have.get(c.patchId) || 0) + 1);
  const missing = [];
  for (const c of old) {
    if (c.patchId === null) continue;              // an empty commit has no patch to lose
    const n = have.get(c.patchId) || 0;
    if (n > 0) have.set(c.patchId, n - 1); else missing.push({ sha: c.sha, subject: c.subject });
  }
  return { oldHead, newHead, commits: now.map(c => ({ sha: c.sha, subject: c.subject })), missing };
}

// Step 1 of a rebase job: fetch right now and start the branch from the remote head. A stale local copy is discarded; local
// commits that were never pushed are not on the remote head and are therefore not part of the rebase.
export function prepareRebase({ worktree, branch }) {
  if (!BRANCH.test(branch)) throw new SupervisorError('invalid branch name');
  const run = runner(worktree);
  run(['fetch', '--quiet', 'origin']);   // the branch and its base, so the rebase target is current too
  const oldHead = run(['rev-parse', `refs/remotes/origin/${branch}`]).trim();
  run(['checkout', '--quiet', '-B', branch, oldHead]);
  return { branch, oldHead };
}

// Last step: verify, then push with a lease on the fetched head. Returns { pushed, ... } and never throws for the two
// refusals the caller must report: `missing` (a commit was dropped) and `lease` (the branch moved during the job).
export function pushRebase({ worktree, branch, base, oldHead }) {
  if (!BRANCH.test(branch) || !BRANCH.test(base)) throw new SupervisorError('invalid branch name');
  const run = runner(worktree);
  run(['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  const newHead = run(['rev-parse', 'HEAD']).trim();
  const check = checkRebase({ repoPath: worktree, base: `origin/${base}`, oldHead, newHead });
  if (check.missing.length) return { pushed: false, reason: 'missing', ...check };
  const r = spawnSync('git', ['-C', worktree, 'push', '--quiet', `--force-with-lease=refs/heads/${branch}:${oldHead}`, 'origin', `HEAD:refs/heads/${branch}`], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) return { pushed: false, reason: 'lease', ...check };
  return { pushed: true, ...check };
}
