// Issue #1306: the closed issues updated most recently. The newest 200 by creation misses the close of an older issue,
// so the dashboard's list adds these (GitHub orders by update time, which a close moves to the close time).
export const RECENT_CLOSED_LIMIT = 200;

export function recentlyClosedIssues(json, repo, fields) {
  return json(['issue', 'list', '--repo', repo, '--state', 'closed', '--search', 'sort:updated-desc', '--limit', String(RECENT_CLOSED_LIMIT),
    '--json', fields]) || [];
}
