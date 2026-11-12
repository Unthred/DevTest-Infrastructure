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

// Every Inbox item plus the decisions Needs you holds, unfiltered (the dashboard's quick filters count from this).
export function inboxAllRecords({ inbox = [], approvals = [] }) {
  return [...inbox, ...approvals.filter(row => row.tier === 'decision').map(decisionRecord)];
}

export function inboxSearchRecords(data, { search = '', kind = '', state = '' } = {}) {
  return inboxAllRecords(data).filter(record => (!kind || record.kind === kind)
    && (!state || record.state === state)
    && (record.state !== 'refused' || state === 'refused')
    && matchesInboxSearch(record, search));
}
