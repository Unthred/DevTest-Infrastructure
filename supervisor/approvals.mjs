// The list of items waiting for the homeowner (issue #1101). One function, pendingApprovals(): the Now tab dropdown reads its result from the view
// (withApprovals); the Queue table and the overseer MCP can call it later. It reuses the inbox's own pending cards, so it cannot disagree with the
// Inbox about what is pending, and adds the decisions Needs you holds for him. It lists nothing else from Needs you.
import { pendingCards } from './inbox.mjs';
import { controlsForDecision } from '../foreman-mcp/actions.mjs';

// Words for the homeowner. The raw kind names are internal.
export const KIND_LABEL = { prompt: 'Prompt', issue_draft: 'Issue draft', action: 'Action', host_value: 'Configuration value' };
export const tierOf = kind => (['merge', 'approve', 'verdict'].includes(kind) ? 'strong' : 'click');

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
    tier: tierOf(c.kind),
    canApprove: !c.broken,
    title: c.broken ? 'An item that cannot be shown' : c.title,
    why: c.broken ? `It cannot be approved: ${c.broken}` : (plain(c.why) || whatApprovingDoes(c.will) || null),
    since: c.createdAt ?? null,
  }));
}

// Pure: Needs you items -> decision rows, with the options the homeowner chooses between.
export function toDecisionRows(items) {
  return items.map(a => {
    const mapped = controlsForDecision(a);
    return {
      id: a.id,
      kind: 'decision',
      kindLabel: 'Decision',
      tier: 'decision',
      canApprove: !mapped.error,
      title: plain(a.text),
      why: plain(a.tried || a.text) || null,
      options: plain(a.decision || a.action) || null,
      link: (a.links || [])[0]?.url ?? null,
      since: Number.isFinite(a.since) ? a.since : null,
      controls: mapped.controls,
      error: mapped.error,
    };
  });
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
  for (const item of view.panels.needsYou || []) {
    const mapped = controlsForDecision(item);
    item.decisionControls = mapped;
  }
  view.panels.approvals = pendingApprovals({ inboxDir: config?.inbox?.dir ?? null, needsYou: view.panels.needsYou || [] });
  return view;
}
