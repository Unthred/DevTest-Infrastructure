// Issue #1229: a decision proposal is its own file, docs/decisions/<issue>-<slug>.md, so two proposals never touch the same file.
// The sequential D number is assigned once, on approval, never by the proposing pull request. Pure functions; no I/O.
// docs/DECISIONS.md is frozen: it keeps the entries numbered before this change and is only read here to find the next number.
import { parseRegister, APPROVED } from './decisions.mjs';

export const DECISIONS_DIR = 'docs/decisions';
export const INDEX_FILE = `${DECISIONS_DIR}/INDEX.md`;
export const FILE_NAME = /^(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;
export const PROPOSAL = 'agent-proposal';
const STATUSES = new Set([APPROVED, PROPOSAL, 'temporary-note']);
const FIELDS = ['Status', 'Date', 'Source', 'Decision', 'Rationale', 'Rejected', 'Superseded-by'];

const field = (text, key) => new RegExp(`^- ${key}: (.*)$`, 'm').exec(text)?.[1].trim() ?? '';

// The name a decision is referred to by everywhere until it has a number: the file name without `.md`.
export const decisionName = file => String(file).replace(/^.*\//, '').replace(/\.md$/, '');

export function parseDecisionFile(file, text) {
  const t = String(text ?? '');
  const name = decisionName(file);
  const problems = [];
  if (!FILE_NAME.test(`${name}.md`)) problems.push(`${file}: the name must be <issue number>-<short-slug>.md (lower case letters, digits and hyphens)`);
  const title = /^# (.+)$/m.exec(t)?.[1].trim() ?? '';
  if (!title) problems.push(`${name}: needs a first-level heading "# <title>"`);
  for (const k of FIELDS) {
    const lines = t.match(new RegExp(`^- ${k}:`, 'gm')) || [];
    if (lines.length !== 1) problems.push(`${name}: needs exactly one "${k}" line (found ${lines.length})`);
  }
  const status = field(t, 'Status');
  if (status && !STATUSES.has(status)) problems.push(`${name}: invalid status "${status}"`);
  if (field(t, 'Date') && !/^\d{4}-\d{2}-\d{2}$/.test(field(t, 'Date'))) problems.push(`${name}: date must be YYYY-MM-DD`);
  const number = field(t, 'Number');
  if (number && !/^D-\d{3,}$/.test(number)) problems.push(`${name}: Number must look like D-043`);
  if (status === APPROVED && !number) problems.push(`${name}: an approved decision carries the Number Foreman assigned`);
  if (status !== APPROVED && number) problems.push(`${name}: only an approved decision has a Number (the proposing pull request assigns none)`);
  return { name, file, title, status, date: field(t, 'Date'), source: field(t, 'Source'), decision: field(t, 'Decision'), number, problems };
}

export function parseDecisionFiles(files) {
  return [...files].map(([file, text]) => parseDecisionFile(file, text)).sort((a, b) => a.name.localeCompare(b.name));
}

// The next free D number across the frozen register and every numbered file.
export function nextNumber(legacyText, parsed) {
  const used = [...parseRegister(legacyText).keys(), ...parsed.map(p => p.number)].filter(Boolean).map(id => Number(id.slice(2)));
  return `D-${String(Math.max(0, ...used) + 1).padStart(3, '0')}`;
}

// Approval is idempotent: an already approved file keeps its number and text. Otherwise it gets the next number and the approval link.
export function approveText(name, text, parsedAll, legacyText, approvalUrl) {
  const mine = parsedAll.find(p => p.name === name);
  if (!mine) throw new Error(`no decision file named ${name}`);
  if (mine.status === APPROVED && mine.number) return { text, number: mine.number, changed: false };
  if (mine.status !== PROPOSAL) throw new Error(`${name} is ${mine.status}; only an agent-proposal can be approved`);
  const number = nextNumber(legacyText, parsedAll);
  const next = text.replace(/^- Status: .*$/m, `- Status: ${APPROVED}`)
    .replace(/^- Source: (.*)$/m, (_, s) => `- Source: ${s}; approved at ${approvalUrl}`)
    .replace(/^(- Superseded-by: .*)$/m, `$1\n- Number: ${number}`);
  return { text: next, number, changed: true };
}

// The index lists only numbered decisions, so adding a proposal never changes it and two proposals cannot collide on it.
export function renderIndex(parsed) {
  const rows = parsed.filter(p => p.status === APPROVED && p.number).sort((a, b) => a.number.localeCompare(b.number));
  return ['# Decision index', '',
    'Generated from the files in this directory by `node tools/decisions.mjs index`; do not edit by hand. The entries numbered before this change stay in [`../DECISIONS.md`](../DECISIONS.md), which is frozen.', '',
    'A proposal is a file `<issue>-<slug>.md` and is referred to by that name until the homeowner approves it; Foreman then assigns the next D number once and records it in the file and below.', '',
    '| Number | Decision file | Title | Date |', '| --- | --- | --- | --- |',
    ...rows.map(p => `| ${p.number} | [${p.name}](${p.name}.md) | ${p.title.replace(/\|/g, '/')} | ${p.date} |`), ''].join('\n');
}

// Names a pull request adds as proposals (absent from main): what awaits the homeowner's sign-off.
export function fileProposalsAdded(mainFiles, headFiles) {
  const main = new Set(parseDecisionFiles(mainFiles).map(p => p.name));
  return parseDecisionFiles(headFiles).filter(p => !main.has(p.name) && p.status === PROPOSAL).map(p => ({ id: p.name, title: p.title, file: p.file }));
}

// Ids a head adds to the frozen register. A new decision is a file, so any addition there is refused.
export function addedLegacyEntries(baseText, headText) {
  const base = parseRegister(baseText);
  return [...parseRegister(headText).keys()].filter(id => !base.has(id));
}

// Violations between the decision files at base and head (maps file -> text). approvals = approvalsFrom(...).
export function decisionFileViolations(baseFiles, headFiles, approvals = new Map()) {
  const base = new Map(parseDecisionFiles(baseFiles).map(p => [p.file, p]));
  const bad = [];
  const approved = (p, needLink) => {
    const list = approvals.get(p.name) || [];
    if (!needLink) return list.length > 0;
    return list.some(a => (a.url && p.source.includes(a.url)) || (a.id && new RegExp(`issuecomment-${a.id}\\b`).test(p.source)));
  };
  const numbers = new Map();
  for (const p of parseDecisionFiles(headFiles)) {
    bad.push(...p.problems);
    if (p.number) numbers.set(p.number, [...(numbers.get(p.number) || []), p.name]);
    const b = base.get(p.file);
    if (!b) {
      if (p.status === APPROVED && !approved(p, true)) bad.push(`${p.name} is added as ${APPROVED}; add it as ${PROPOSAL} (or the Source must link the recorded approval: "homeowner-approval: ${p.name}")`);
      continue;
    }
    if (b.status === p.status && b.number === p.number) continue;
    if (p.status === APPROVED && !approved(p, true)) bad.push(`${p.name} changes status ${b.status} -> ${APPROVED} without a verifiable homeowner approval (comment "homeowner-approval: ${p.name}" by the repository owner, linked from the Source)`);
    else if (b.status === APPROVED && !approved(p, false)) bad.push(`${p.name} changes status ${APPROVED} -> ${p.status} without a verifiable homeowner instruction (comment "homeowner-approval: ${p.name}")`);
    else if (b.number && b.number !== p.number) bad.push(`${p.name}: the number ${b.number} was assigned once and never changes`);
  }
  for (const [num, names] of numbers) if (names.length > 1) bad.push(`${num} is used by ${names.join(' and ')}; a number is assigned once`);
  const head = new Set(parseDecisionFiles(headFiles).map(p => p.file));
  for (const file of base.keys()) if (!head.has(file)) bad.push(`${file} was removed; decisions are never deleted (supersede them instead)`);
  return bad;
}
