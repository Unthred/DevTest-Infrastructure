// Issue #1255: the codes for the reasons the Inbox store writes beside a refused or failed item. The store keeps only a sentence; a client
// that wants to group or style refusals needs a stable word, so one table maps each sentence the store writes today to a code.
// The sentence is always kept by the caller as reason_text. A sentence that matches no row is `other`.

// Each row is tested in order against the stored sentence. Kept next to the store's own wording (supervisor/inbox.mjs, inboxoutcome.mjs).
export const REASON_TABLE = [
  ['pending_cap', /items? (is|are) already waiting for approval/i],
  ['masked_text', /would mask/i],
  ['secret_shaped', /secret-shaped/i],
  ['attribution_text', /AI attribution/i],
  ['malformed_prerequisite_line', /Depends on/i],
  ['too_long', /is longer than \d+ characters|file larger than/i],
  ['unknown_kind', /^unknown kind/i],
  ['item_changed', /changed after it was picked up/i],
  ['inbox_job_stopped', /^stopped after the \d+-minute inbox time cap|^the job ended /i],
];

export const REASON_CODES = [...REASON_TABLE.map(([code]) => code), 'action_failed', 'other'];

const ACTION_KINDS = new Set(['action', 'control']);

// An action that raised an error carries the error's own message, which no fixed row can match, so a failed action or control item with
// no other match is action_failed.
export function reasonCodeOf(reason, { state, kind } = {}) {
  const text = String(reason ?? '');
  const row = REASON_TABLE.find(([, pattern]) => pattern.test(text));
  if (row) return row[0];
  return state === 'failed' && ACTION_KINDS.has(kind) ? 'action_failed' : 'other';
}
