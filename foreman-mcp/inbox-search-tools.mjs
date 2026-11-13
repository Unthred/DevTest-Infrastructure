import { inboxSearchRecords } from './inbox-search-records.mjs';

export function inboxSearchTool(inbox, source) {
  return async (args = {}) => {
    const cap = Number.isInteger(args.limit) ? args.limit : 50;
    const filters = { search: args.search || '', kind: args.kind || '', state: args.state || '' };
    const inboxFilters = filters.kind === 'decision' ? { ...filters, kind: '' } : filters;
    const inboxItems = inbox.list({ ...inboxFilters, limit: 100 }).items;
    const sourceView = await source.get();
    const items = inboxSearchRecords({ inbox: inboxItems, approvals: sourceView.view?.panels?.approvals || [] }, filters)
      .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
    return {
      search: filters.search,
      kind: filters.kind || null,
      state: filters.state || null,
      count: items.length,
      shown: Math.min(items.length, cap),
      items: items.slice(0, cap),
    };
  };
}
