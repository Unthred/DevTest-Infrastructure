// Issue #1227: the files an item expects to edit. One standing line, `Files: a/b.mjs, c.md`, defines them alone; without it the paths
// named in the prose are the fallback, minus those that appear only in a sentence that tells the agent to stay away from them.
// Pure: no I/O.
import { pullOverlapText } from './overlaptext.mjs';
export const MAX_FILES = 8;
const FILES_LINE = /^[ \t]*Files:[ \t]*(.*?)[ \t]*$/gim;
const PATH_SHAPE = /^[\w.@+-]+(?:\/[\w.@+-]+)*$/;
const AVOID_WORD = /\b(?:avoid|not|never|except)\b/i;

const normalise = p => p.replace(/^\.\//, '');

// { lines: the Files lines found (their text after the label) }
function filesLines(body) {
  return [...String(body || '').matchAll(FILES_LINE)].map(m => m[1]);
}

// { present, paths } for a body. present is true when a Files line exists, even an empty one.
export function parseFilesLine(body) {
  const lines = filesLines(body);
  if (!lines.length) return { present: false, paths: [] };
  const paths = lines[0].split(',').map(s => s.trim()).filter(Boolean).map(normalise);
  return { present: true, paths };
}

// Draft check: null when the body is acceptable, else the reason it is refused.
export function filesLineRefusal(body) {
  const lines = filesLines(body);
  if (!lines.length) return null;
  if (lines.length > 1) return 'a draft has at most one Files: line';
  const paths = lines[0].split(',').map(s => s.trim());
  if (paths.some(p => !p)) return 'the Files: line must be a comma separated list of paths, with no empty entry';
  if (paths.length > MAX_FILES) return `the Files: line names ${paths.length} paths; at most ${MAX_FILES} are allowed`;
  const glob = paths.find(p => /[*?[\]{}]/.test(p));
  if (glob) return `the Files: line takes paths only, not a glob (${glob.slice(0, 60)})`;
  const bad = paths.find(p => !PATH_SHAPE.test(p) || p.startsWith('/') || p.split('/').includes('..'));
  if (bad) return `the Files: line takes repository paths only (${bad.slice(0, 60)})`;
  return null;
}

const PROSE_PATH = /(?<![\w./-])(?:[\w.-]+\/)+[\w.-]*\w(?![\w/])|(?<![\w./-])[\w-]+\.(?:mjs|js|json|md|yml|yaml|cs|sh|html|css)\b/g;
const pathsIn = text => (text.match(PROSE_PATH) || []).filter(f => /\.\w+$/.test(f)).map(normalise);
const sentencesOf = text => text.split(/(?<=[.!?])\s+|\n/);

// The paths an issue is expected to edit: the Files line when present, else the prose reading without the avoid sentences.
export function expectedFiles(issue) {
  const body = issue?.body || '';
  const line = parseFilesLine(body);
  if (line.present) return new Set(line.paths);
  const wanted = sentencesOf(`${issue?.title || ''}\n${body}`).filter(s => !AVOID_WORD.test(s));
  return new Set(wanted.flatMap(pathsIn));
}

// Requirement 5: the pull requests whose changed files exceed their item's Files line by more than `allowed` files.
// prs: open pull requests; filesOf(pr) -> array of paths or null; issueOfPr(pr) -> the item (issue object) or null.
export function filesDrift({ prs, filesOf, issueOfPr, allowed = 2 }) {
  const out = [];
  for (const pr of prs) {
    const issue = issueOfPr(pr);
    const line = parseFilesLine(issue?.body);
    const changed = filesOf(pr);
    if (!line.present || !Array.isArray(changed)) continue;
    const listed = new Set(line.paths);
    const extra = changed.map(normalise).filter(f => !listed.has(f));
    if (extra.length > allowed) out.push({ pr: pr.number, issue: issue.number, extra });
  }
  return out;
}

export function filesDriftText({ pr, issue, extra }) {
  const shown = extra.slice(0, 10).join(', ') + (extra.length > 10 ? `, and ${extra.length - 10} more` : '');
  return `PR #${pr} changes ${extra.length} files that the Files: line of issue #${issue} does not list: ${shown}`;
}

// Does the predicted name `want` (a repository path, or a bare file name from prose) name the changed repository path `path`?
const namesPath = (want, path) => path === want || path.endsWith(`/${want}`);

// Requirement 3: the hold text when an open pull request of another item edits one of `mine`, else null.
// prs: the pull requests of the view; filesOf(pr) -> array of paths or null; itemOf(pr) -> the issue number of the pull request.
export function openPullOverlap({ mine, item, type, prs, filesOf, itemOf }) {
  for (const open of prs) {
    const changed = filesOf(open);
    if (itemOf(open) === item || !Array.isArray(changed) || ['MERGED', 'CLOSED'].includes(String(open.state || '').toUpperCase())) continue;
    const file = [...mine].find(want => changed.some(c => namesPath(want, c)));
    if (file) return pullOverlapText({ type, issue: item, file, pr: open.number });
  }
  return null;
}

// Requirement 5: the Needs you items (action severity) for the pull requests that drifted from their item's Files line.
export function filesDriftItems({ issues, itemOf, ...rest }) {
  const byNo = new Map(issues.map(i => [i.number, i]));
  return filesDrift({ ...rest, issueOfPr: pr => byNo.get(itemOf(pr)) }).map(d => ({ id: `files-drift-${d.pr}`, text: filesDriftText(d), ref: { kind: 'pull', n: d.pr }, severity: 'action',
    action: `Correct the Files: line of issue #${d.issue} (or move the extra files to their own item) so the next item is planned from the real file list.` }));
}
