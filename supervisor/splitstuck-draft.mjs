// Issue #1240: the draft of a split of a stuck pull request. Pure: reading the draft file, the checks on it and the body of each filed item.
// A draft is task data from a model, so it is shape-checked, bounded and redacted before it is shown or becomes an issue.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';
import { parseDependsOn, dependencyRefusal } from './dependencies.mjs';

export const STUCK_MIN = 2;
export const STUCK_MAX = 4;
export const TAGS = ['before PR', 'after install'];
const LIMITS = { title: 120, scope: 300, text: 300, file: 200, files: 12, acceptance: 12, tests: 8 };
const FILE_PATH = /^[A-Za-z0-9_./@-]+$/;
const PLACEHOLDER = '{{PREREQUISITE}}';
export const DRAFT_FILE = 'split-stuck-draft.json';

const oneLine = (v, max) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\r\n]/.test(v);
const safeFile = f => typeof f === 'string' && f.length <= LIMITS.file && FILE_PATH.test(f) && !f.split('/').includes('..') && !f.startsWith('/');

// Why one item is malformed, or null. `index` is the zero-based position; a prerequisite must name an EARLIER item (1-based in the file).
function itemFault(x, index) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'is not an object';
  if (!oneLine(x.title, LIMITS.title)) return 'needs a one-line title';
  if (!oneLine(x.scope, LIMITS.scope)) return 'needs a one-line scope';
  if (!Array.isArray(x.files) || !x.files.length || x.files.length > LIMITS.files || !x.files.every(safeFile)) return 'must name the files it edits (relative paths, at most 12)';
  const a = x.acceptance;
  if (!Array.isArray(a) || !a.length || a.length > LIMITS.acceptance || !a.every(r => r && TAGS.includes(r.tag) && oneLine(r.text, LIMITS.text))) return 'needs an acceptance list whose lines are tagged "before PR" or "after install"';
  if (!a.some(r => r.tag === 'before PR')) return 'needs at least one "before PR" acceptance line';
  if (!Array.isArray(x.tests) || !x.tests.length || x.tests.length > LIMITS.tests || !x.tests.every(t => oneLine(t, LIMITS.text))) return 'must name its tests';
  const p = x.prerequisite;
  if (p !== undefined && p !== null && !(Number.isInteger(p) && p >= 1 && p <= index)) return 'names a prerequisite that is not an earlier item';
  return null;
}

// raw: the parsed file. openFiles: Map(pr number -> files of that OTHER open pull request). Returns { items } or { error }.
export function checkStuckDraft(raw, openFiles = new Map()) {
  const list = raw?.items;
  if (!Array.isArray(list) || list.length < STUCK_MIN || list.length > STUCK_MAX) return { error: `${DRAFT_FILE} needs ${STUCK_MIN} to ${STUCK_MAX} items` };
  for (const [i, x] of list.entries()) { const fault = itemFault(x, i); if (fault) return { error: `item ${i + 1} ${fault}` }; }
  for (const [i, x] of list.entries()) {
    for (const [pr, files] of openFiles) {
      const shared = x.files.find(f => files.includes(f));
      if (shared) return { error: `item ${i + 1} edits ${shared}, which open PR #${pr} also changes; an item may share no file with another open PR` };
    }
  }
  return { items: list.map(x => ({
    title: redact(x.title.trim(), LIMITS.title), scope: redact(x.scope.trim(), LIMITS.scope), files: x.files,
    acceptance: x.acceptance.map(r => ({ tag: r.tag, text: redact(r.text.trim(), LIMITS.text) })), tests: x.tests.map(t => redact(t.trim(), LIMITS.text)),
    prerequisite: x.prerequisite ?? null })) };
}

export function readStuckDraft(root, ticket, openFiles) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(root, 'team', 'inbox', String(ticket || 'none'), DRAFT_FILE), 'utf8')); } catch { return { error: `${DRAFT_FILE} is missing or not JSON` }; }
  return checkStuckDraft(raw, openFiles);
}

// The issue body of one item. The Depends on line holds a placeholder until the earlier item has its number (see itemBody's caller).
export function itemBody({ item, index, count, parent, source }) {
  const lines = [`Part ${index + 1} of ${count} of the split of parked PR #${parent}${source ? ` (source issue #${source})` : ''}, approved by the homeowner.`, '',
    `**Scope:** ${item.scope}`, '', `Files: ${item.files.join(', ')}`];
  if (item.prerequisite) lines.push('', `Depends on: ${PLACEHOLDER}`);
  lines.push('', '## Acceptance', ...item.acceptance.map(r => `- ${r.tag}: ${r.text}`), '', '## Tests', ...item.tests.map(t => `- ${t}`));
  return lines.join('\n');
}
export const withPrerequisite = (body, number) => body.replace(PLACEHOLDER, `#${number}`);

// Every body must pass the dependency parser before anything is filed. Returns a reason or null.
export function bodyFault(body) {
  const parsed = parseDependsOn(withPrerequisite(body, 1));
  return parsed.malformed ? dependencyRefusal(parsed) : null;
}

// What the homeowner can still do about a stuck PR whose split was rejected or could not be drafted.
export const STANDING_OPTIONS = 'wait for another agent to be able to review (allowance reset), change the approach, or fix it by hand';

// The body of a child at filing time: the marker, then the body. A child of a stuck PR has its own body, with the number of the earlier item it
// waits for (`after`, zero-based); a child of a too-large issue has the short text below (the form issue #244 always used).
export function splitChildBody(marker, child, split, index, parent) {
  if (!child.body) return `${marker}\nPart ${index + 1} of ${split.children.length} of #${parent}, split by Foreman after #${parent} ran out of context (accepted by the homeowner).\n\n**Scope:** ${child.scope}\n\nRead #${parent} for the full requirements; deliver only this part.`;
  const earlier = child.after == null ? null : split.children[child.after]?.issue;
  if (child.after != null && !earlier) throw new Error('the item it waits for has no issue number yet');
  return `${marker}\n${earlier ? withPrerequisite(child.body, earlier) : child.body}`;
}

export function splitAcceptedText(split) {
  const filed = split.children.map(c => `#${c.issue}`).join(', ');
  const rest = split.stuckPr ? 'The PR stays parked, with its branch kept, until all of them have merged.' : 'This issue is not started again; close it when the children are done.';
  return `**Split accepted.** Filed ${filed} and queued them for \`${split.agent}\`. ${rest}`;
}
