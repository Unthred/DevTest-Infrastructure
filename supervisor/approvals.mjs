// The list of items waiting for the homeowner (issue #1101). One function, pendingApprovals(): the Now tab dropdown reads its result from the view
// (withApprovals); the Queue table and the overseer MCP can call it later. It reuses the inbox's own pending cards, so it cannot disagree with the
// Inbox about what is pending, and adds the decisions Needs you holds for him. It lists nothing else from Needs you.
import { pendingCards } from './inbox.mjs';
import { isStrongAction } from './strongtier.mjs';

// Words for the homeowner. The raw kind names are internal.
export const KIND_LABEL = { prompt: 'Prompt', issue_draft: 'Issue draft', action: 'Action', host_value: 'Configuration value' };
// Strong tier: approvals that carry a typed pull request number confirmation. Issue #1158: an inbox `action` card is strong when its action NAME is
// (merge_pr, approve_decision, verdict_pass, verdict_changes); STRONG_KINDS stays as the guard for any kind added later. Never Approve all.
export const STRONG_KINDS = new Set(['merge', 'approve', 'verdict']);
export const tierOf = (kind, action = null) => (STRONG_KINDS.has(kind) || isStrongAction(action) ? 'strong' : 'click');
// Needs you items that are a choice between options (fix limit, split, retry cap, decision register entries). They get no Approve button here:
// the choice is made on the pull request or issue, so the row shows the options and links to it.
export const DECISION_ID = /^(decision-proposal-|decision-|fixlimit-|split-|retrycap-)/;

// Job ids and hashes are internal; none is shown to the homeowner.
const plain = text => String(text ?? '').replace(/\b[0-9a-f]{8,}\b/g, '').replace(/\s+([.,;:])/g, '$1').replace(/\s{2,}/g, ' ').trim();
// An action's "will" text ends with its target (a job id); the sentence before it says what approving does.
const whatApprovingDoes = will => plain(String(will ?? '').replace(/\s*Target:.*$/s, ''));

// Pure: inbox cards -> rows. A card that cannot be shown (broken) is still a row so the count matches the Inbox; it can only be rejected.
export function toApprovalRows(cards) {
  return cards.map(c => ({
    id: c.id,
    kind: c.kind,
    kindLabel: KIND_LABEL[c.kind] || 'Proposal',
    tier: tierOf(c.kind, c.action),
    canApprove: !c.broken,
    title: c.broken ? 'An item that cannot be shown' : c.title,
    why: c.broken ? `It cannot be approved: ${c.broken}` : (plain(c.why) || whatApprovingDoes(c.will) || null),
    since: c.createdAt ?? null,
  }));
}

// Pure: Needs you items -> decision rows, with the options the homeowner chooses between.
export function toDecisionRows(items) {
  return items.filter(a => [a.id, ...(a.causes || []).map(c => c.id)].some(id => DECISION_ID.test(id || ''))).map(a => ({
    id: a.id,
    kind: 'decision',
    kindLabel: 'Decision',
    tier: 'decision',
    canApprove: false,
    title: plain(a.text),
    why: a.card?.reason ?? (plain(a.tried || a.text) || null),
    card: a.card ?? null,
    options: plain(a.decision || a.action) || null,
    link: (a.links || [])[0]?.url ?? null,
    since: Number.isFinite(a.since) ? a.since : null,
  }));
}

// The one list: inbox proposals (Click tier unless the kind is Strong) and the decisions waiting on the homeowner, oldest first.
export function pendingApprovals({ inboxDir = null, needsYou = [] } = {}) {
  const cards = inboxDir ? pendingCards(inboxDir) : [];
  const rows = [...toApprovalRows(cards), ...toDecisionRows(needsYou.filter(a => !a.inbox))];
  return rows.sort((a, b) => (a.since ?? Infinity) - (b.since ?? Infinity));
}

// What Approve all may decide: Click tier and approvable. Strong tier items keep their own confirmation; decisions have no Approve button.
export const approveAllIds = rows => rows.filter(r => r.tier === 'click' && r.canApprove).map(r => r.id);

// Puts the list on a built view, where the page's dropdown reads it.
export function withApprovals(view, config) {
  if (!view?.panels) return view;   // a degraded view has no panels to list from
  view.panels.approvals = pendingApprovals({ inboxDir: config?.inbox?.dir ?? null, needsYou: view.panels.needsYou || [] });
  return view;
}
