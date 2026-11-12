// Readers of merged and closed pull requests for githubClient. listMergedSince is issue #1155: every PR merged on or after a date, read by a
// date search, because the newest 100 merged PRs reach back only days at this repository's merge rate.
export const mergedReaders = (json, repo) => ({
  listMergedPulls: async () => json(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '100', '--json', 'number,title,headRefName,mergedAt,mergeCommit,closingIssuesReferences']),
  listMergedSince: async sinceMs => json(['pr', 'list', '--repo', repo, '--state', 'merged', '--search', `merged:>=${new Date(sinceMs).toISOString().slice(0, 10)}`, '--limit', '500', '--json', 'number,title,mergedAt']),
  listClosedPulls: async () => json(['pr', 'list', '--repo', repo, '--state', 'closed', '--limit', '100', '--json', 'number,headRefName,mergedAt']),   // closed, not merged (issue #521)
});
