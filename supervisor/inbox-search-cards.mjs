import { allStatuses, pendingCards } from './inbox.mjs';
import { redactLong } from './redact.mjs';
import { referenceText } from '../foreman-mcp/inbox-reference.mjs';

const storedCard = status => ({
  id: status.id,
  number: status.number ?? null,
  reference: referenceText(status.number, status.issue),
  kind: status.kind ?? 'unknown',
  state: status.state ?? 'unknown',
  createdAt: status.createdAt ?? null,
  title: status.title || 'An inbox item that cannot be shown',
  reason: redactLong(String(status.reason ?? status.result ?? ''), 400, ' [cut]'),
  issue: status.issue ?? null,
  pr: status.pr ?? null,
  text: status.result ?? status.reason ?? '',
});

export function searchableInboxCards(dir) {
  const pending = new Map(pendingCards(dir).map(card => [card.id, card]));
  return allStatuses(dir).map(status => pending.get(status.id) || storedCard(status))
    .sort((left, right) => (right.createdAt || 0) - (left.createdAt || 0));
}
