// Issue #1154: why an Inbox job failed (a fixed list) and whether a prompt was meant to change anything. Pure.
export const CAUSES = ['time_cap', 'no_change', 'no_result', 'guard_refused', 'fault', 'allowance'];
export const CAUSE_LABEL = {
  time_cap: 'time cap',
  no_change: 'changed nothing when a change was required',
  no_result: 'no result written',
  guard_refused: 'refused by a guard',
  fault: 'agent or infrastructure fault',
  allowance: 'allowance',
};

const READ_ONLY_TEXT = /(?<!\bnot\s)(?<!\bnon[- ])\bread[- ]only\b/i;
const READ_ONLY_TITLE = /^\W*(verify|verified|check|report|confirm|audit|inspect)\b/i;
const CHANGE_WORD = /\b(fix|change|set|raise|lower|edit|update|implement|add|remove|restore|install|create|write code|apply|enable|disable)\b/i;

// A prompt marked read only, or whose task is verify, report or check. A title that also asks for a change is not read only
// unless the text says "read only" outright.
export function isReadOnlyPrompt({ title = '', prompt = '' } = {}) {
  if (READ_ONLY_TEXT.test(title) || READ_ONLY_TEXT.test(prompt)) return true;
  return READ_ONLY_TITLE.test(title) && !CHANGE_WORD.test(title);
}

export const NOTHING_CHANGED_WHY = 'the agent reported that it changed nothing';
const clip = (text, max = 300) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// What the job's end means. `outcome` is robust.inboxOutcome(summary) (or { ok:false, why } when the job did not complete).
// Returns { ok, cause, evidence }: cause is null when ok.
export function judgeEnd({ job, capStopped, outcome, readOnly }) {
  if (capStopped) return { ok: false, cause: 'time_cap', evidence: clip(outcome.why) };
  if (job.status === 'completed') {
    if (outcome.ok) return { ok: true, cause: null, evidence: '' };
    if (outcome.code === 'nothing_changed') {
      return readOnly ? { ok: true, cause: null, evidence: '' } : { ok: false, cause: 'no_change', evidence: clip(outcome.why) };
    }
    if (outcome.code === 'no_summary') return { ok: false, cause: 'no_result', evidence: clip(outcome.why) };
    return { ok: false, cause: 'fault', evidence: clip(outcome.why) };
  }
  const detail = `${job.incompleteReason?.cause || ''} ${job.incompleteReason?.detail || ''} ${job.status}`;
  const evidence = clip(`${outcome.why}${job.incompleteReason?.detail ? `: ${job.incompleteReason.detail}` : ''}`);
  if (/allowance|usage.?limit|quota|paused_limit/i.test(detail)) return { ok: false, cause: 'allowance', evidence };
  if (/guard|refus|policy|forbidden/i.test(detail)) return { ok: false, cause: 'guard_refused', evidence };
  return { ok: false, cause: 'fault', evidence };
}

// The cause of an item recorded before causes existed, from its failure text and kind. Used once, to backfill.
export function legacyCause(status) {
  const text = `${status.reason || ''} ${status.result || ''}`;
  if (/inbox time cap/i.test(text)) return 'time_cap';
  if (new RegExp(NOTHING_CHANGED_WHY, 'i').test(text)) return 'no_change';
  if (/left no summary/i.test(text)) return 'no_result';
  if (status.kind && status.kind !== 'prompt') return 'guard_refused';
  if (/allowance|usage limit/i.test(text)) return 'allowance';
  return 'fault';
}
