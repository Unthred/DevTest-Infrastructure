// Issue #1188: checks the Evidence column of the PR "Requirements check" table against the PR itself.
// Plain data in, plain data out: the caller reads the diff, the files at the PR head and the issue text; nothing here calls GitHub.
import { requirementsRows } from './requirements-table-rows.mjs';
import { expectedRowProblems } from './requirements-issue-items.mjs';

const EXT = 'mjs|js|json|md|sh|cs|razor|yml|yaml|txt|css|html|csproj';
const PATH_CITE = new RegExp(`(?<![\\w./@{}-])((?:[\\w@-][\\w.@-]*/)+[\\w.@-]+\\.(?:${EXT}))(?![\\w/{}])((?::\\d+(?:-\\d+)?)*)`, 'g');
const BARE_LINE = /^:(\d+)(?:-(\d+))?/;
const TEST_FILE = /^tests\/.+\.test\.mjs$/;
const COMMAND_START = /^(?:node|npm|npx|gh|git|dev-test|bash|sh|curl|\/root\/bin\/\S+)\b/;
const ALLOWED_COMMAND = /^(?:node --test\b|node tools\/\S+\.mjs\b|dev-test\b|\/root\/bin\/ai-supervisor test-slot run\b)/;
const TEST_NAME = /\btests?\s+(?:named\s+)?(?:`([^`]{3,})`|"([^"]{3,})"|'([^']{3,})')/gi;

export const MAX_CITED_FILES = 40;

export function parseDiff(diff) {
  const files = new Map();
  let current = null;
  for (const line of String(diff || '').split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) { current = { path: header[2], added: false, ranges: [] }; files.set(current.path, current); continue; }
    if (!current) continue;
    if (line.startsWith('new file mode')) { current.added = true; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const length = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (length > 0) current.ranges.push([start, start + length - 1]);
  }
  return files;
}

// Every file path the table cites, so the caller can fetch those files at the PR head.
export function citedPaths(body) {
  const paths = new Set();
  for (const row of requirementsRows(body)) for (const cite of parseCites(row.evidence)) paths.add(cite.path);
  return [...paths].slice(0, MAX_CITED_FILES);
}

export function parseCites(evidence) {
  const cites = [];
  const text = String(evidence || '');
  PATH_CITE.lastIndex = 0;
  let match;
  while ((match = PATH_CITE.exec(text))) {
    const lines = [...match[2].matchAll(/:(\d+)(?:-(\d+))?/g)].map(m => [Number(m[1]), Number(m[2] || m[1])]);
    // "`file.mjs:18`, `:28`": a bare line number continues the file just before it.
    let tail = text.slice(match.index + match[0].length);
    let more;
    while ((more = /^[`'")\s,(]*:(\d+)(?:-(\d+))?/.exec(tail))) {
      lines.push([Number(more[1]), Number(more[2] || more[1])]);
      tail = tail.slice(more[0].length);
    }
    cites.push({ path: match[1], lines, text: match[0] });
  }
  return cites;
}

const commandsIn = evidence => {
  const spans = [...String(evidence).matchAll(/`([^`]+)`/g)].map(m => m[1].trim());
  return spans.filter(span => COMMAND_START.test(span));
};

const testNamesIn = evidence => [...String(evidence).matchAll(TEST_NAME)].map(m => m[1] || m[2] || m[3]);

const inRanges = (ranges, from, to) => ranges.some(([a, b]) => from >= a && to <= b);

function fileProblems(cite, diffFiles, headFiles) {
  const text = headFiles.get(cite.path);
  if (text === null || text === undefined) return [`${cite.path} does not exist in the pull request head`];
  const changed = diffFiles.get(cite.path);
  const problems = [];
  for (const [from, to] of cite.lines) {
    const total = text.split('\n').length;
    if (to > total) { problems.push(`${cite.path}:${from} is past the end of the file (${total} lines)`); continue; }
    if (TEST_FILE.test(cite.path)) continue;
    if (!changed || !inRanges(changed.ranges, from, to)) problems.push(`${cite.path}:${from} is outside every hunk this pull request changes`);
  }
  return problems;
}

function rowProblems(row, diffFiles, headFiles) {
  const out = [];
  const cites = parseCites(row.evidence);
  for (const cite of cites) for (const reason of fileProblems(cite, diffFiles, headFiles)) out.push({ row: row.requirement, cite: cite.text, reason });
  for (const command of commandsIn(row.evidence)) {
    if (!ALLOWED_COMMAND.test(command)) out.push({ row: row.requirement, cite: command, reason: 'not an allowed verification command (node --test, node tools/*.mjs, dev-test, ai-supervisor test-slot run)' });
  }
  const testTexts = cites.filter(c => TEST_FILE.test(c.path)).map(c => headFiles.get(c.path) || '');
  for (const name of testNamesIn(row.evidence)) {
    if (!testTexts.length) continue;
    if (!testTexts.some(content => content.includes(name))) out.push({ row: row.requirement, cite: name, reason: 'named test does not appear in the cited test file' });
  }
  return out;
}

const WORDS = '\\d+|one|two|three|four|five|six|seven|eight|nine|ten';
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const COUNT_CLAIMS = [
  new RegExp(`\\b(${WORDS})\\s+new\\s+(?:[\\w.-]+\\s+)?(files|modules|tests)\\b`, 'gi'),
  new RegExp(`\\b(${WORDS})\\s+(files|modules|tests)\\s+(?:added|created)\\b`, 'gi')
];

// Counts the diff can answer: new files, new modules (new .mjs outside tests/) and new tests (added test( or it( lines).
export function diffCounts(diff, diffFiles) {
  const added = [...diffFiles.values()].filter(f => f.added).map(f => f.path);
  const newTests = (String(diff).match(/^\+\s*(?:test|it)\(/gm) || []).length;
  return { files: added.length, modules: added.filter(p => p.endsWith('.mjs') && !p.startsWith('tests/')).length, tests: newTests };
}

function countProblems(row, counts) {
  const out = [];
  const claimText = `${row.requirement} ${row.evidence}`.replace(/`[^`]*`/g, ' ');
  for (const pattern of COUNT_CLAIMS) {
    for (const match of claimText.matchAll(pattern)) {
      const stated = NUMBER_WORDS[match[1].toLowerCase()] ?? Number(match[1]);
      const kind = match[2].toLowerCase();
      if (stated !== counts[kind]) out.push({ row: row.requirement, cite: match[0], reason: `states ${stated} ${kind} but the diff has ${counts[kind]}` });
    }
  }
  return out;
}

// Returns { problems: [{ row, cite, reason }] }. `headFiles` maps a cited path to its text at the PR head (null when absent).
export function requirementsCiteProblems({ body, diff, headFiles, issueBody }) {
  const diffFiles = parseDiff(diff);
  const rows = requirementsRows(body);
  const counts = diffCounts(diff, diffFiles);
  const problems = [];
  for (const row of rows) {
    problems.push(...rowProblems(row, diffFiles, headFiles));
    problems.push(...countProblems(row, counts));
  }
  problems.push(...expectedRowProblems(rows, issueBody));
  return problems;
}

// One list for the author: row, cite, reason.
export function citeProblemsMessage(problems) {
  const lines = problems.slice(0, 12).map(p => `row "${String(p.row).slice(0, 80)}": ${String(p.cite).slice(0, 80)}: ${p.reason}`);
  const more = problems.length > 12 ? ` (and ${problems.length - 12} more)` : '';
  return `requirements table cites do not match the pull request${more}: ${lines.join(' | ')}`;
}
