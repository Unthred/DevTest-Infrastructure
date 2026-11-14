// Issue #1440: the claims in a pull request description that a script can test against the diff, before any review is spent.
// Pure: plain text in, problems out, each { row, cite, reason } like the cite problems so one message reaches the author.
export const FILE_EXT = 'mjs|js|json|md|sh|cs|razor|yml|yaml|txt|css|html|csproj';

const FILE_NAME = new RegExp(`[\\w@][\\w.@/-]*\\.(?:${FILE_EXT})\\b`, 'g');
const HEADING = name => new RegExp(`^#{1,6}\\s+${name}\\s*:?\\s*$`, 'i');
const UNCHANGED = /\b(?:unchanged|untouched|not\s+(?:been\s+)?(?:changed|modified|touched|edited)|left\s+alone)\b/i;

// The lines under a heading, up to the next heading; null when the heading is absent.
function sectionLines(text, name) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex(line => HEADING(name).test(line.trim()));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(line => /^#{1,6}\s+/.test(line.trim()));
  return end < 0 ? rest : rest.slice(0, end);
}

const firstFile = line => { FILE_NAME.lastIndex = 0; return FILE_NAME.exec(line)?.[0] ?? null; };

// Paths in the issue's "Files this item edits" list; null when the issue has no such heading (then nothing is tested).
export function issueFileList(issueBody) {
  const lines = sectionLines(issueBody, 'Files this item edits');
  if (!lines) return null;
  return lines.map(line => firstFile(line.replace(/`/g, ''))).filter(Boolean);
}

// Entries under "Files beyond the item" as { path, reason }; the reason is what follows the path.
export function declaredBeyond(body) {
  const lines = sectionLines(body, 'Files beyond the item') || [];
  const entries = [];
  for (const raw of lines) {
    const line = raw.replace(/`/g, '');
    const path = firstFile(line);
    if (!path) continue;
    const reason = line.slice(line.indexOf(path) + path.length).replace(/[|\s:.,;—–-]+/g, ' ').trim();
    entries.push({ path, reason });
  }
  return entries;
}

const NOT_DECLARED = 'is changed but is neither in the issue "Files this item edits" '
  + 'nor named with a reason under a heading "Files beyond the item" in the description';
const listed = (path, paths) => paths.some(entry => entry === path || (entry.endsWith('/') && path.startsWith(entry)));

export function beyondItemProblems({ body, diffFiles, issueBody }) {
  const issueFiles = issueFileList(issueBody);
  if (!issueFiles) return [];
  const row = 'Files beyond the item';
  const declared = declaredBeyond(body);
  const noReason = 'is listed under Files beyond the item without a reason';
  const out = declared.filter(entry => !entry.reason).map(entry => ({ row, cite: entry.path, reason: noReason }));
  const known = [...issueFiles, ...declared.map(entry => entry.path)];
  for (const path of diffFiles.keys()) {
    if (!listed(path, known)) out.push({ row, cite: path, reason: NOT_DECLARED });
  }
  return out;
}

// Quoted text (a test name, a phrase) is not a claim; a backticked file name stays.
const withoutQuoted = clause => clause.replace(/"[^"]*"/g, ' ').replace(/`([^`]*)`/g, (all, inner) => (/\s/.test(inner) ? ' ' : inner));

// The files an unchanged word is about: the file named nearest before it, plus files joined to it by "and" or a comma.
function claimSubjects(clause) {
  const word = UNCHANGED.exec(clause);
  const before = clause.slice(0, word.index);
  const names = [...before.matchAll(new RegExp(FILE_NAME.source, 'g'))];
  if (!names.length) return clause.slice(word.index).match(FILE_NAME)?.slice(0, 1) || [];
  const subjects = [names.at(-1)[0]];
  for (let i = names.length - 2; i >= 0; i--) {
    const between = before.slice(names[i].index + names[i][0].length, names[i + 1].index);
    if (!/^[\s,&]*(?:(?:and|or)[\s,&]*)?$/i.test(between)) break;
    subjects.push(names[i][0]);
  }
  return subjects;
}

// "team.mjs is unchanged": the clause says a named file is unchanged. Clauses split at sentence ends, semicolons, table cells and "but".
export function unchangedClaimProblems({ body, diffFiles }) {
  const out = [];
  const changed = [...diffFiles.keys()];
  for (const line of String(body || '').split('\n')) {
    for (const raw of line.split(/\.\s+|;|\||\bbut\b/i)) {
      const clause = withoutQuoted(raw);
      if (!UNCHANGED.test(clause)) continue;
      for (const name of claimSubjects(clause)) {
        const path = changed.find(file => file === name || file.endsWith('/' + name));
        if (path) out.push({ row: 'description', cite: raw.trim().slice(0, 80), reason: 'says ' + name + ' is unchanged but the diff changes ' + path });
      }
    }
  }
  return out;
}

const TOTAL_REASON = 'states a measured total (test, pass, fail, check-size warning, or diff file or line count) that moves as main moves: '
  + 'remove the figure and state only the outcome, for example that the suite passed with no failure';
const NUM = '\\d[\\d,]*';
const MEASURED_TOTALS = [
  new RegExp(`\\b(?:tests|pass|passed|fail|failed|cancelled|skipped)\\s*[:=]?\\s*${NUM}\\b`, 'i'),
  new RegExp(`(?<!\\b(?:add|adds|added)\\s)\\b${NUM}\\s+(?:tests?|passing|failing|passed|failed)\\b(?!\\s+(?:added|created))`, 'i'),
  new RegExp(`\\b${NUM}\\s*/\\s*${NUM}\\s+(?:tests?|pass)`, 'i'),
  new RegExp(`\\bwarnings?(?:\\(s\\))?(?:\\s+(?:count|total))?\\s*(?:of|is|was|to|from|:|=)?\\s*${NUM}\\b`, 'i'),
  new RegExp(`\\b${NUM}\\s+(?:check-size\\s+)?warning`, 'i'),
  new RegExp(`\\b${NUM}\\s+files?\\s+(?:changed|touched|modified|edited)`, 'i'),
  new RegExp(`\\b${NUM}\\s+(?:lines?\\s+(?:added|removed|changed|deleted|in\\s+the\\s+diff)|insertions?|deletions?)`, 'i'),
  new RegExp(`\\b(?:changes|touches|modifies|edits|holds|has|contains)\\s+${NUM}\\s+(?:files?|lines?)\\b`, 'i'),
  new RegExp(`\\bdiff\\b[^.\\n]{0,40}\\b${NUM}\\s+(?:files?|lines?)\\b`, 'i')
];

// Totals that tools print and that move as main moves: the author keeps the outcome and drops the figure.
export function measuredTotalProblems({ body }) {
  const out = [];
  for (const line of String(body || '').split('\n')) {
    const text = line.replace(/`?[\w@./-]+\.(?:mjs|js|json|md|cs|txt):\d+(?:-\d+)?`?/g, ' ');
    if (MEASURED_TOTALS.some(pattern => pattern.test(text))) {
      out.push({ row: 'description', cite: line.trim().slice(0, 80), reason: TOTAL_REASON });
    }
  }
  return out;
}

export const descriptionClaimProblems = args => [...beyondItemProblems(args), ...unchangedClaimProblems(args), ...measuredTotalProblems(args)];
