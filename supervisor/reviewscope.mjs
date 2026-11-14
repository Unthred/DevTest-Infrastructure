// Issue #1419: what a fix round review is given beyond the earlier blocking findings, and the check that keeps its carried rows honest.
// Pure functions of their inputs; team.mjs reads git and the files and carries the result out.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const RECHECK = 'recheck';
export const CARRIED = 'carried';
const FILE_TOKEN = /[\w./-]+\.(?:mjs|cjs|js|json|md|cs|razor|yml|yaml|sh|txt|html|css|toml)\b/gi;
const norm = s => String(s).toLowerCase();

// The files an evidence text names, as written (lower-cased).
export const filesNamedIn = evidence => (String(evidence).match(FILE_TOKEN) || []).map(norm);

// A cited name matches a changed file when it is the full path, or the same trailing path or bare name (over-rechecking is the safe error).
function namesChanged(evidence, changed) {
  const base = f => f.split('/').pop();
  return filesNamedIn(evidence).some(cited => changed.some(f => {
    const c = norm(f);
    return c === cited || c.endsWith(`/${cited}`) || (!cited.includes('/') && base(c) === cited);
  }));
}

// A row is recheck when it was not met, or its evidence names a file that differs between the two heads, or its evidence names no file.
export function markRow(row, changedFiles) {
  const named = filesNamedIn(row.evidence).length > 0;
  const recheck = row.status !== 'met' || !named || namesChanged(row.evidence, changedFiles);
  return { requirement: row.requirement, status: row.status, evidence: row.evidence, mark: recheck ? RECHECK : CARRIED };
}

export const markRows = (rows, changedFiles) => (Array.isArray(rows) ? rows : []).map(r => markRow(r, changedFiles));

export function countMarks(rows) {
  const carried = rows.filter(r => r.mark === CARRIED).length;
  return { carried, rechecked: rows.length - carried };
}

// The scope file of a fix round review. With no earlier rows (or no way to list the changed files) it is the scope file of today.
export function buildScope({ blocking, reviewedHead, newHead, changedFiles, rows }) {
  if (!Array.isArray(changedFiles) || !Array.isArray(rows) || rows.length === 0) return { blocking };
  return { blocking, reviewedHead, newHead, changedFiles, requirements: markRows(rows, changedFiles) };
}

export const carriedRowsOf = scope => (Array.isArray(scope?.requirements) ? scope.requirements.filter(r => r.mark === CARRIED) : []);

// Reads the carried rows from a review's own inbox; none when the file is absent or has no marked rows.
export function readCarried(inboxDir) {
  try { return carriedRowsOf(JSON.parse(fs.readFileSync(path.join(inboxDir, 'review-scope.json'), 'utf8'))); }
  catch { return []; }
}

const withoutCarriedNote = e => String(e).replace(/[\s.(]*carried from the earlier head \w*\)?\.?\s*$/i, '').trim();

// The verdict check: every carried row appears with its earlier status. A reviewer that finds a carried row no longer true marks it not-met
// with new evidence (and a blocking finding, which the existing PASS rule then requires); that row counts as rechecked.
export function carriedRowError(verdict, carried) {
  if (!carried?.length) return null;
  const now = new Map((verdict.requirements || []).map(r => [r.requirement, r]));
  for (const c of carried) {
    const r = now.get(c.requirement);
    if (!r) return `a carried requirement row is missing from the verdict: ${c.requirement.slice(0, 80)}; copy it with its earlier status and evidence`;
    if (r.status === c.status) continue;
    if (r.status === 'not-met' && withoutCarriedNote(r.evidence) !== withoutCarriedNote(c.evidence)) continue;
    return `a carried requirement row changed status without new evidence: ${c.requirement.slice(0, 80)}; `
      + 'copy it unchanged, or mark it not-met with new evidence and report a blocking finding';
  }
  return null;
}

const PROMPT = fs.readFileSync(new URL('./fix-round-review-prompt.txt', import.meta.url), 'utf8').trim();
export function fixRoundInstruction(round) {
  const values = { ...round, shortHead: round.reviewedHead.slice(0, 12) };
  return PROMPT.replace(/\{(\w+)\}/g, (_, key) => String(values[key]));
}

// The default way to list the files that differ between two heads; null when git cannot tell.
const gitChangedFiles = repoPath => async (a, b) => {
  spawnSync('git', ['-C', repoPath, 'fetch', '--quiet', 'origin'], { encoding: 'utf8', timeout: 60000 });
  const r = spawnSync('git', ['-C', repoPath, 'diff', '--name-only', a, b], { encoding: 'utf8', timeout: 60000 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
};

// Writes review-scope.json for a fix round review and returns what the prompt and the job record need.
// `git.changedFiles(a, b)` lists the files that differ between two heads, or null when it cannot be told; then the scope is today's.
export async function writeFixRoundScope({ inbox, git, repoPath, previous, reviewedHead, newHead, withRequirements }) {
  const blocking = previous.findings.filter(f => f.kind === 'blocking');
  const changedFiles = withRequirements && previous.requirements?.length ? await (git.changedFiles ?? gitChangedFiles(repoPath))(reviewedHead, newHead) : null;
  const scope = buildScope({ blocking, reviewedHead, newHead, changedFiles, rows: previous.requirements });
  fs.writeFileSync(path.join(inbox, 'review-scope.json'), JSON.stringify(scope) + '\n', { mode: 0o600 });
  return scope.requirements ? { inbox, reviewedHead, newHead, ...countMarks(scope.requirements) } : true;
}

// What the review job record says: a fix round review, and how many rows were carried and how many rechecked.
export function fixRoundMeta(previous, round) {
  if (!previous) return {};
  return round?.newHead ? { fixRoundReview: true, rowsCarried: round.carried, rowsRechecked: round.rechecked } : { fixRoundReview: true };
}
