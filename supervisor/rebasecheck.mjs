// Issue #158: a rebase must never drop a commit silently. Read-only comparison by patch-id (`git patch-id --stable`) of the
// commits on the old remote head that are not on the base against the rebased result, plus the two guarded steps a rebase job
// runs: prepare (fetch, then start from the REMOTE head, never a cached local branch) and push (verify, then
// --force-with-lease against the head that was fetched). Nothing here reads comment text or touches another branch.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';
import { classifyChanges } from './rebasehunks.mjs';
import { recordRefusal, readRefusal, recordStop, STOPPED } from './rebaserefusal.mjs';

const SHA = /^[0-9a-f]{40}$/;
const MAX_DIFF_LINES = 20000;
const BRANCH = /^[A-Za-z0-9._/-]+$/;

function runner(repo) {
  return (args, input) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 64 << 20, input });
    if (r.status !== 0) throw Object.assign(new SupervisorError(`git ${args[0]} failed`), { stdout: r.stdout });   // merge-tree reports a conflict on stdout
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
    const [subject, ident] = run(['log', '-1', '--format=%s%x00%an <%ae> %aI', sha]).replace(/\n$/, '').split('\0');
    out.push({ sha, subject, ident, patchId: id });
  }
  return out;
}

// What the rebase carries: the commit list of the new head, and the old-head commits (not on the base) missing from it.
export function checkRebase({ repoPath, base, oldHead, newHead }) {
  if (!SHA.test(oldHead) || !SHA.test(newHead)) throw new SupervisorError('rebase check needs two full commit ids');
  const run = runner(repoPath);
  const old = listCommits(run, `${base}...${oldHead}`, { cherry: true });
  const now = listCommits(run, `${base}..${newHead}`);
  // Pass 1: patch-id. Pass 2: a conflict resolution changes the patch (and so its patch-id) but a rebase keeps the author, author
  // date and subject, so a commit with no patch-id match is paired with an unused new commit of the same identity.
  // A pair found by identity has its hunks compared (rebasehunks.mjs, issue #1228), so a resolution that dropped a change is named.
  // Known limits (issue #164, pinned by tests, all fail safe): each new commit pairs at most once, so identical-identity twins need two new commits; --reset-author-date,
  // --ignore-date, squashes and commits emptied by a resolution (git drops them) are reported missing, unless the new base already holds their change, even next to another main edit (issue #640); a block main also placed at the same spot while rewriting BOTH neighbouring lines is reported (issue #875).
  const used = new Set();
  const unmatched = [];
  for (const c of old) {
    if (c.patchId === null) continue;              // an empty commit has no patch to lose
    const m = now.find(n => !used.has(n.sha) && n.patchId === c.patchId);
    if (m) used.add(m.sha); else unmatched.push(c);
  }
  const missing = [];
  const changedPairs = [];   // paired by identity, patch differs: the hunks are compared (issue #1228)
  for (const c of unmatched) {
    const m = now.find(n => !used.has(n.sha) && n.ident === c.ident && n.subject === c.subject);
    if (m) { used.add(m.sha); changedPairs.push({ old: c, now: m }); } else if (!alreadyApplied(run, c.sha, base)) missing.push({ sha: c.sha, subject: c.subject });
  }
  const { lostChanges, conflictHunks } = classifyChanges(run, { pairs: changedPairs, base, oldHead, newHead, extra: now.filter(n => !used.has(n.sha)).map(n => n.sha) });
  const commits = now.map(c => ({ sha: c.sha, subject: c.subject }));
  return { oldHead, newHead, commits, missing, lostChanges, conflictHunks, resolvedConflicts: resolvedConflicts(run, base, oldHead, newHead) };
}

// Issue #640: a commit that a resolution emptied (git drops it) is not missing when the new base already holds its change (a squash
// into the result does not count: that stays reported): a trial three-way merge of the commit onto the base, from the commit's parent,
// is clean and leaves the base's tree unchanged.
// A change main made differently (the merge conflicts) is NOT applied, so it stays refused and a person decides.
function alreadyApplied(run, sha, base) {
  try {
    const out = run(['merge-tree', '--write-tree', `--merge-base=${sha}^`, base, sha]).trim().split('\n')[0];
    if (SHA.test(out) && out === run(['rev-parse', base + '^{tree}']).trim()) return true;
  } catch { /* a conflict, a root commit or an old git: judge by the changed lines below */ }
  return changedLinesOnBase(run, sha, base);
}

// The same change made next to another main edit: git's three-way merge conflicts although the commit's own lines are on main.
// Judged by lines, per hunk with no context: the lines the commit added appear in order, consecutively, in the base's file, and a
// line it removed is gone from the base's file (unless the commit re-adds it). Added, deleted, renamed and binary files are not
// judged this way and stay reported.
function changedLinesOnBase(run, sha, base) {
  let diff;
  try { diff = run(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', `${sha}^`, sha]).split('\n'); } catch { return false; }
  if (diff.length > MAX_DIFF_LINES) return false;
  const hunks = []; let file = null; let header = false; let cur = null;
  for (const line of diff) {
    if (line.startsWith('diff --git ')) { header = true; file = null; cur = null; continue; }
    if (header) {
      if (/^(new file mode|deleted file mode|rename |Binary files|GIT binary)/.test(line)) return false;
      if (line.startsWith('+++ ')) file = line.slice(6).replace(/\t.*$/, '');
      else if (line.startsWith('@@')) header = false;
      if (header) continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
      cur = { file, removed: [], added: [], oldStart: m ? Number(m[1]) : null, oldCount: m ? (m[2] === undefined ? 1 : Number(m[2])) : null };
      hunks.push(cur); continue;
    }
    if (!cur) continue;
    if (line.startsWith('-')) cur.removed.push(line.slice(1).trim());
    else if (line.startsWith('+')) cur.added.push(line.slice(1).trim());
  }
  if (!hunks.length) return false;
  if (!countsHold(run, sha, base, hunks)) return false;
  for (const h of hunks) {
    if (!h.file) return false;
    const lines = fileLines(run, base, h.file);
    if (!lines.length) return false;
    if (!h.added.some(meaningful) && !h.removed.some(meaningful)) return false;
    if (h.added.some(meaningful)) {
      // Issue #875: the block must also sit where the hunk maps to, not merely appear somewhere (the same line added elsewhere).
      const want = hunkAnchors(readParentLines(run, sha, h.file), h);
      if (!want) return false;
      const map = parentToBase(run, sha, base, h.file);   // where main left the parent's anchor lines; null = unknown
      if (!map) return false;
      const pB = want.prevIdx === null ? null : map(want.prevIdx), nB = want.nextIdx === null ? null : map(want.nextIdx);
      if (pB === null && nB === null) return false;      // both anchors rewritten by main: cannot place the block, so refuse
      let found = false;
      for (let i = 0; i + h.added.length <= lines.length && !found; i++) {
        if (!h.added.every((t, k) => lines[i + k] === t)) continue;
        // The neighbour must be the very base line the parent's neighbour maps to (not merely the same text elsewhere in the file);
        // main may have edited one neighbour, so either unchanged one anchors the block.
        const prev = nearestMeaningfulIdx(lines, i - 1, -1), next = nearestMeaningfulIdx(lines, i + h.added.length, 1);
        found = (pB !== null && prev === pB) || (nB !== null && next === nB);
      }
      if (!found) return false;
    }
    for (const t of h.removed.filter(meaningful)) if (!h.added.includes(t) && lines.includes(t)) return false;
  }
  return true;
}

function nearestMeaningfulIdx(lines, from, step) {
  for (let i = from; i >= 0 && i < lines.length; i += step) if (meaningful(lines[i])) return i;
  return null;
}
// Issue #875: maps a 0-based line index of `file` at the commit's parent to its index on the base, through the parent-to-base diff;
// null for a line main changed or removed. Returns null (not a function) when the diff cannot be read.
function parentToBase(run, sha, base, file) {
  let d;
  try { d = run(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', `${sha}^`, base, '--', file]).split('\n'); } catch { return null; }
  if (d.length > MAX_DIFF_LINES) return null;
  const hs = [];
  for (const l of d) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
    if (m) hs.push({ os: Number(m[1]), oc: m[2] === undefined ? 1 : Number(m[2]), nc: m[4] === undefined ? 1 : Number(m[4]) });
  }
  return idx => {
    const n = idx + 1; let off = 0;
    for (const h of hs) {
      if (h.oc > 0 && n >= h.os && n < h.os + h.oc) return null;
      if ((h.oc === 0 ? h.os : h.os + h.oc - 1) < n) off += h.nc - h.oc;
    }
    return n + off - 1;
  };
}
function readParentLines(run, sha, file) {
  try { return readLines(run, `${sha}^`, file); } catch { return null; }
}
// The unchanged lines either side of a -U0 hunk in the commit's parent: { prev, next }, or null when they cannot be known
// (unparsed header, unreadable parent, or nothing meaningful on either side: too weak to anchor, so the guard refuses).
function hunkAnchors(parent, h) {
  if (!parent || h.oldStart === null || h.oldCount === null) return null;
  const first = h.oldCount === 0 ? h.oldStart : h.oldStart - 1;   // 0-based index of the first removed line, or where a pure add goes
  const prevIdx = nearestMeaningfulIdx(parent, first - 1, -1), nextIdx = nearestMeaningfulIdx(parent, first + h.oldCount, 1);
  return prevIdx === null && nextIdx === null ? null : { prevIdx, nextIdx };
}

// Count rule (review of PR #683): a line the commit adds may already exist in the file, so "it appears in the base" does not show the
// commit's copy survived. Per file, each meaningful added line must appear in the base at least (times at the commit's parent +
// times the commit adds it). Counts that cannot be read (a missing file, a git error) mean not applied, so the guard refuses.
export function countsHold(run, sha, base, hunks) {
  const need = new Map();   // file -> Map(line -> times the commit adds it)
  for (const h of hunks) {
    if (!h.file) return false;
    const m = need.get(h.file) || need.set(h.file, new Map()).get(h.file);
    for (const t of h.added.filter(meaningful)) m.set(t, (m.get(t) || 0) + 1);
  }
  for (const [file, adds] of need) {
    let parent; let now;
    try { parent = readLines(run, `${sha}^`, file); now = readLines(run, base, file); } catch { return false; }
    for (const [t, n] of adds) if (countOf(now, t) < countOf(parent, t) + n) return false;
  }
  return true;
}
function readLines(run, rev, file) { return run(['show', `${rev}:${file}`]).split('\n').map(l => l.trim()); }

const meaningful = t => /[A-Za-z0-9]/.test(t);
function fileLines(run, rev, file) {
  try { return run(['show', `${rev}:${file}`]).split('\n').map(l => l.trim()); } catch { return []; }
}
const countOf = (lines, t) => lines.reduce((n, l) => n + (l === t ? 1 : 0), 0);
// Issue #258: did the rebase resolve a conflict? A trial three-way merge of the old head onto the point the new head was rebased onto
// (the merge base of the new head and the base, so a base that moved on since does not matter) is conflict-free and has exactly the
// new head's tree when the rebase was clean. true = a conflict or any difference from that clean result; null = could not be
// judged (the caller then counts the job as a writer). Read-only: merge-tree writes objects only.
function resolvedConflicts(run, base, oldHead, newHead) {
  try {
    const point = run(['merge-base', base, newHead]).trim();
    if (!SHA.test(point)) return null;
    const mb = run(['merge-base', point, oldHead]).trim();
    if (!SHA.test(mb)) return null;
    let tree;
    try { tree = run(['merge-tree', '--write-tree', '--merge-base=' + mb, point, oldHead]).trim().split('\n')[0]; } catch { return true; }   // non-zero: the merge conflicts
    const result = run(['rev-parse', newHead + '^{tree}']).trim();
    return !(SHA.test(tree) && tree === result);
  } catch { return null; }
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

// Issue #1228: a refusal names the commit, the file and the hunk, and says whether the change is missing or altered. The first one asks
// the agent to repair it in the same run and push once more; the second ends the run (rebase-stop).
const LIMIT = 5;
const FIRST = fs.readFileSync(new URL('./rebase-refusal-first.txt', import.meta.url), 'utf8').trim();
const SECOND = fs.readFileSync(new URL('./rebase-refusal-second.txt', import.meta.url), 'utf8').trim();
function describe(check) {
  return [
    ...check.missing.map(m => `commit ${m.sha.slice(0, 8)} "${m.subject}" is missing from the result`),
    ...check.lostChanges.map(l => `commit ${l.commit.slice(0, 8)} "${l.subject}", ${l.file}, hunk ${l.hunk}: the change is ${l.kind} (${l.text})`),
  ];
}
export function refusal(check, branch, oldHead, attempt = 1) {
  const items = describe(check);
  const more = items.length > LIMIT ? ` (and ${items.length - LIMIT} more)` : '';
  const what = `Refused: ${items.length} problem${items.length === 1 ? '' : 's'}: ${items.slice(0, LIMIT).join('; ')}${more}.`;
  if (attempt >= 2) return `${what} ${SECOND.replace('{head}', () => oldHead.slice(0, 8)).replace('{branch}', () => branch)}`;
  return `${what} ${FIRST}`;
}

// Last step: verify, then push with a lease on the fetched head. Returns { pushed, ... } and never throws for the two
// refusals the caller must report: `missing` (a commit was dropped) and `lease` (the branch moved during the job).
export function pushRebase({ worktree, branch, base, oldHead }) {
  if (!BRANCH.test(branch) || !BRANCH.test(base)) throw new SupervisorError('invalid branch name');
  const run = runner(worktree);
  run(['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  const newHead = run(['rev-parse', 'HEAD']).trim();
  const check = checkRebase({ repoPath: worktree, base: `origin/${base}`, oldHead, newHead });
  const refused = reason => {
    const earlier = readRefusal(worktree, oldHead);
    const attempt = (earlier && earlier.reason !== STOPPED ? earlier.attempts || 1 : 0) + 1;
    const message = refusal(check, branch, oldHead, attempt);
    if (attempt >= 2) recordStop(worktree, { oldHead, message });   // the second refusal ends the run like rebase-stop
    else recordRefusal(worktree, { oldHead, reason, message, attempts: attempt });
    return { pushed: false, reason, message, attempt, stop: attempt >= 2, ...check };
  };
  if (check.missing.length) return refused('missing');
  if (check.lostChanges.length) return refused('lost-changes');   // issue #415; issue #1422: conflictHunks do not refuse, the review judges them
  const r = spawnSync('git', ['-C', worktree, 'push', '--quiet', `--force-with-lease=refs/heads/${branch}:${oldHead}`, 'origin', `HEAD:refs/heads/${branch}`], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) return { pushed: false, reason: 'lease', ...check };
  return { pushed: true, ...check };
}
