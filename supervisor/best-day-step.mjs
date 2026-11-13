// Issue #1325: the tick's step for the best 24 hours. It reads the retained timeline and hands it to the store, which does nothing unless a
// verdict or a merge is new. GitHub is read for new comments (the whole history for a build from nothing): pages of the repository's issue comments, read with the same gh runner.
import { ghRunner } from './github.mjs';
import { readTimeline } from './history.mjs';
import { refreshBestDay, PAGE_SIZE } from './best-day-store.mjs';

export function githubCommentPages(repository, gh = ghRunner()) {
  return (page, since) => JSON.parse(gh(['api', '--method', 'GET', `repos/${repository}/issues/comments`, '-f', `per_page=${PAGE_SIZE}`, '-f', `page=${page}`, ...(since ? ['-f', `since=${since}`] : [])]) || '[]');
}

export function bestDayStep(root, { repository, now = Date.now(), fetchPage = githubCommentPages(repository) } = {}) {
  return refreshBestDay({ root, now, timeline: readTimeline(root), fetchPage });
}
