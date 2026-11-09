// The list of items waiting for the homeowner's click (issue #1101). One function, no I/O beyond reading the inbox: the Now tab dropdown uses it
// now; the Queue table and the overseer MCP can call it later. It reuses the inbox's own pending cards, so it cannot disagree with the Inbox about
// what is pending, and it lists nothing that needs no click (the rest of Needs you).
import { pendingCards } from './inbox.mjs';

// Words for the homeowner. The raw kind names are internal.
export const KIND_LABEL = { prompt: 'Prompt', issue_draft: 'Issue draft', action: 'Action', host_value: 'Configuration value' };
// Strong tier: approvals that carry a typed pull request number confirmation. None is an inbox kind today; the set is the guard, so an item of
// one of these kinds can never reach Approve all if the list later includes it.
export const STRONG_KINDS = new Set(['merge', 'approve', 'verdict']);
export const tierOf = kind => (STRONG_KINDS.has(kind) ? 'strong' : 'click');

// Pure: cards -> rows, oldest first. A card that cannot be shown (broken) is still a row so the count matches the Inbox; it can only be rejected.
export function toApprovalRows(cards) {
  return cards.map(c => ({
    id: c.id, kind: c.kind, kindLabel: KIND_LABEL[c.kind] || 'Proposal', tier: tierOf(c.kind), canApprove: !c.broken,
    title: c.broken ? 'An item that cannot be shown' : c.title, why: c.broken ? `It cannot be approved: ${c.broken}` : (c.why || c.will || null), since: c.createdAt ?? null,
  })).sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
}
export const pendingApprovals = inboxDir => toApprovalRows(pendingCards(inboxDir));

// What Approve all may decide: Click tier and approvable. Strong tier items keep their own confirmation.
export const approveAllIds = rows => rows.filter(r => r.tier === 'click' && r.canApprove).map(r => r.id);

// The same rows from a built view: the inbox cards already inside Needs you (the dashboard reads the inbox once per pass), so the dropdown and
// the Needs you list cannot disagree.
export const approvalsOfView = view => toApprovalRows((view?.panels?.needsYou || []).filter(a => a.inbox).map(a => a.inbox));
