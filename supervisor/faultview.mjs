// Dashboard pieces for items that wait on something outside the work itself (issues #995 and #1107). Pure.
import { redact } from './redact.mjs';

const CAP_TAIL = 'Foreman starts no more until the head changes or you decide.';
// Needs you items: a job type stopped by the retry cap (work outcomes only), and one per parked agent whose fault lasted 30 minutes.
export function stoppedAttention(team) {
  const caps = (team.retryCapItems?.() || []).map(it => ({
    id: it.id,
    text: redact(`${it.type} on #${it.subject} stopped after ${it.attempts} attempts with the same cause (${it.cause}); ${CAP_TAIL}`, 400),
    ref: { kind: ['implement', 'continue'].includes(it.type) ? 'issue' : 'pull', n: Number(it.subject) },
    since: it.since,
    severity: 'action',
    action: 'Fix the cause, then approve the clear_retry_cap action for this pull request in the inbox (or reopen the item by hand)',
  }));
  const parked = (team.faults?.items?.() || []).map(it => ({
    id: it.id, text: redact(it.text, 500), ref: null, since: it.since, severity: 'action', action: redact(it.action, 300),
  }));
  return [...caps, ...parked];
}

export const rearmView = (rearm, up) => (rearm ? { at: rearm.at, scopes: rearm.scopes, items: [...(rearm.items || []), ...(up?.items || [])] } : null);
