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
  // Known limits (issue #164, pinned by tests, all fail safe): the fallback proves presence, not that the content survived a
  // resolution; each new commit pairs at most once, so identical-identity twins need two new commits; --reset-author-date,
  // --ignore-date, squashes and commits emptied by a resolution (git drops them) are reported missing, unless the new base already holds their change, even next to another main edit (issue #640).
  const used = new Set();
  const unmatched = [];
  for (const c of old) {
    if (c.patchId === null) continue;              // an empty commit has no patch to lose
    const m = now.find(n => !used.has(n.sha) && n.patchId === c.patchId);
    if (m) used.add(m.sha); else unmatched.push(c);
  }
  const missing = [];
  for (const c of unmatched) {
    const m = now.find(n => !used.has(n.sha) && n.ident === c.ident && n.subject === c.subject);
    if (m) used.add(m.sha); else if (!alreadyApplied(run, c.sha, base)) missing.push({ sha: c.sha, subject: c.subject });
  }
  return { oldHead, newHead, commits: now.map(c => ({ sha: c.sha, subject: c.subject })), missing, lostChanges: lostChanges(run, base, oldHead, newHead), resolvedConflicts: resolvedConflicts(run, base, oldHead, newHead) };
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
    if (line.startsWith('@@')) { cur = { file, removed: [], added: [] }; hunks.push(cur); continue; }
    if (!cur) continue;
    if (line.startsWith('-')) cur.removed.push(line.slice(1).trim());
    else if (line.startsWith('+')) cur.added.push(line.slice(1).trim());
  }
  if (!hunks.length) return false;
  for (const h of hunks) {
    if (!h.file) return false;
    const lines = fileLines(run, base, h.file);
    if (!lines.length) return false;
    if (!h.added.some(meaningful) && !h.removed.some(meaningful)) return false;
    if (h.added.some(meaningful)) {
      let found = false;
      for (let i = 0; i + h.added.length <= lines.length && !found; i++) found = h.added.every((t, k) => lines[i + k] === t);
      if (!found) return false;
    }
    for (const t of h.removed.filter(meaningful)) if (!h.added.includes(t) && lines.includes(t)) return false;
  }
  return true;
}

// Issue #415: a conflict resolution can lose a change INSIDE a commit while the commit list still looks complete (PR #222 kept
// `runDueProbes` and dropped its only call). Compares what the PR added (relative to its merge base with the base, at the old head
// and at the new head), by text only, no model. Lost = [{ file, kind: 'line'|'unreferenced', text }]:
//  - line: added at the old head, absent from the same file at the new head (so a line the base now also has is not lost), and not
//    added anywhere else by the new head (a moved line is not lost). Lines without a letter or digit (braces) are ignored.
//  - unreferenced: a function the new head adds that nothing else in the tree mentions; an exported one only when the old head
//    did reference it (a new public helper nobody calls yet is normal, a vanished call site is not).
// Reports file and the added line / identifier only. Known limit: it judges text, so a line rewritten beyond containing the original counts as lost (fails safe).
const MAX_LOST = 50;
const MAX_DIFF_LINES = 20000;
const DEFINITION = [
  /^\s*(export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*()(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/
];

// { file -> [added line text] } of `from..to` (no context, no renames, so a rename shows as delete plus add and fails safe).
// onHunk(file, removed[], added[]) (issue #640) reports each hunk's trimmed removed and added lines, so a caller can pair them.
function addedLines(run, from, to, onHunk = null) {
  const out = new Map();
  const diff = run(['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', from, to]).split('\n');
  if (diff.length > MAX_DIFF_LINES) throw new SupervisorError('rebase check: diff too large to compare');
  let file = null; let header = false; let removed = []; let added = [];
  const flush = () => { if (onHunk && file && removed.length && added.length) onHunk(file, removed, added); removed = []; added = []; };
  for (const line of diff) {
    if (line.startsWith('diff --git ')) { flush(); header = true; file = null; continue; }
    if (header) {
      if (line.startsWith('+++ ')) file = line === '+++ /dev/null' ? null : line.slice(6).replace(/\t.*$/, '');
      else if (line.startsWith('@@')) header = false;
      continue;
    }
    if (line.startsWith('@@')) { flush(); continue; }
    if (line.startsWith('-')) removed.push(line.slice(1).trim());
    if (file && line.startsWith('+')) { if (!out.has(file)) out.set(file, []); out.get(file).push(line.slice(1)); added.push(line.slice(1).trim()); }
  }
  flush();
  return out;
}
const meaningful = t => /[A-Za-z0-9]/.test(t);
function fileLines(run, rev, file) {
  try { return run(['show', `${rev}:${file}`]).split('\n').map(l => l.trim()); } catch { return []; }
}
const countOf = (lines, t) => lines.reduce((n, l) => n + (l === t ? 1 : 0), 0);
// Mentions of `name` (whole word) in the tree at `rev`, not counting the definition line itself.
function mentions(run, rev, name, defText) {
  let out = '';
  try { out = run(['grep', '-n', '-w', '-F', '-I', '-e', name, rev]); } catch { return 0; }   // exit 1 = no match
  let n = 0;
  for (const l of out.split('\n').filter(Boolean)) {
    const text = l.replace(/^[^:]*:[^:]*:\d+:/, '').trim();   // rev:file:line:text (file names with ':' are not expected here)
    if (text !== defText) n++;
  }
  return n;
}

// Issue #580: a conflict on a list (`['a', 'b']` on each side) is resolved by a union line holding both sides' items. The PR's line
// is then not a substring of it. It survives only when a truly merged line, one that is in neither the old head's file nor the
// base's (main's) file, carries the PR line as an ordered subsequence of its tokens AND punctuation (whitespace ignored), so a
// negation, a reordered argument list or a line taken from main is not a union. Needs two or more word tokens.
const lexOf = t => t.match(/[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) || [];
function unionSurvives(t, newFile, oldFile, mainFile) {
  const want = lexOf(t);
  if (want.filter(k => /[A-Za-z0-9_$]/.test(k)).length < 2) return false;
  const exclude = new Set([...oldFile, ...mainFile]);
  return newFile.some(l => {
    if (exclude.has(l)) return false;
    let i = 0;
    for (const k of lexOf(l)) if (i < want.length && k === want[i]) i++;
    return i === want.length;
  });
}

// Issue #640: both sides edited the same line. The PR changed base line B into `t`; main changed B into some M. A correct resolution is
// a line L in neither head's file (a real merge) that holds every token of a main-changed line M and, in order, every token the PR
// added to B. A line taken whole from main, or from the PR, is excluded by the file checks, so a dropped change is still refused.
function addedTokens(t, baseLine) {
  const a = lexOf(baseLine), b = lexOf(t);
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const kept = new Set(); let i = 0, j = 0;
  while (i < a.length && j < b.length) { if (a[i] === b[j]) { kept.add(j); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
  return b.filter((_, k) => !kept.has(k));
}
const inOrder = (want, have) => { let i = 0; for (const k of have) if (i < want.length && k === want[i]) i++; return i === want.length; };
const wordy = ks => ks.filter(k => /[A-Za-z0-9_$]/.test(k)).length;
// `mains` are the lines main turned the base line B into; `taken` holds merged lines already used for another PR line, so one merged
// line cannot vouch for two PR lines (a change dropped at one site while another site was merged stays refused).
function sameLineMerged(t, baseLines, newFile, oldFile, mainFile, mainRepl, taken) {
  const exclude = new Set([...oldFile, ...mainFile]);
  for (const b of baseLines) {
    const added = addedTokens(t, b);
    if (!wordy(added)) continue;   // a punctuation-only edit is too weak to prove
    const mains = (mainRepl.get(b) ?? []).filter(m => meaningful(m) && !oldFile.includes(m) && wordy(lexOf(m)) >= 2);
    for (const l of newFile) {
      if (exclude.has(l) || taken.has(l)) continue;
      const lex = lexOf(l);
      if (inOrder(added, lex) && mains.some(m => inOrder(lexOf(m), lex))) { taken.add(l); return true; }
    }
  }
  return false;
}

function lostChanges(run, base, oldHead, newHead) {
  const oldMb = run(['merge-base', base, oldHead]).trim();
  const newMb = run(['merge-base', base, newHead]).trim();
  if (!SHA.test(oldMb) || !SHA.test(newMb)) throw new SupervisorError('rebase check: no merge base');
  const bases = new Map();   // file\0added line -> the base line(s) it replaced in the PR
  const before = addedLines(run, oldMb, oldHead, (file, rem, add) => add.forEach((x, i) => {
    const k = file + '\0' + x;
    bases.set(k, [...(bases.get(k) ?? []), ...(rem.length === add.length ? [rem[i]] : rem)]);   // by position when the hunk replaced line for line
  }));
  const after = addedLines(run, newMb, newHead);
  const lost = [];
  const addedAfter = new Set([...after.values()].flat().map(t => t.trim()));
  for (const [file, lines] of before) {
    const oldFile = fileLines(run, oldHead, file);
    const newFile = fileLines(run, newHead, file);
    const mainFile = fileLines(run, base, file);
    let mainRepl = null;   // base line -> the lines main replaced it with (lazy)
    const taken = new Set();
    const seen = new Set();
    for (const raw of lines) {
      const t = raw.trim();
      if (!meaningful(t) || seen.has(t)) continue;
      seen.add(t);
      if (countOf(newFile, t) >= countOf(oldFile, t) || addedAfter.has(t)) continue;
      if (t.length >= 4 && newFile.some(l => l.includes(t))) continue;   // a resolution that merged the line into a longer one keeps the change
      if (unionSurvives(t, newFile, oldFile, mainFile)) continue;   // issue #580: a list merged from both sides keeps every token
      const key = `${file}\0${t}`;
      if (bases.has(key)) { if (!mainRepl) { const r = new Map(); addedLines(run, oldMb, base, (f, rem, add) => { if (f !== file) return; rem.forEach((x, i) => r.set(x, [...(r.get(x) ?? []), ...(rem.length === add.length ? [add[i]] : add)])); }); mainRepl = r; }
        if (sameLineMerged(t, bases.get(key), newFile, oldFile, mainFile, mainRepl, taken)) continue; }   // issue #640
      lost.push({ file, kind: 'line', text: t.slice(0, 200) });
    }
  }
  for (const [file, lines] of after) {
    const defs = new Map();   // name -> { exported, text }
    for (const raw of lines) for (const re of DEFINITION) { const m = re.exec(raw); if (m) { defs.set(m[2], { exported: !!m[1], text: raw.trim() }); break; } }
    for (const [name, d] of defs) {
      if (mentions(run, newHead, name, d.text) > 0) continue;
      if (d.exported && mentions(run, oldHead, name, d.text) === 0) continue;
      lost.push({ file, kind: 'unreferenced', text: name });
    }
  }
  return lost.slice(0, MAX_LOST);
}

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

// Issue #640: a refusal names what it saw and who can accept it, so a person can push deliberately if the resolution is right.
function refusal(check, branch, oldHead) {
  const parts = [];
  if (check.missing.length) parts.push(`commit ${check.missing[0].sha.slice(0, 8)} "${check.missing[0].subject}" is not in the result`);
  if (check.lostChanges.length) parts.push(`${check.lostChanges[0].file}: "${check.lostChanges[0].text}" is not in the result`);
  const what = parts.join('; ');
  return `Refused: ${what}. If the resolution is deliberate, only the homeowner or a reviewer may accept it, by pushing with git push --force-with-lease=refs/heads/${branch}:${oldHead} origin HEAD:refs/heads/${branch}.`;
}

// Last step: verify, then push with a lease on the fetched head. Returns { pushed, ... } and never throws for the two
// refusals the caller must report: `missing` (a commit was dropped) and `lease` (the branch moved during the job).
export function pushRebase({ worktree, branch, base, oldHead }) {
  if (!BRANCH.test(branch) || !BRANCH.test(base)) throw new SupervisorError('invalid branch name');
  const run = runner(worktree);
  run(['fetch', '--quiet', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);
  const newHead = run(['rev-parse', 'HEAD']).trim();
  const check = checkRebase({ repoPath: worktree, base: `origin/${base}`, oldHead, newHead });
  if (check.missing.length) return { pushed: false, reason: 'missing', message: refusal(check, branch, oldHead), ...check };
  if (check.lostChanges.length) return { pushed: false, reason: 'lost-changes', message: refusal(check, branch, oldHead), ...check };   // issue #415: nothing is pushed as a clean rebase
  const r = spawnSync('git', ['-C', worktree, 'push', '--quiet', `--force-with-lease=refs/heads/${branch}:${oldHead}`, 'origin', `HEAD:refs/heads/${branch}`], { encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) return { pushed: false, reason: 'lease', ...check };
  return { pushed: true, ...check };
}
