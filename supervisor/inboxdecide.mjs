// Issue #1154: every decision the dashboard's /inbox route accepts, in one place: approve, reject, undo (the homeowner's choice on a pending
// item) and the resolutions of a failed item or a changed setting (each with a note).
import * as inboxStore from './inbox.mjs';
import { resolveByHomeowner, HOMEOWNER_RESOLUTIONS } from './inboxresolve.mjs';

export const isInboxDecision = decision => ['approve', 'reject', 'undo'].includes(decision) || Object.hasOwn(HOMEOWNER_RESOLUTIONS, decision);

export function applyInboxDecision(dir, id, decision, note, now) {
  if (Object.hasOwn(HOMEOWNER_RESOLUTIONS, decision)) return resolveByHomeowner(inboxStore, dir, id, { decision, note }, now);
  return decision === 'undo' ? inboxStore.undo(dir, id, now) : inboxStore.decide(dir, id, decision, now);
}
