import { matchesInboxSearch } from './inbox-search.mjs';

const decisionRecord = row => ({
  id: row.id,
  kind: 'decision',
  state: 'pending',
  title: row.title,
  why: row.why,
  body: row.options,
  links: row.link ? [row.link] : [],
  card: row.card,
  decision: true,
});

export function inboxSearchRecords({ inbox = [], approvals = [] }, { search = '', kind = '', state = '' } = {}) {
  const decisions = approvals.filter(row => row.tier === 'decision').map(decisionRecord);
  return [...inbox, ...decisions].filter(record => (!kind || record.kind === kind)
    && (!state || record.state === state)
    && (record.state !== 'refused' || state === 'refused')
    && matchesInboxSearch(record, search));
}
