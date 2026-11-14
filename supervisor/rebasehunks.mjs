// Issue #1228: the rebase guard compares what each commit CHANGES, not whether lines of the old branch still exist in the result.
// Method (chosen and stated): per-commit hunk comparison on `-U0` patches, with the commit pairing done by the caller (patch-id first,
// then author identity and subject). For a paired commit whose patch changed in the rebase, every hunk of the OLD commit must be
// found again in the NEW commit (any position, any context), or be a change main already made since the merge base. Both are
// computed from diffs, not guessed:
//   - covered:  the hunk's added and removed lines are consumed from the same file's added and removed lines of the new commit, or of
//               a new commit no old commit pairs with (a change the agent restored in a commit of its own, as the refusal tells it to);
//   - on main:  what is left is consumed from the lines main added or removed between the merge base and the base tip;
//   - folded:   (the longer line is used up) a left-over added line that a longer added line of the new commit contains (both sides edited one line and the
//               resolution joined them; at least 4 characters, so a brace or a short token proves nothing);
//   - merged:   (only in a hunk that also removed a line) a left-over added line whose newly introduced tokens (those not on the old hunk's removed lines) all sit on one added
//               line of the new commit (a list or call both sides edited and the resolution united, issues #580 and #640);
//   - exported: `export { X };` when main or the new commit already exports X by its declaration (PR 1131);
//   - renumbered: a left-over added line whose only difference from a line of the new commit is a number that main's own added
//     lines also use (D-040 became D-042 because main took D-040).
// What remains is a finding: { commit, subject, file, hunk, kind: 'missing' | 'altered', text }.
import { SupervisorError } from './core.mjs';

const MAX_DIFF_LINES = 20000;
const MAX_FINDINGS = 50;
const DIFF = ['-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
const keyOf = l => l.replace(/\s+$/, '');
const blank = l => keyOf(l) === '';

// [{ file, header, removed[], added[] }] of a -U0 diff. A binary file is one hunk whose only added line names its new blob.
export function parseHunks(text) {
  const lines = text.split('\n');
  if (lines.length > MAX_DIFF_LINES) throw new SupervisorError('rebase check: diff too large to compare');
  const out = [];
  let file = null;
  let header = false;
  let blob = null;
  let cur = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      header = true; file = null; cur = null; blob = null;
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
      if (m) file = m[2];
      continue;
    }
    if (header) {
      const idx = /^index [0-9a-f]+\.\.([0-9a-f]+)/.exec(line);
      if (idx) blob = idx[1];
      if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) {
        out.push({ file, header: 'binary', removed: [], added: [`binary ${blob}`] });
        header = false;
      } else if (line.startsWith('@@')) header = false;
      if (header) continue;
    }
    if (line.startsWith('@@')) {
      cur = { file, header: line.replace(/ @@.*$/, ' @@'), removed: [], added: [] };
      out.push(cur);
    } else if (cur && line.startsWith('-')) cur.removed.push(keyOf(line.slice(1)));
    else if (cur && line.startsWith('+')) cur.added.push(keyOf(line.slice(1)));
  }
  return out.filter(h => h.file);
}

const tally = list => {
  const m = new Map();
  for (const l of list) if (!blank(l)) m.set(l, (m.get(l) || 0) + 1);
  return m;
};
const take = (m, l) => {
  const n = m.get(l) || 0;
  if (n <= 0) return false;
  m.set(l, n - 1);
  return true;
};
const sum = m => [...m.values()].reduce((a, b) => a + b, 0);
const mask = l => l.replace(/\d+/g, '#');
const runs = l => l.match(/\d+/g) || [];

// A left-over added line `u` is a renumbering when a line of the new commit differs from it only in numbers, and every number of
// `u` that changed is one main's own added lines use (so the number was taken by main, not changed freely).
function renumberedBy(u, available, mainRuns) {
  const want = mask(u);
  const mine = runs(u);
  for (const [v, n] of available) {
    if (n <= 0 || v === u || mask(v) !== want) continue;
    const theirs = runs(v);
    const changed = mine.filter((r, i) => r !== theirs[i]);
    if (changed.length && changed.every(r => mainRuns.has(r))) return v;
  }
  return null;
}

// A line of at least four characters that another, longer line of the new commit contains whole.
function foldedInto(u, available) {
  const t = u.trim();
  if (t.length < 4 || !/[A-Za-z0-9]/.test(t)) return false;
  for (const [v, n] of available) if (n > 0 && v.length > u.length && v.includes(t)) return take(available, v);
  return false;
}

const words = l => l.match(/[A-Za-z0-9_$]+/g) || [];

// Only for a hunk that also removed a line (an edit, so main could have edited the same line): every token the hunk introduced on `u`
// (absent from its removed lines) is on one other added line of the new commit, which is then used up. A pure addition has no line
// main could have joined, so it is never merged: a dropped line must not hide behind a similar line elsewhere.
function mergedInto(u, removed, available) {
  if (!removed.length) return false;
  const had = new Set(removed.flatMap(words));
  const fresh = words(u).filter(w => !had.has(w));
  if (!fresh.length) return false;
  for (const [v, n] of available) {
    if (n <= 0 || v === u) continue;
    const has = new Set(words(v));
    if (fresh.every(w => has.has(w))) return take(available, v);
  }
  return false;
}

// `export { A, B };` is satisfied when each name is already exported by a declaration in the lines main or the new commit added.
function exportedAlready(u, ...sources) {
  const m = /^export \{\s*([\w$,\s]+?)\s*\};?$/.exec(u.trim());
  if (!m) return false;
  const declared = sources.flatMap(src => [...src.keys()])
    .map(l => /^export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([\w$]+)/.exec(l.trim()))
    .filter(Boolean).map(x => x[1]);
  return m[1].split(/\s*,\s*/).every(n => declared.includes(n));
}

// What main changed in `file` between the merge base and the base tip, as fresh counters (a commit consumes its own copy).
function mainReader(run, mergeBase, base) {
  const cache = new Map();
  return file => {
    if (!cache.has(file)) {
      const hunks = parseHunks(run(['diff', ...DIFF, mergeBase, base, '--', file]));
      cache.set(file, { added: hunks.flatMap(h => h.added), removed: hunks.flatMap(h => h.removed) });
    }
    const c = cache.get(file);
    return { added: tally(c.added), removed: tally(c.removed), runs: new Set(c.added.flatMap(runs)) };
  };
}

function compareCommit(oldHunks, newHunks, readMain, id) {
  const forFile = new Map();
  const fileState = file => {
    if (!forFile.has(file)) forFile.set(file, { added: new Map(), removed: new Map(), main: null });
    return forFile.get(file);
  };
  for (const h of newHunks) {
    const s = fileState(h.file);
    for (const [l, n] of tally(h.added)) s.added.set(l, (s.added.get(l) || 0) + n);
    for (const [l, n] of tally(h.removed)) s.removed.set(l, (s.removed.get(l) || 0) + n);
  }
  const findings = [];
  for (const h of oldHunks) {
    const s = fileState(h.file);
    s.main ||= readMain(h.file);
    const left = [];
    for (const l of h.added.filter(x => !blank(x))) {
      if (!take(s.added, l)) left.push({ l, added: true });
    }
    for (const l of h.removed.filter(x => !blank(x))) {
      if (!take(s.removed, l)) left.push({ l, added: false });
    }
    const missing = left.filter(({ l, added }) => {
      if (take(added ? s.main.added : s.main.removed, l)) return false;   // main made this change itself
      if (!added) return true;
      if (foldedInto(l, s.added) || mergedInto(l, h.removed, s.added)) return false;
      if (exportedAlready(l, s.main.added, s.added)) return false;
      const v = renumberedBy(l, s.added, s.main.runs);
      if (v === null) return true;
      take(s.added, v);
      return false;
    });
    if (!missing.length) continue;
    const first = missing[0];
    findings.push({
      ...id, file: h.file, hunk: h.header, kind: 'missing',
      text: `${first.added ? '+' : '-'} ${first.l}`.slice(0, 200),
    });
  }
  // altered, not missing: the new commit still changes that file with lines no hunk of the old commit accounts for
  return findings.map(f => {
    const s = forFile.get(f.file);
    return sum(s.added) > 0 || sum(s.removed) > 0 ? { ...f, kind: 'altered' } : f;
  });
}

// pairs: [{ old: { sha, subject }, now: { sha } }] whose patches differ; extra: shas of new commits no old commit pairs with. Returns the findings, newest bounded to MAX_FINDINGS.
export function compareChangedPairs(run, { pairs, base, oldHead, extra = [] }) {
  if (!pairs.length) return [];
  const mergeBase = run(['merge-base', base, oldHead]).trim();
  const readMain = mainReader(run, mergeBase, base);
  const show = sha => parseHunks(run(['show', '--format=', ...DIFF, sha]));
  const spare = extra.flatMap(show);
  const out = [];
  for (const { old, now } of pairs) {
    const id = { commit: old.sha, subject: old.subject };
    out.push(...compareCommit(show(old.sha), [...show(now.sha), ...spare], readMain, id));
  }
  return out.slice(0, MAX_FINDINGS);
}

// The shape kept in the job record and shown on the dashboard.
export const slimFinding = c => ({
  file: String(c.file).slice(0, 200),
  kind: c.kind === 'altered' ? 'altered' : 'missing',
  text: String(c.text).slice(0, 200),
  commit: String(c.commit || '').slice(0, 12),
  hunk: String(c.hunk || '').slice(0, 80),
});

// Issue #1422: a finding is "inside a conflict" when replaying the change onto the new base conflicts in that file. The resolution of
// a real conflict has to differ from the old lines, so a text comparison cannot judge it; the review of the new head does, from these
// hunks. Decided by a trial three way merge (the plumbing alreadyApplied uses), never by the agent's word. Anything that cannot be
// read counts as no conflict, so the push is refused as before.
export function conflictedFiles(run, { replayBase, theirs, base }) {
  let out;
  try {
    out = run(['merge-tree', '--write-tree', '--name-only', `--merge-base=${replayBase}`, base, theirs]);
  } catch (e) {
    out = e.stdout;
  }
  if (typeof out !== 'string') return null;
  const [tree, ...rest] = out.split('\n');
  if (!/^[0-9a-f]{40}$/.test(tree)) return null;
  const files = new Set();
  for (const l of rest) {
    if (l === '') break;
    files.add(l);
  }
  return files;
}

// Splits findings into { hard, conflict }. `replayOf(finding)` is { replayBase, theirs, onto }: what the change is replayed from, what
// carries it, and what it is replayed onto (the rebased predecessor, so only a conflict with the base's own changes counts).
export function splitByConflict(run, findings, replayOf) {
  const cache = new Map();
  const hard = [];
  const conflict = [];
  for (const f of findings) {
    const { replayBase, theirs, onto } = replayOf(f);
    const key = `${replayBase}..${theirs}..${onto}`;
    if (!cache.has(key)) cache.set(key, conflictedFiles(run, { replayBase, theirs, base: onto }));
    (cache.get(key)?.has(f.file) ? conflict : hard).push(f);
  }
  return { hard, conflict };
}

// A branch that holds a merge commit of its base: the files that merge touched, and the merge base the branch's total change starts at.
export function mergeTouched(run, base, oldHead) {
  const merges = run(['rev-list', '--merges', `${base}..${oldHead}`]).split('\n').filter(Boolean);
  if (!merges.length) return null;
  const files = new Set();
  for (const m of merges) {
    for (const f of run(['diff', '--name-only', '--no-renames', `${m}^1`, m]).split('\n').filter(Boolean)) files.add(f);
  }
  return { files, mergeBase: run(['merge-base', base, oldHead]).trim() };
}

// Total change (old merge base to old head, against new base to new head) for the files a merge commit touched, compared like one commit.
function compareTotalChange(run, { base, oldHead, newHead, touched }) {
  const files = [...touched.files];
  const old = parseHunks(run(['diff', ...DIFF, touched.mergeBase, oldHead, '--', ...files]));
  const now = parseHunks(run(['diff', ...DIFF, base, newHead, '--', ...files]));
  const id = { commit: oldHead, subject: 'merge of the base: total change', total: true };
  return compareCommit(old, now, mainReader(run, touched.mergeBase, base), id);
}

// The findings of a rebase as { lostChanges, conflictHunks }: the hard ones refuse the push, the conflict ones go to the reviewer.
export function classifyChanges(run, { pairs, base, oldHead, newHead, extra = [] }) {
  let findings = compareChangedPairs(run, { pairs, base, oldHead, extra });
  const touched = mergeTouched(run, base, oldHead);
  if (touched) {
    findings = [...findings.filter(f => !touched.files.has(f.file)), ...compareTotalChange(run, { base, oldHead, newHead, touched })];
  }
  // A later commit that edits lines an earlier PR commit added would conflict with the bare base only because the base lacks that
  // earlier commit. So each commit is replayed onto its paired new commit's parent, the rebased predecessor.
  const parentOf = new Map(pairs.map(p => [p.old.sha, `${p.now.sha}^`]));
  const replayOf = f => (f.total
    ? { replayBase: touched.mergeBase, theirs: oldHead, onto: base }
    : { replayBase: `${f.commit}^`, theirs: f.commit, onto: parentOf.get(f.commit) || base });
  const { hard, conflict } = splitByConflict(run, findings, replayOf);
  const clean = ({ total, ...rest }) => rest;
  return { lostChanges: hard.map(clean), conflictHunks: conflict.map(clean) };
}
