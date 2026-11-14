// Issue #1197: foreman_inbox, a compact newest-first list of every Inbox card (the dashboard's Inbox plus its decision cards). It reuses the
// records foreman_inbox_items reads (inbox.list and the decision records), so the two tools cannot disagree about which cards exist.
// Pure apart from reading: it writes nothing.
import { inboxSearchRecords } from './inbox-search-records.mjs';
import { submittedItems } from './inbox-submitted.mjs';

export const CARD_STATES = ['submitted', 'pending', 'approved', 'running', 'done', 'failed', 'refused', 'rejected'];
const DEFAULT_LIMIT = 20;

// Only foreman_propose writes item files, so a card from the inbox directory came from the overseer; decision cards and
// host values are raised by Foreman itself. The dashboard approval click is a decision about a card, not a source of cards.
const proposer = record => (record.decision || record.kind === 'host_value' ? 'system' : 'overseer');
const firstLine = text => String(text ?? '').split(/\r?\n/).find(line => line.trim())?.trim() ?? null;
const minutes = (createdAt, now) => {
  const then = Date.parse(createdAt || '');
  return Number.isFinite(then) ? Math.max(0, Math.floor((now - then) / 60000)) : null;
};

export function inboxCard(record, now) {
  return {
    id: record.shortId || String(record.id).slice(0, 8),
    number: record.number ?? null,
    reference: record.reference ?? null,
    kind: record.kind,
    title: record.title ?? null,
    state: record.state,
    ageMinutes: minutes(record.createdAt, now),
    proposedBy: proposer(record),
    firstLine: record.kind === 'prompt' ? firstLine(record.prompt) : null,
  };
}

export function inboxCardsTool(inbox, source, now) {
  return async (args = {}) => {
    const state = args.state || '';
    if (state && !CARD_STATES.includes(state)) throw new Error(`state must be one of: ${CARD_STATES.join(', ')}`);
    const limit = args.limit === undefined ? DEFAULT_LIMIT : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be a whole number from 1 to 100');
    const stored = inbox.list({ limit: 100, state: state === 'submitted' ? '' : state }).items;   // 100 is the list maximum
    const approvals = (await source.get()).view?.panels?.approvals || [];
    const records = [...inboxSearchRecords({ inbox: stored, approvals }, { state: state === 'submitted' ? '' : state }), ...submittedItems(inbox.dir)]
      .filter(record => !state || record.state === state);
    const cards = records
      .sort((left, right) => (Date.parse(right.createdAt || '') || 0) - (Date.parse(left.createdAt || '') || 0))   // cards with no time (decisions) last
      .map(record => inboxCard(record, now()));
    return { state: state || null, count: cards.length, shown: Math.min(cards.length, limit), cards: cards.slice(0, limit) };
  };
}
