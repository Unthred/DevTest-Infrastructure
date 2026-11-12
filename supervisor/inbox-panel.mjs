import { failedCards, pendingCards, refusedGroups } from './inbox.mjs';
import { searchableInboxCards } from './inbox-search-cards.mjs';

const failedAttention = card => ({
  id: `inboxfail-${card.id}`,
  inboxId: card.id,
  inboxKind: card.kind,
  text: `An overseer ${card.kind === 'prompt' ? 'job' : card.kind === 'action' ? 'action' : 'item'} failed${card.job ? ` (job ${card.job})` : ''}: ${card.why}`,
  ref: null,
  severity: 'action',
  action: card.job
    ? `Look at it with ai-supervisor status ${card.job}; the overseer can read the outcome and propose it again.`
    : 'The overseer can read the outcome and propose it again. It leaves this list three days after it failed.',
});

export function inboxView(config, attention, now) {
  const dir = config.inbox?.dir;
  if (!dir) return [];
  const cards = pendingCards(dir);
  if (cards.length) {
    const plural = cards.length === 1 ? '' : 's';
    attention.push({
      id: 'inbox-waiting',
      text: `${cards.length} overseer proposal${plural} waiting`,
      ref: null,
      severity: 'action',
      action: 'Open Inbox to inspect, search, approve or reject the proposals.',
      links: [{ url: '/inbox', text: 'Open Inbox' }],
    });
  }
  failedCards(dir, now).forEach(card => attention.push(failedAttention(card)));
  refusedGroups(dir, now).forEach((group, index) => {
    const plural = group.count === 1 ? ' was' : 's were';
    attention.push({
      id: `inboxrefused-${index}`,
      text: `${group.count} overseer proposal${plural} refused: ${group.reason}`,
      ref: null,
      severity: 'action',
      action: 'The overseer can read the reason with foreman_proposal_status and propose again. It leaves this list three days after the latest refusal.',
    });
  });
  return cards;
}

export const inboxSearchView = config => {
  return config.inbox?.dir ? searchableInboxCards(config.inbox.dir) : [];
};
