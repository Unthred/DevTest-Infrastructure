// Issue #1306: work_item.close_reason, the homeowner records why issues were closed as not planned or duplicate.
// For each issue it posts one comment (the marker, then the reason) and writes the record entry. Every issue is checked first, so a refusal
// changes nothing. Reopening is a later item. The issue list comes as the string `issues`, numbers separated by commas or spaces,
// because the command inputs are strings, whole numbers or booleans.
import { MARKER, MIN_REASON, validReason, COUNTED_REASONS } from '../../closedreason.mjs';
import { readRecord, addReason } from '../../closedreason-store.mjs';

export const MAX_ISSUES = 250;
const MAX_NUMBER = 999999999;

const refusal = (code, text) => ({ refusal_code: code, refusal_text: text });
const dropped = issue => COUNTED_REASONS.includes(String(issue?.stateReason ?? '').toUpperCase().replace(/[\s-]/g, '_'));

// Pure: "895, 896 897" to [895, 896, 897]; null when any part is not a whole number in range, or none is given. Repeats are dropped.
export function parseIssues(text) {
  const parts = String(text ?? '').split(/[\s,]+/).filter(Boolean);
  if (!parts.length || !parts.every(p => /^\d{1,9}$/.test(p))) return null;
  const numbers = [...new Set(parts.map(Number))];
  return numbers.every(n => n >= 1 && n <= MAX_NUMBER) ? numbers : null;
}

// The first refusal for these issues, or null. Reads each issue through the client; `record` is the record of reasons.
async function checkAll(numbers, github, record) {
  for (const number of numbers) {
    if (Object.hasOwn(record.reasons, String(number))) {
      return refusal('already_recorded', `Issue ${number} already has a recorded reason. Nothing was changed.`);
    }
    let issue;
    try { issue = await github.getIssue(number); } catch {
      return refusal('github_failed', `Issue ${number} could not be read from GitHub. Nothing was changed.`);
    }
    if (!issue) return refusal('not_found', `Issue ${number} was not found. Nothing was changed.`);
    if (String(issue.state).toUpperCase() !== 'CLOSED') {
      return refusal('issue_open', `Issue ${number} is open, so there is no close to explain. Nothing was changed.`);
    }
    if (!dropped(issue)) return refusal('not_dropped', `Issue ${number} was not closed as not planned or duplicate. Nothing was changed.`);
  }
  return null;
}

async function postOne(number, reason, context) {
  // A comment that is already there (the record write failed after it) is not posted twice.
  const there = typeof context.github.hasComment === 'function' ? await context.github.hasComment(number, MARKER) : false;
  if (!there) await context.github.comment(number, `${MARKER}\n${reason}`);
  const written = addReason(context.root, number, { reason, at: context.now, call: context.call ?? null });
  if (!written.ok) throw new Error(written.why);
}

async function run(input, context) {
  const numbers = parseIssues(input.issues);
  if (!numbers) return refusal('bad_issues', 'issues must be one or more issue numbers separated by commas or spaces.');
  if (numbers.length > MAX_ISSUES) return refusal('too_many', `At most ${MAX_ISSUES} issues at a time; ${numbers.length} were given.`);
  const reason = String(context.reason ?? '').trim();
  if (!validReason(reason)) return refusal('reason_too_short', `The reason needs at least ${MIN_REASON} characters. Nothing was changed.`);
  const github = typeof context.github === 'function' ? context.github() : context.github;
  if (!github) return refusal('github_not_configured', 'Foreman has no GitHub access here, so it cannot comment on the issues.');
  const read = readRecord(context.root);
  if (read.error) return refusal('record_unreadable', `${read.error}. Nothing was changed.`);
  const checked = await checkAll(numbers, github, read.record);
  if (checked) return checked;
  const done = [];
  for (const number of numbers) {
    try { await postOne(number, reason, { ...context, github }); } catch {
      const left = numbers.filter(n => !done.includes(n));
      return refusal('partly_recorded', `Recorded ${done.length} of ${numbers.length}; issue ${number} failed, so ${left.join(', ')} still need a reason.`);
    }
    done.push(number);
  }
  const target = { kind: 'issue', key: numbers.join(','), label: `Issues ${numbers.join(', ')}`, title: null, source: null, project: null, url: null };
  const after = { state: 'recorded', attention: 'none', reason_code: null, reason_text: null, since: null };
  return { outcome: 'applied', target, before: null, after, undo: null, models: ['overview', 'appbar'] };
}

export const commands = [{
  name: 'work_item.close_reason',
  tier: 'direct',
  reason_required: true,
  reversible: false,
  undo_command: null,
  inputs: [{ name: 'issues', type: 'string', required: true }],
  refusals: ['bad_issues', 'too_many', 'reason_too_short', 'github_not_configured', 'record_unreadable', 'already_recorded', 'github_failed',
    'not_found', 'issue_open', 'not_dropped', 'partly_recorded'],
  run,
}];
