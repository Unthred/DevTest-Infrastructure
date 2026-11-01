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

// Hunks of a raw diff as [{ file, start, count }] on the old (base) side, in order. Null (fail closed) when a
// header does not parse (git quotes names with a tab, quote or backslash) or a hunk has no known file.
export function parseHunks(text) {
  const out = []; let file = null;
  for (const l of text.split('\n')) {
    const f = /^diff --git a\/(.*) b\/(.*)$/.exec(l);
    if (f) { file = f[2]; continue; }
    if (l.startsWith('diff --git ')) return null;
    const h = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(l);
    if (h && file === null) return null;
    if (h) out.push({ file, start: Number(h[1]), count: h[2] === undefined ? 1 : Number(h[2]) });
  }
  return out;
}

// Lines a hunk's base-side region moved because of upstream changes, or null if upstream touched the region.
function upstreamShift(upstream, { start, count }) {
  const last = start + count - 1; let shift = 0;
  for (const u of upstream) {
    if (u.count === 0) { // insertion after line u.start
      if (u.start >= start && u.start < last) return null;
      if (u.start < start) shift += u.added;
    } else {
      const uLast = u.start + u.count - 1;
      if (u.start <= last && uLast >= start) return null;
      if (uLast < start) shift += u.added - u.count;
    }
  }
  return shift;
}

function samePlacement(run, base, oldHead, newHead) {
  const mb = head => run(['merge-base', base, head]).trim();
  const oldMb = mb(oldHead), newMb = mb(newHead);
  const hunks = head => parseHunks(run(['-c', 'core.quotePath=false', 'diff', ...DIFF_FLAGS, `${base}...${head}`]));
  const oh = hunks(oldHead), nh = hunks(newHead);
  if (oh === null || nh === null) return false; // unparseable header: fail closed
  if (oh.length !== nh.length) return false;
  const cache = new Map();
  const upstream = file => {
    if (!cache.has(file)) {
      const list = [];
      for (const l of run(['diff', '-U0', ...DIFF_FLAGS, oldMb, newMb, '--', file]).split('\n')) {
        const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
        if (m) list.push({ start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]), added: m[3] === undefined ? 1 : Number(m[3]) });
      }
      cache.set(file, list);
    }
    return cache.get(file);
  };
  return oh.every((h, i) => {
    const n = nh[i];
    if (h.file !== n.file || h.count !== n.count) return false;
    if (h.start === 0 || h.count === 0) return h.start === n.start; // file added: no base-side placement
    const shift = upstreamShift(upstream(h.file), h);
    return shift !== null && n.start === h.start + shift;
  });
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
  // A hunk may only have moved by the lines upstream added or removed above it; with line numbers dropped from the
  // text comparison, repeated context could otherwise let a rebase place the same hunk elsewhere and still compare equal.
  if (!samePlacement(run, base, oldHead, newHead)) return false;
  const side = head => run(['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter(Boolean)
    .map(c => `${normalisePatch(run(['show', '--format=', ...DIFF_FLAGS, c]))}\n\0${run(['log', '-1', '--format=%B', c])}`);
  const a = side(oldHead), b = side(newHead);
  return a.length > 0 && a.length === b.length && a.every((x, i) => x === b[i]);
}
