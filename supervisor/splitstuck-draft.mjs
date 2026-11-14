// A planned split is untrusted model output. This module only checks and shapes data; tick wiring reads and files it elsewhere.
import { dependencyRefusal, parseDependsOn } from './dependencies.mjs';
import { redact } from './redact.mjs';

export const STUCK_MIN = 2;
export const STUCK_MAX = 4;
export const DRAFT_FILE = 'split-stuck-draft.json';

const TAGS = ['before PR', 'after install'];
const LIMITS = { title: 120, scope: 300, text: 300, file: 200, files: 12, acceptance: 12, tests: 8 };
const FILE_PATH = /^[A-Za-z0-9_./@-]+$/;
const PREREQUISITE = '{{PREREQUISITE}}';

const oneLine = (value, maximum) => typeof value === 'string' && value.trim() !== '' && value.length <= maximum && !/[\r\n]/.test(value);
const safeFile = file => {
  if (typeof file !== 'string' || file.length > LIMITS.file) return false;
  if (!FILE_PATH.test(file) || file.startsWith('/')) return false;
  return !file.split('/').includes('..');
};

// The item position is the only authority for a prerequisite: a later item cannot form a cycle or wait on itself.
export function itemFault(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return 'is not an object';
  if (!oneLine(item.title, LIMITS.title)) return 'needs a one-line title';
  if (!oneLine(item.scope, LIMITS.scope)) return 'needs a one-line scope';
  const filesValid = Array.isArray(item.files)
    && item.files.length > 0
    && item.files.length <= LIMITS.files
    && item.files.every(safeFile);
  if (!filesValid) return 'must name the files it edits (relative paths, at most 12)';
  const acceptanceValid = Array.isArray(item.acceptance)
    && item.acceptance.length > 0
    && item.acceptance.length <= LIMITS.acceptance
    && item.acceptance.every(row => row && TAGS.includes(row.tag) && oneLine(row.text, LIMITS.text));
  if (!acceptanceValid) return 'needs an acceptance list whose lines are tagged "before PR" or "after install"';
  if (!item.acceptance.some(row => row.tag === 'before PR')) return 'needs at least one "before PR" acceptance line';
  const testsValid = Array.isArray(item.tests)
    && item.tests.length > 0
    && item.tests.length <= LIMITS.tests
    && item.tests.every(value => oneLine(value, LIMITS.text));
  if (!testsValid) return 'must name its tests';
  const prerequisiteValid = item.prerequisite == null
    || (Number.isInteger(item.prerequisite) && item.prerequisite >= 1 && item.prerequisite <= index);
  if (!prerequisiteValid) return 'names a prerequisite that is not an earlier item';
  return null;
}

function openFileLists(context) {
  const lists = context?.openPullRequestFiles;
  if (lists instanceof Map) return lists;
  return new Map(Object.entries(lists || {}));
}

// Context is the parked PR plus every open PR's files. Its own entry is ignored: only another PR can make this draft conflict.
export function checkStuckDraft(raw, context = {}) {
  const items = raw?.items;
  if (!Array.isArray(items) || items.length < STUCK_MIN || items.length > STUCK_MAX) {
    const found = Array.isArray(items) ? items.length : 0;
    return { error: `${DRAFT_FILE} found ${found} items; needs ${STUCK_MIN} to ${STUCK_MAX} items` };
  }
  for (const [index, item] of items.entries()) {
    const fault = itemFault(item, index);
    if (fault) return { error: `item ${index + 1} ${fault}` };
  }
  const currentPr = Number(context?.pullRequest?.number);
  for (const [index, item] of items.entries()) {
    for (const [number, files] of openFileLists(context)) {
      if (Number(number) === currentPr || !Array.isArray(files)) continue;
      const shared = item.files.find(file => files.includes(file));
      if (shared) {
        return { error: `item ${index + 1} edits ${shared}, which open PR #${number} also changes; an item may share no file with another open PR` };
      }
    }
  }
  return {
    items: items.map(item => ({
      title: redact(item.title.trim(), LIMITS.title),
      scope: redact(item.scope.trim(), LIMITS.scope),
      files: item.files,
      acceptance: item.acceptance.map(row => ({ tag: row.tag, text: redact(row.text.trim(), LIMITS.text) })),
      tests: item.tests.map(value => redact(value.trim(), LIMITS.text)),
      prerequisite: item.prerequisite ?? null
    }))
  };
}

// A prerequisite is a placeholder because its earlier child issue number is known only while filing.
export function itemBody({ item, index, count, parent, source }) {
  const lines = [
    `Part ${index + 1} of ${count} of the split of parked PR #${parent}${source ? ` (source issue #${source})` : ''}, approved by the homeowner.`,
    '',
    `**Scope:** ${item.scope}`,
    '',
    `Files: ${item.files.join(', ')}`
  ];
  if (item.prerequisite) lines.push('', `Depends on: ${PREREQUISITE}`);
  lines.push('', '## Acceptance', ...item.acceptance.map(row => `- ${row.tag}: ${row.text}`), '', '## Tests', ...item.tests.map(value => `- ${value}`));
  return lines.join('\n');
}

export const withPrerequisite = (body, number) => body.replace(PREREQUISITE, `#${number}`);

// Parser wording is returned verbatim so the eventual filing path can show the actionable dependency refusal.
export function bodyFault(body) {
  const parsed = parseDependsOn(withPrerequisite(body, 1));
  return parsed.malformed ? dependencyRefusal(parsed) : null;
}
