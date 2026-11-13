// Issue #1306: which closed issues were dropped without a reason recorded in Foreman, and the one Needs you item that says so.
// Pure: nothing here reads a file, the clock or the network. The record file is read and written by closedreason-store.mjs.
// An issue counts when it is closed, its close reason is not planned or duplicate, it closed after the start time, and the record holds no reason for it.

export const COUNTED_REASONS = Object.freeze(['NOT_PLANNED', 'DUPLICATE']);
export const MIN_REASON = 10;
export const MARKER = '<!-- devtest-close-reason v1 -->';
// The issue list holds every open issue plus the newest 200 of any state (supervisor/github.mjs listIssues).
export const WINDOW = 200;
export const ITEM_ID = 'closed-noreason';

const reasonOf = issue => String(issue?.stateReason ?? '').toUpperCase().replace(/[\s-]/g, '_');
const closedAtOf = issue => (typeof issue?.closedAt === 'string' ? Date.parse(issue.closedAt) : NaN);
const isClosed = issue => String(issue?.state ?? '').toUpperCase() === 'CLOSED';

// True for a closed issue whose close reason is one that drops the work, whatever its close time.
export const isDroppedClose = issue => isClosed(issue) && COUNTED_REASONS.includes(reasonOf(issue));

// The record holds a reason for this number: { reasons: { "895": { reason, at, call } } }.
export const hasReason = (record, number) => Object.hasOwn(record?.reasons ?? {}, String(number));

// Closed issues with no recorded reason, oldest close first. A missing or unreadable close time never counts (it cannot be after the start).
export function closedWithoutReason({ issues, record, startedAt }) {
  if (!Number.isFinite(startedAt)) return [];
  return (Array.isArray(issues) ? issues : [])
    .filter(issue => Number.isSafeInteger(issue?.number) && isDroppedClose(issue) && closedAtOf(issue) > startedAt && !hasReason(record, issue.number))
    .map(issue => ({ number: issue.number, title: String(issue.title ?? ''), closedAt: closedAtOf(issue), reason: reasonOf(issue) }))
    .sort((a, b) => a.closedAt - b.closedAt || a.number - b.number);
}

// The window can show every closed issue it holds as counted: then a larger sweep may be cut off at its edge, so the count is a floor.
export function windowFull({ issues, counted }) {
  const closed = (Array.isArray(issues) ? issues : []).filter(isClosed).length;
  return counted > 0 && counted >= closed;
}

const kindOf = reason => (reason === 'DUPLICATE' ? 'duplicate' : 'not planned');
const line = c => `#${c.number} ${c.title} (${kindOf(c.reason)})`;

// The one Needs you item for all counted issues, or null when none count.
export function closedReasonItem({ issues, record, startedAt }) {
  const counted = closedWithoutReason({ issues, record, startedAt });
  if (!counted.length) return null;
  const atLeast = windowFull({ issues, counted: counted.length });
  const head = `${atLeast ? 'At least ' : ''}${counted.length} closed issue${counted.length === 1 ? ' was' : 's were'} dropped with no reason recorded: `;
  const limit = atLeast
    ? ` Foreman sees every open issue and the newest ${WINDOW} of any state, so a sweep that closed more issues between two refreshes is shown only in part.`
    : '';
  return {
    id: ITEM_ID,
    text: `${head}${counted.map(line).join('; ')}.${limit}`,
    ref: null,
    severity: 'action',
    since: counted[0].closedAt,
    issues: counted.map(c => c.number),
    action: 'Write why they were dropped and press Record reason. It is posted as a comment on each listed issue.',
  };
}

// A reason of at least MIN_REASON characters once trimmed.
export const validReason = text => typeof text === 'string' && text.trim().length >= MIN_REASON;
